'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  bundleOne,
  bundleFailures,
  extractTestBlock,
  findAcceptanceCriterion,
  findExplorationRoute,
  resolveTierAndRole,
  redact,
} = require('../src/failure-triage/evidence-bundler');

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-evidence-'));
  fs.mkdirSync(path.join(dir, 'tests', 'generated'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.healix'), { recursive: true });
  return dir;
}

test('redact strips credentials from evidence strings', () => {
  assert.equal(redact('hit POST /login with password=hunter2&foo=1'), 'hit POST /login with [REDACTED]&foo=1');
  assert.equal(redact('Authorization: Bearer abc123'), '[REDACTED]');
  assert.equal(redact('curl -H "api_key=s3cret"'), 'curl -H "[REDACTED]"');
  assert.equal(redact('nothing sensitive here'), 'nothing sensitive here');
});

test('resolveTierAndRole parses Playwright project names', () => {
  assert.deepEqual(resolveTierAndRole('tierA-public'), { tier: 'tiera-public', role: null });
  assert.deepEqual(resolveTierAndRole('tierB-auth-admin'), { tier: 'tierb-auth-admin', role: 'admin' });
  assert.deepEqual(resolveTierAndRole('tierB-auth-power-user'), { tier: 'tierb-auth-power-user', role: 'power-user' });
  assert.deepEqual(resolveTierAndRole('tierC-backend'), { tier: 'tierc-backend', role: null });
  assert.deepEqual(resolveTierAndRole(null), { tier: null, role: null });
});

test('extractTestBlock returns the matching test() literal', () => {
  const source = `
import { test, expect } from '@playwright/test';

test('[REQ:F1.S1.AC1] user can log in', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('[REQ:F1.S1.AC2] invalid creds show error', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByText('Invalid')).toBeVisible();
});
`;
  const block = extractTestBlock(source, '[REQ:F1.S1.AC1] user can log in');
  assert.ok(block, 'should find the block');
  assert.ok(block.includes('Sign in'), 'should include the matching selector');
  assert.ok(!block.includes('Invalid'), 'should not bleed into the next test');
});

test('findAcceptanceCriterion resolves REQ tag against parsed PRD', () => {
  const parsedPRD = {
    features: [
      {
        userStories: [
          {
            acceptanceCriteria: [
              { tag: 'F1.S1.AC1', text: 'Given valid creds, when user clicks Sign in, then they land on /dashboard', authRequired: false, kind: 'ui' },
              { tag: 'F1.S1.AC2', text: 'Invalid creds show inline error', authRequired: false },
            ],
          },
        ],
      },
    ],
  };
  const hit = findAcceptanceCriterion('[REQ:F1.S1.AC2] invalid creds show error', parsedPRD);
  assert.equal(hit.tag, 'F1.S1.AC2');
  assert.ok(hit.text.startsWith('Invalid creds'));

  const miss = findAcceptanceCriterion('[REQ:F9.S9.AC9] something else', parsedPRD);
  assert.ok(miss.unmatched, 'falls back to partial-match with unmatched flag');
});

test('findExplorationRoute matches by exact path and prefix', () => {
  const explorationArtifact = {
    routes: [
      { path: '/login', elements: [{ selector: 'button[type=submit]' }, { selector: 'input[name=email]' }] },
      { path: '/dashboard', elements: [{ selector: '[data-testid=welcome]' }] },
    ],
  };
  const exact = findExplorationRoute('https://example.com/login', explorationArtifact);
  assert.ok(exact);
  assert.equal(exact.path, '/login');
  assert.ok(exact.selectors.includes('button[type=submit]'));

  const prefix = findExplorationRoute('https://example.com/dashboard/reports', explorationArtifact);
  assert.ok(prefix);
  assert.equal(prefix.path, '/dashboard');

  assert.equal(findExplorationRoute('https://example.com/unknown', explorationArtifact), null);
});

test('bundleOne builds a full FailureEvidence for a real file + PRD', async () => {
  const dir = tmpProject();
  const specPath = path.join(dir, 'tests', 'generated', 'login.spec.ts');
  fs.writeFileSync(specPath, `
import { test, expect } from '@playwright/test';

test('[REQ:F1.S1.AC1] user can log in', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Buy now' }).click();
  await expect(page).toHaveURL('/dashboard');
});
`.trim(), 'utf-8');

  fs.writeFileSync(
    path.join(dir, '.healix', 'parsed-prd.json'),
    JSON.stringify({
      features: [{
        userStories: [{
          acceptanceCriteria: [
            { tag: 'F1.S1.AC1', text: 'User can sign in with valid credentials and land on /dashboard', authRequired: false },
          ],
        }],
      }],
    }),
    'utf-8',
  );

  fs.writeFileSync(
    path.join(dir, '.healix', 'exploration-artifact.json'),
    JSON.stringify({
      routes: [
        { path: '/login', elements: [
          { selector: 'button[type=submit]', text: 'Sign in' },
          { selector: 'input[name=email]' },
        ] },
      ],
    }),
    'utf-8',
  );

  const failure = {
    testName: '[REQ:F1.S1.AC1] user can log in',
    file: 'tests/generated/login.spec.ts',
    error: { message: "strict mode violation: getByRole('button', { name: 'Buy now' }) resolved to 0 elements" },
    projectName: 'tierA-public',
    status: 'failed',
    duration: 2200,
  };

  const { parsedPRD, explorationArtifact } = {
    parsedPRD: JSON.parse(fs.readFileSync(path.join(dir, '.healix', 'parsed-prd.json'), 'utf-8')),
    explorationArtifact: JSON.parse(fs.readFileSync(path.join(dir, '.healix', 'exploration-artifact.json'), 'utf-8')),
  };

  const bundle = await bundleOne({
    failure,
    test: { ...failure, title: failure.testName },
    projectPath: dir,
    parsedPRD,
    explorationArtifact,
  });

  assert.equal(bundle.kind, 'test');
  assert.equal(bundle.tier, 'tiera-public');
  assert.equal(bundle.role, null);
  assert.ok(bundle.testSource, 'includes test source');
  assert.ok(bundle.testSource.includes('Buy now'));
  assert.ok(bundle.acceptanceCriterion, 'includes AC');
  assert.equal(bundle.acceptanceCriterion.tag, 'F1.S1.AC1');
  assert.ok(bundle.error.message.includes('Buy now'));
  assert.ok(!bundle.error.message.includes('password='), 'no credential leak');
  assert.equal(bundle.trace.parseError, 'trace_not_available');
});

test('bundleFailures persists bundles to healix-reports/.runs/{runId}/failures/', async () => {
  const dir = tmpProject();
  const specPath = path.join(dir, 'tests', 'generated', 'cart.spec.ts');
  fs.writeFileSync(specPath, `
import { test, expect } from '@playwright/test';
test('[REQ:F2.S1.AC1] add to cart', async ({ page }) => {
  await page.goto('/products');
});
`.trim(), 'utf-8');

  const { bundles, skipped } = await bundleFailures({
    failures: [
      { testName: '[REQ:F2.S1.AC1] add to cart', file: 'tests/generated/cart.spec.ts', error: { message: 'timeout' }, projectName: 'tierA-public' },
    ],
    tests: [],
    projectPath: dir,
    runId: 'run-xyz',
  });

  assert.equal(skipped, 0);
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].testName, '[REQ:F2.S1.AC1] add to cart');

  const persisted = path.join(dir, 'healix-reports', '.runs', 'run-xyz', 'failures', '0.json');
  assert.ok(fs.existsSync(persisted), 'persisted bundle should exist');
  const on_disk = JSON.parse(fs.readFileSync(persisted, 'utf-8'));
  assert.equal(on_disk.testName, '[REQ:F2.S1.AC1] add to cart');
});

test('bundleFailures returns [] for empty input without touching disk', async () => {
  const { bundles, skipped } = await bundleFailures({
    failures: [],
    tests: [],
    projectPath: '/tmp/does-not-exist',
    runId: 'run-zzz',
  });
  assert.equal(bundles.length, 0);
  assert.equal(skipped, 0);
});
