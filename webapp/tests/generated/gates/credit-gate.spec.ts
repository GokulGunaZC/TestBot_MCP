import { test, expect } from '../__testbot-fixture';
import { execSync } from 'child_process';
import path from 'path';

/**
 * Credit gate + API key gating tests for /api/test-runs/ingest
 *
 * Requires a valid API key passed via env:
 *   TEST_API_KEY=tb_xxx npx playwright test credit-gate
 *
 * Account state is set by the setup script BEFORE running each scenario:
 *   npx tsx scripts/setup-test-account.ts <scenario>
 */

const BASE_URL = 'http://localhost:3000';
const VALID_KEY = process.env.TEST_API_KEY ?? '';
const WEBAPP_DIR = path.resolve(__dirname, '../../../');

function setupScenario(scenario: string) {
  execSync(`npx tsx scripts/setup-test-account.ts ${scenario}`, {
    cwd: WEBAPP_DIR,
    stdio: 'pipe',
  });
}

const MINIMAL_REPORT = {
  report: {
    metadata: { projectName: 'test-project' },
    stats: { total: 1, passed: 1, failed: 0, skipped: 0, duration: 100 },
    tests: [{ title: 'sample test', status: 'passed' }],
  },
};

// Scenario-dependent tests mutate shared DB state; run serially to avoid races.
test.describe.configure({ mode: 'serial' });

test.describe('API Key Gating [CAT:api_auth]', () => {
  test('missing api_key → 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/test-runs/ingest`, {
      data: MINIMAL_REPORT,
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });

  test('invalid api_key → 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/test-runs/ingest`, {
      headers: { 'x-api-key': 'tb_invalid_key_000000000000000000000000' },
      data: MINIMAL_REPORT,
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });

  test('valid api_key without credits → 402 [scenario: no-credits]', async ({ request }) => {
    test.skip(!VALID_KEY, 'TEST_API_KEY env var not set');
    setupScenario('no-credits');

    const res = await request.post(`${BASE_URL}/api/test-runs/ingest`, {
      headers: { 'x-api-key': VALID_KEY },
      data: MINIMAL_REPORT,
    });
    // This test must be run AFTER: npx tsx scripts/setup-test-account.ts no-credits
    expect(res.status()).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/no credits|credits remaining/i);
  });

  test('valid api_key with credits → 200 [scenario: reset]', async ({ request }) => {
    test.skip(!VALID_KEY, 'TEST_API_KEY env var not set');
    setupScenario('reset');

    const res = await request.post(`${BASE_URL}/api/test-runs/ingest`, {
      headers: { 'x-api-key': VALID_KEY },
      data: MINIMAL_REPORT,
    });
    // This test must be run AFTER: npx tsx scripts/setup-test-account.ts reset
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.test_run_id).toBe('string');
  });

  test('last credit is consumed and next call gets 402 [scenario: low-credits]', async ({ request }) => {
    test.skip(!VALID_KEY, 'TEST_API_KEY env var not set');
    setupScenario('low-credits');

    // First call should use the last credit → 200
    const first = await request.post(`${BASE_URL}/api/test-runs/ingest`, {
      headers: { 'x-api-key': VALID_KEY },
      data: { ...MINIMAL_REPORT, report: { ...MINIMAL_REPORT.report, metadata: { projectName: 'low-credit-test-1' } } },
    });
    expect(first.status()).toBe(200);

    // Second call should be blocked → 402
    const second = await request.post(`${BASE_URL}/api/test-runs/ingest`, {
      headers: { 'x-api-key': VALID_KEY },
      data: { ...MINIMAL_REPORT, report: { ...MINIMAL_REPORT.report, metadata: { projectName: 'low-credit-test-2' } } },
    });
    expect(second.status()).toBe(402);
  });
});

test.describe('Rate Limit Gating [CAT:api_rate_limit]', () => {
  test('burst of requests does not cause 5xx [scenario: reset]', async ({ request }) => {
    test.skip(!VALID_KEY, 'TEST_API_KEY env var not set');
    setupScenario('reset');

    // Fire 5 quick requests — they may hit 429 but must NOT 5xx
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request.post(`${BASE_URL}/api/test-runs/ingest`, {
          headers: { 'x-api-key': VALID_KEY },
          data: MINIMAL_REPORT,
        })
      )
    );

    for (const res of results) {
      expect(res.status(), `Got unexpected status ${res.status()}`).toBeLessThan(500);
    }
  });
});
