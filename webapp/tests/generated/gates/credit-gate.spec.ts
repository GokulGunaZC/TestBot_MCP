import { test, expect } from '../__healix-fixture';
import { execSync } from 'child_process';
import path from 'path';

/**
 * Token gate + API key gating tests
 *
 * Token gate → /api/generate-tests  (AI endpoint, checks tokens_remaining before calling OpenAI)
 * API key auth → /api/test-runs/ingest  (fastest endpoint to test 401 without side-effects)
 *
 * Requires a valid API key:
 *   TEST_API_KEY=tb_xxx npx playwright test credit-gate
 *
 * Account state is set by the setup script BEFORE each scenario:
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

const MINIMAL_GENERATE_BODY = { api_key: VALID_KEY, context: {} };

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
});

test.describe('Token Gate [CAT:api_token_gate]', () => {
  test('zero tokens → 402 on generate-tests [scenario: no-tokens]', async ({ request }) => {
    test.skip(!VALID_KEY, 'TEST_API_KEY env var not set');
    setupScenario('no-tokens');

    const res = await request.post(`${BASE_URL}/api/generate-tests`, {
      headers: { 'x-api-key': VALID_KEY },
      data: MINIMAL_GENERATE_BODY,
    });
    expect(res.status()).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/no tokens/i);
  });

  test('tokens available → passes token gate [scenario: reset]', async ({ request }) => {
    test.skip(!VALID_KEY, 'TEST_API_KEY env var not set');
    setupScenario('reset');

    const res = await request.post(`${BASE_URL}/api/generate-tests`, {
      headers: { 'x-api-key': VALID_KEY },
      data: MINIMAL_GENERATE_BODY,
    });
    // Must not be blocked by token gate (402) — may be 200 or other non-402 status
    expect(res.status()).not.toBe(402);
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
