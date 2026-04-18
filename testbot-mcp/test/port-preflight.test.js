'use strict';

/**
 * Unit tests for the pre-flight port-conflict detector.
 *
 * Regression target: pm-app 2026-04-19 — the Healix webapp was holding
 * localhost:3000 and the target project was also configured for 3000. The
 * in-pipeline resolver fired too late (the config form had already been
 * served with port 3000), and subsequent webapp fetches failed with
 * WEBAPP_UNREACHABLE. This module now catches the collision before the
 * config UI even opens.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkDashboardPortConflict,
  describePreflight,
  parseHostPort,
  hostsEquivalent,
} = require('../src/port-preflight');

function fakeProbes({ busyPorts = [], freePortStart = null, isWebapp = false } = {}) {
  return {
    probeTcpPort: async (_host, port) => busyPorts.includes(Number(port)),
    probeWebappHealth: async () => isWebapp,
    findFreePort: async (start) => {
      const from = freePortStart ?? start;
      for (let i = 0; i < 50; i++) {
        const p = from + i;
        if (!busyPorts.includes(p)) return p;
      }
      return null;
    },
  };
}

test('parseHostPort extracts host + port with defaults', () => {
  assert.deepEqual(parseHostPort('http://localhost:3000'), { host: 'localhost', port: 3000, protocol: 'http:' });
  assert.deepEqual(parseHostPort('https://healix.example.com'), { host: 'healix.example.com', port: 443, protocol: 'https:' });
  assert.equal(parseHostPort('not-a-url'), null);
});

test('hostsEquivalent treats localhost / 127.0.0.1 / 0.0.0.0 / ::1 as the same', () => {
  assert.equal(hostsEquivalent('localhost', '127.0.0.1'), true);
  assert.equal(hostsEquivalent('0.0.0.0', '::1'), true);
  assert.equal(hostsEquivalent('localhost', 'example.com'), false);
});

test('no conflict when dashboard port differs from target port', async () => {
  const r = await checkDashboardPortConflict({
    dashboardUrl: 'http://localhost:3000',
    targetBaseUrl: 'http://localhost:5173',
    targetPort: 5173,
    ...fakeProbes(),
  });
  assert.equal(r.conflict, false);
  assert.equal(r.reason, 'ports_differ');
});

test('no conflict when dashboard is remote (different host)', async () => {
  const r = await checkDashboardPortConflict({
    dashboardUrl: 'https://healix.example.com',
    targetBaseUrl: 'http://localhost:3000',
    targetPort: 3000,
    ...fakeProbes({ busyPorts: [3000] }),
  });
  assert.equal(r.conflict, false);
  assert.equal(r.reason, 'dashboard_is_remote');
});

test('no conflict when the port is free', async () => {
  const r = await checkDashboardPortConflict({
    dashboardUrl: 'http://localhost:3000',
    targetBaseUrl: 'http://localhost:3000',
    targetPort: 3000,
    ...fakeProbes({ busyPorts: [] }),
  });
  assert.equal(r.conflict, false);
  assert.equal(r.reason, 'port_free_no_conflict');
});

test('webapp holds the target port → conflict detected, new port picked, detectedAs=healix_webapp', async () => {
  const r = await checkDashboardPortConflict({
    dashboardUrl: 'http://localhost:3000',
    targetBaseUrl: 'http://localhost:3000',
    targetPort: 3000,
    ...fakeProbes({ busyPorts: [3000], isWebapp: true }),
  });
  assert.equal(r.conflict, true);
  assert.equal(r.detectedAs, 'healix_webapp');
  assert.equal(r.originalPort, 3000);
  assert.equal(r.newPort, 3001);
  assert.equal(r.newBaseUrl, 'http://localhost:3001');
  assert.match(r.reason, /healix_webapp_holds_target_port/);
});

test('non-webapp process holds the port → conflict detected, detectedAs=other_process', async () => {
  const r = await checkDashboardPortConflict({
    dashboardUrl: 'http://localhost:3000',
    targetBaseUrl: 'http://localhost:3000',
    targetPort: 3000,
    ...fakeProbes({ busyPorts: [3000, 3001], isWebapp: false }),
  });
  assert.equal(r.conflict, true);
  assert.equal(r.detectedAs, 'other_process');
  assert.equal(r.newPort, 3002);
});

test('conflict but no free port available → conflict=true, newPort=null', async () => {
  const busy = [];
  for (let p = 3000; p <= 3050; p++) busy.push(p);
  const r = await checkDashboardPortConflict({
    dashboardUrl: 'http://localhost:3000',
    targetBaseUrl: 'http://localhost:3000',
    targetPort: 3000,
    ...fakeProbes({ busyPorts: busy, isWebapp: true }),
  });
  assert.equal(r.conflict, true);
  assert.equal(r.newPort, null);
  assert.equal(r.reason, 'no_free_port_available');
});

test('describePreflight produces a user-facing sentence pointing at the new port', () => {
  const msg = describePreflight({
    conflict: true,
    detectedAs: 'healix_webapp',
    originalPort: 3000,
    newPort: 3001,
    newBaseUrl: 'http://localhost:3001',
  });
  assert.match(msg, /Port 3000/);
  assert.match(msg, /Healix webapp itself/);
  assert.match(msg, /3001/);
});

test('describePreflight returns null when there is no conflict', () => {
  assert.equal(describePreflight({ conflict: false }), null);
  assert.equal(describePreflight(null), null);
});

test('missing dashboardUrl or targetPort → no_conflict + reason missing_…', async () => {
  const r = await checkDashboardPortConflict({
    dashboardUrl: null,
    targetBaseUrl: 'http://localhost:3000',
    targetPort: 3000,
    ...fakeProbes(),
  });
  assert.equal(r.conflict, false);
  assert.equal(r.reason, 'missing_dashboard_or_target_port');
});

test('preflight is fast — no unbounded probe loops when ports differ', async () => {
  // Regression: the old in-pipeline resolver ran this logic repeatedly on every
  // stage. The pre-flight version runs exactly once per tool invocation, and
  // should early-return the moment it sees ports differ.
  let probeCalls = 0;
  await checkDashboardPortConflict({
    dashboardUrl: 'http://localhost:3000',
    targetBaseUrl: 'http://localhost:5173',
    targetPort: 5173,
    probeTcpPort: async () => { probeCalls++; return true; },
    probeWebappHealth: async () => true,
    findFreePort: async () => 9999,
  });
  assert.equal(probeCalls, 0, 'probeTcpPort must not run when ports differ');
});
