'use strict';

/**
 * Regression tests for the __healix-fixture emitter.
 *
 * pm-app (target project `"type": "module"`) hit this at execution stage:
 *   "Playwright execution failed with exit code 1: SyntaxError: The requested
 *    module './__healix-fixture' does not provide an export named 'expect'"
 *
 * Cause: ensureCursorFixtureFiles wrote a `.js` body that used CJS
 * `module.exports = { test, expect, request }`. Node treats `.js` inside a
 * `"type":"module"` package as ESM, and ESM named imports can't synthesize
 * from `module.exports` — "expect" is therefore not available as a named
 * export, Playwright's test loader fails, exit code 1, "No tests found".
 *
 * Fix (exercised here): the fixture body is now keyed to the target project's
 * module type. For ESM projects we write `export { test, expect, request }`.
 * For CJS projects we keep `module.exports`. The test file is a regression
 * guard against re-introducing the ambiguous `.js` body.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  detectProjectModuleType,
  getCursorFixtureContent,
  ensureCursorFixtureFiles,
} = require('../src/pipeline-worker');

function tempProject(pkgJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-fixture-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkgJson ?? {}), 'utf-8');
  const generatedDir = path.join(dir, 'tests', 'generated');
  fs.mkdirSync(generatedDir, { recursive: true });
  return { projectPath: dir, generatedDir };
}

test('detectProjectModuleType returns "module" for ESM projects', () => {
  const { projectPath } = tempProject({ type: 'module', name: 'esm-app' });
  assert.equal(detectProjectModuleType(projectPath), 'module');
});

test('detectProjectModuleType returns "commonjs" for CJS projects', () => {
  const { projectPath } = tempProject({ name: 'cjs-app' });
  assert.equal(detectProjectModuleType(projectPath), 'commonjs');
});

test('detectProjectModuleType defaults to "commonjs" when package.json is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-fixture-nopkg-'));
  assert.equal(detectProjectModuleType(dir), 'commonjs');
});

test('getCursorFixtureContent emits ESM-compatible .js body when moduleType is "module"', () => {
  const { ts, js } = getCursorFixtureContent('{"init":"code"}', 'module');
  // TS body always uses `export { ... }` — Playwright's TS loader owns it.
  assert.match(ts, /^\s*import \{ test as base, expect, request \} from '@playwright\/test'/m);
  assert.match(ts, /export \{ test, expect, request \};/);
  // JS body in ESM mode MUST use named exports (not module.exports).
  assert.match(js, /^\s*import \{ test as base, expect, request \} from '@playwright\/test'/m);
  assert.match(js, /export \{ test, expect, request \};/);
  assert.doesNotMatch(js, /module\.exports\s*=/, 'ESM .js body must not use module.exports');
});

test('getCursorFixtureContent emits CJS body when moduleType is "commonjs"', () => {
  const { js } = getCursorFixtureContent('{"init":"code"}', 'commonjs');
  assert.match(js, /const \{ test: base, expect, request \} = require\('@playwright\/test'\)/);
  assert.match(js, /module\.exports\s*=\s*\{ test, expect, request \};/);
  assert.doesNotMatch(js, /^\s*import\s/m, 'CJS .js body must not use ESM `import`');
});

test('ensureCursorFixtureFiles writes ESM .js into a "type":"module" project', () => {
  const { projectPath, generatedDir } = tempProject({ type: 'module', name: 'pm-app' });
  const files = ensureCursorFixtureFiles(generatedDir, projectPath);
  assert.equal(files.length, 2);

  const jsBody = fs.readFileSync(path.join(generatedDir, '__healix-fixture.js'), 'utf-8');
  assert.match(jsBody, /export \{ test, expect, request \};/);
  assert.doesNotMatch(jsBody, /module\.exports/);
});

test('ensureCursorFixtureFiles writes CJS .js into a default-type project', () => {
  const { projectPath, generatedDir } = tempProject({ name: 'legacy-app' });
  ensureCursorFixtureFiles(generatedDir, projectPath);

  const jsBody = fs.readFileSync(path.join(generatedDir, '__healix-fixture.js'), 'utf-8');
  assert.match(jsBody, /module\.exports\s*=\s*\{ test, expect, request \};/);
  assert.doesNotMatch(jsBody, /^\s*export\s/m);
});

test('ESM fixture parses as a syntactically valid ESM module (no regression of the pm-app bug)', async (t) => {
  // `vm.SourceTextModule` is gated behind `--experimental-vm-modules`. Skip
  // cleanly when the flag is absent — the static-regex tests above already
  // guarantee the shape of the body (`export { test, expect, request };`,
  // no `module.exports`), so CI without the flag still catches the regression.
  const vm = require('node:vm');
  if (typeof vm.SourceTextModule !== 'function') {
    t.skip('vm.SourceTextModule requires --experimental-vm-modules; static checks cover the regression');
    return;
  }

  const { projectPath, generatedDir } = tempProject({ type: 'module', name: 'pm-app' });
  ensureCursorFixtureFiles(generatedDir, projectPath);
  const jsPath = path.join(generatedDir, '__healix-fixture.js');

  const body = fs.readFileSync(jsPath, 'utf-8');
  const mod = new vm.SourceTextModule(body, { identifier: jsPath });
  await mod.link(async (specifier) => {
    const stub = new vm.SourceTextModule(
      "const base = { extend: (o) => o }; const expect = () => {}; const request = {}; export { base as test, expect, request };",
      { identifier: specifier },
    );
    await stub.link(() => { throw new Error('no nested deps'); });
    return stub;
  });
  await mod.evaluate();

  assert.ok(mod.namespace.expect, 'expect is a named export on the ESM fixture');
  assert.ok(mod.namespace.test, 'test is a named export on the ESM fixture');
  assert.ok('request' in mod.namespace, 'request is a named export on the ESM fixture');
});
