'use strict';

/**
 * Unit tests for the generation-stage budget override.
 *
 * Why a dedicated test: the 15-minute default + HEALIX_GEN_BUDGET_MS env
 * alias is the knob customers with huge codebases will reach for first.
 * Silent failures here (env ignored, wrong units, precedence reversed) would
 * look indistinguishable from "our generator is slow" and sink a lot of
 * debugging time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRunBudget,
  DEFAULT_STAGE_CAPS_MS,
} = require('../src/pipeline-worker');

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === null) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('default generation budget is 15 minutes', () => {
  withEnv({ HEALIX_GEN_BUDGET_MS: null, HEALIX_STAGE_GENERATION_MS: null }, () => {
    const budget = createRunBudget({});
    assert.equal(budget.stageCaps.generation, 900000);
  });
});

test('DEFAULT_STAGE_CAPS_MS.generation is 15 minutes (module constant)', () => {
  assert.equal(DEFAULT_STAGE_CAPS_MS.generation, 900000);
});

test('HEALIX_GEN_BUDGET_MS overrides the generation cap', () => {
  withEnv({ HEALIX_GEN_BUDGET_MS: '120000', HEALIX_STAGE_GENERATION_MS: null }, () => {
    const budget = createRunBudget({});
    assert.equal(budget.stageCaps.generation, 120000);
  });
});

test('HEALIX_GEN_BUDGET_MS=0 is ignored (guard against accidental misconfig)', () => {
  withEnv({ HEALIX_GEN_BUDGET_MS: '0', HEALIX_STAGE_GENERATION_MS: null }, () => {
    const budget = createRunBudget({});
    assert.equal(budget.stageCaps.generation, 900000);
  });
});

test('HEALIX_GEN_BUDGET_MS=-1 is ignored (guard against accidental misconfig)', () => {
  withEnv({ HEALIX_GEN_BUDGET_MS: '-1', HEALIX_STAGE_GENERATION_MS: null }, () => {
    const budget = createRunBudget({});
    assert.equal(budget.stageCaps.generation, 900000);
  });
});

test('HEALIX_GEN_BUDGET_MS=garbage is ignored', () => {
  withEnv({ HEALIX_GEN_BUDGET_MS: 'not-a-number', HEALIX_STAGE_GENERATION_MS: null }, () => {
    const budget = createRunBudget({});
    assert.equal(budget.stageCaps.generation, 900000);
  });
});

test('HEALIX_GEN_BUDGET_MS wins over the generic HEALIX_STAGE_GENERATION_MS', () => {
  withEnv(
    { HEALIX_GEN_BUDGET_MS: '120000', HEALIX_STAGE_GENERATION_MS: '300000' },
    () => {
      const budget = createRunBudget({});
      assert.equal(budget.stageCaps.generation, 120000);
    }
  );
});

test('generic HEALIX_STAGE_GENERATION_MS still works when alias is unset', () => {
  withEnv(
    { HEALIX_GEN_BUDGET_MS: null, HEALIX_STAGE_GENERATION_MS: '200000' },
    () => {
      const budget = createRunBudget({});
      assert.equal(budget.stageCaps.generation, 200000);
    }
  );
});

test('other stage caps (validation, execution) are not affected by HEALIX_GEN_BUDGET_MS', () => {
  withEnv(
    { HEALIX_GEN_BUDGET_MS: '120000', HEALIX_STAGE_VALIDATION_MS: null },
    () => {
      const budget = createRunBudget({});
      assert.equal(budget.stageCaps.validation, 90000);
      // execution's default gets bumped by the adaptive-execution branch when
      // not explicitly set — this is existing behavior, not touched by P1-c.
      // We just check that HEALIX_GEN_BUDGET_MS doesn't bleed into it.
      assert.notEqual(budget.stageCaps.execution, 120000);
    }
  );
});

test('config.stageCaps.generation takes precedence over HEALIX_GEN_BUDGET_MS (explicit > env)', () => {
  withEnv({ HEALIX_GEN_BUDGET_MS: '120000' }, () => {
    const budget = createRunBudget({ stageCaps: { generation: 300000 } });
    // Note: strictAI path may adaptively raise this, so we check lower-bound
    // behavior: env override should NOT lower an explicit config value.
    assert.ok(
      budget.stageCaps.generation >= 300000,
      `expected >= 300000, got ${budget.stageCaps.generation}`,
    );
  });
});
