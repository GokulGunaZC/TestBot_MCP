import { test, expect } from '../__testbot-fixture';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';

const protectedApis = ['/api/test-runs', '/api/test-lists', '/api/profile', '/api/api-keys'];

test.describe('[CAT:api_auth] Protected API endpoints require auth', () => {
  for (const path of protectedApis) {
    test(`[CAT:api_auth] GET ${path} unauthenticated returns 401/403`, async ({ request }) => {
      const res = await request.get(`${BASE_URL}${path}`);
      expect([401, 403]).toContain(res.status());
    });
  }

  test('[CAT:api_auth] POST /api/auth/logout unauthenticated returns 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/auth/logout`);
    expect([401, 403]).toContain(res.status());
  });

  test('[CAT:api_negative] POST /api/api-keys unauthenticated returns 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/api-keys`);
    expect([401, 403]).toContain(res.status());
  });
});