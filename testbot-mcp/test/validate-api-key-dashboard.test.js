'use strict';

/**
 * Regression: when HEALIX_DASHBOARD_URL is unset, the MCP used to silently
 * return from validateApiKey and let webapp-client default to
 * http://localhost:3000 — which is almost never a real Healix webapp (it's
 * usually the user's own dev server, or nothing). Every subsequent fetch then
 * failed late with WEBAPP_UNREACHABLE, with no actionable error for the user.
 *
 * The fix probes the default up-front and throws WEBAPP_UNREACHABLE with a
 * pointer at the MCP config instead of silently falling through.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const TestBotMCP = require('../src/index');
const portPreflight = require('../src/port-preflight');

function withPatchedProbe(probeResult, fn) {
  const original = portPreflight.defaultProbeWebappHealth;
  portPreflight.defaultProbeWebappHealth = async () => probeResult;
  return Promise.resolve(fn()).finally(() => {
    portPreflight.defaultProbeWebappHealth = original;
  });
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === null) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

test('unset HEALIX_DASHBOARD_URL + unreachable localhost → WEBAPP_UNREACHABLE', async () => {
  const server = Object.create(TestBotMCP.prototype);
  await withEnv({ HEALIX_API_KEY: 'tb_test_key', HEALIX_DASHBOARD_URL: null }, () =>
    withPatchedProbe(false, async () => {
      await assert.rejects(
        () => server.validateApiKey(),
        (err) => {
          assert.equal(err.code, 'WEBAPP_UNREACHABLE');
          assert.match(err.message, /HEALIX_DASHBOARD_URL/);
          assert.match(err.message, /localhost:3000/);
          return true;
        },
      );
    })
  );
});

test('unset HEALIX_API_KEY short-circuits with KEY_MISSING before probing', async () => {
  const server = Object.create(TestBotMCP.prototype);
  let probeCalled = false;
  await withEnv({ HEALIX_API_KEY: null, HEALIX_DASHBOARD_URL: null }, async () => {
    const original = portPreflight.defaultProbeWebappHealth;
    portPreflight.defaultProbeWebappHealth = async () => { probeCalled = true; return false; };
    try {
      await assert.rejects(
        () => server.validateApiKey(),
        (err) => err.code === 'KEY_MISSING',
      );
      assert.equal(probeCalled, false, 'probe must not run when API key is missing');
    } finally {
      portPreflight.defaultProbeWebappHealth = original;
    }
  });
});
