'use strict';

/**
 * P1-e · partial-survival unit tests.
 *
 * These cover `rescuePartialGeneration` directly because it's the only new
 * decision surface introduced by P1-e. The in-tryGenerator integration path
 * (error classified as TIME_BUDGET_EXCEEDED → rescue → run validation) is
 * exercised end-to-end by P1-g.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { rescuePartialGeneration } = require('../src/pipeline-worker');

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-partial-'));
  const testsDir = path.join(root, 'tests', 'generated');
  fs.mkdirSync(testsDir, { recursive: true });
  return { root, testsDir };
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
}

function writeSpec(testsDir, name, body = "import { test } from '@playwright/test';\ntest('x', async () => {});") {
  fs.writeFileSync(path.join(testsDir, name), body);
}

function budgetError() {
  const e = new Error("Stage 'generation' exceeded budget (60000ms)");
  e.code = 'TIME_BUDGET_EXCEEDED';
  return e;
}

test('rescuePartialGeneration returns null when testsDir is empty', () => {
  const { root } = mkProject();
  try {
    const result = rescuePartialGeneration({
      projectPath: root,
      generatorName: 'saas',
      error: budgetError(),
      startedAt: Date.now() - 1000,
      summarizedReason: 'budget',
    });
    assert.equal(result, null);
  } finally {
    cleanup(root);
  }
});

test('rescuePartialGeneration returns null when the testsDir does not exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-partial-no-dir-'));
  try {
    const result = rescuePartialGeneration({
      projectPath: root,
      generatorName: 'saas',
      error: budgetError(),
      startedAt: Date.now() - 1000,
      summarizedReason: 'budget',
    });
    assert.equal(result, null);
  } finally {
    cleanup(root);
  }
});

test('rescuePartialGeneration collects .spec.ts and .spec.js files only', () => {
  const { root, testsDir } = mkProject();
  try {
    writeSpec(testsDir, 'smoke-0.spec.ts');
    writeSpec(testsDir, 'smoke-1.spec.js');
    writeSpec(testsDir, 'frontend-0.spec.ts');
    // non-test files should be ignored
    fs.writeFileSync(path.join(testsDir, 'helper.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(testsDir, 'README.md'), '# docs');

    const result = rescuePartialGeneration({
      projectPath: root,
      generatorName: 'saas',
      error: budgetError(),
      startedAt: Date.now() - 1000,
      summarizedReason: 'budget',
    });

    assert.ok(result);
    assert.equal(result.generated, 3);
    assert.equal(result.partial, true);
    assert.equal(result.provider, 'saas');
    const filenames = result.files.map((f) => f.filename).sort();
    assert.deepEqual(filenames, ['frontend-0.spec.ts', 'smoke-0.spec.ts', 'smoke-1.spec.js']);
    for (const f of result.files) {
      assert.equal(f.type, 'generated');
      assert.ok(path.isAbsolute(f.path));
    }
  } finally {
    cleanup(root);
  }
});

test('rescuePartialGeneration handles nested subdirs (only flat .spec files count)', () => {
  const { root, testsDir } = mkProject();
  try {
    writeSpec(testsDir, 'top.spec.ts');
    fs.mkdirSync(path.join(testsDir, 'nested'), { recursive: true });
    writeSpec(path.join(testsDir, 'nested'), 'inside.spec.ts');

    const result = rescuePartialGeneration({
      projectPath: root,
      generatorName: 'saas',
      error: budgetError(),
      startedAt: Date.now() - 1000,
      summarizedReason: 'budget',
    });

    // withDirent nested entries are excluded via e.isFile() === false on the dir
    // itself; readdirSync does not recurse. So only `top.spec.ts` counts.
    assert.ok(result);
    assert.equal(result.generated, 1);
    assert.equal(result.files[0].filename, 'top.spec.ts');
  } finally {
    cleanup(root);
  }
});

test('rescuePartialGeneration tolerates a permission error on readdir (returns null)', () => {
  // On macOS / Linux, we simulate the error by pointing at a file instead of a dir.
  const { root } = mkProject();
  try {
    const fakeTestsDir = path.join(root, 'tests', 'generated');
    // Replace the dir with a file at the SAME path
    fs.rmSync(fakeTestsDir, { recursive: true, force: true });
    fs.writeFileSync(fakeTestsDir, 'not a directory');

    const result = rescuePartialGeneration({
      projectPath: root,
      generatorName: 'saas',
      error: budgetError(),
      startedAt: Date.now() - 1000,
      summarizedReason: 'budget',
    });
    // readdirSync on a file throws ENOTDIR → rescue swallows and returns null
    assert.equal(result, null);
  } finally {
    cleanup(root);
  }
});
