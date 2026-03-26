import { test, expect, APIRequestContext } from '../__testbot-fixture';

const BASE_URL = 'http://localhost:3000';

function authHeaderFromEnv(): Record<string, string> {
  // If the app uses bearer tokens, provide one via env without guessing field names.
  // Example: AUTH_TOKEN=... will enable authenticated success checks.
  const token = process.env.AUTH_TOKEN;
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

async function expectUnauth401(request: APIRequestContext, path: string) {
  const res = await request.get(`${BASE_URL}${path}`);
  // From workflow "API validation": protected APIs return 401 without session.
  expect(res.status()).toBe(401);
  expect(res.status()).toBeGreaterThanOrEqual(400);
  expect(res.status()).toBeLessThan(500);
}

test.describe('Protected APIs', () => {
  test('Unauthenticated GET /api/test-runs -> 401 [CAT:api_auth]', async ({ request }) => {
    await expectUnauth401(request, '/api/test-runs');
  });

  test('Unauthenticated GET /api/test-lists -> 401 [CAT:api_auth]', async ({ request }) => {
    await expectUnauth401(request, '/api/test-lists');
  });

  test('Unauthenticated GET /api/profile -> 401 [CAT:api_auth]', async ({ request }) => {
    await expectUnauth401(request, '/api/profile');
  });

  test('Unauthenticated GET /api/api-keys -> 401 [CAT:api_auth]', async ({ request }) => {
    await expectUnauth401(request, '/api/api-keys');
  });

  test('Unauthenticated POST /api/auth/logout -> 401 [CAT:api_auth]', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/auth/logout`);
    // Endpoint requires auth in contract; workflow expectation for protected APIs is 401.
    expect(res.status()).toBe(401);
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('Authenticated GET protected endpoints (when AUTH_TOKEN is available) [CAT:api_contract]', async ({ request }) => {
    const headers = authHeaderFromEnv();
    test.skip(Object.keys(headers).length === 0, 'AUTH_TOKEN not provided; skipping authenticated checks');

    const endpoints = ['/api/test-runs', '/api/test-lists', '/api/profile', '/api/api-keys'] as const;

    for (const path of endpoints) {
      const res = await request.get(`${BASE_URL}${path}`, { headers });
      expect(res.status(), `${path} should not produce 5xx`).toBeLessThan(500);
      expect(res.ok(), `${path} should succeed when authenticated`).toBeTruthy();

      const ct = res.headers()['content-type'] || '';
      // Response schemas are not provided; only assert basic contract: JSON if returned.
      if (ct.includes('application/json')) {
        const body = await res.json();
        expect(body).toBeTruthy();
      }
    }
  });

  test('Negative: Unsupported method on collection (PUT /api/test-runs) should be 4xx bounded [CAT:api_negative]', async ({ request }) => {
    // Do not invent exact status; assert bounded client error and no 5xx.
    const res = await request.fetch(`${BASE_URL}/api/test-runs`, { method: 'PUT' });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('Burst: unauthenticated protected GETs should not produce 5xx [CAT:api_stress]', async ({ request }) => {
    // Lightweight stress test: small burst size and deterministic threshold.
    const paths = ['/api/test-runs', '/api/test-lists', '/api/profile', '/api/api-keys'];
    const N = 8;

    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) => request.get(`${BASE_URL}${paths[i % paths.length]}`))
    );

    for (const res of responses) {
      expect(res.status(), 'Burst requests must not hit 5xx').toBeLessThan(500);
      // Also ensure they are client/auth failures as expected when unauthenticated.
      expect(res.status()).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
    }
  });
});