import { test, expect } from './__testbot-fixture';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3001';

test.describe('[CAT:api_stress] @phase2 API stress and robustness', () => {
  test('@phase2 [CAT:api_stress] Burst unauthenticated GET /api/test-runs remains consistently 401/403', async ({ request }) => {
    const count = 25;
    const responses = await Promise.all(
      Array.from({ length: count }, () => request.get(`${BASE_URL}/api/test-runs`))
    );

    expect(responses).toHaveLength(count);
    for (const r of responses) {
      expect([401, 403]).toContain(r.status());
    }
  });

  test('@phase2 [CAT:api_stress] Burst invalid login attempts do not return 5xx', async ({ request }) => {
    const count = 20;
    const responses = await Promise.all(
      Array.from({ length: count }, () =>
        request.post(`${BASE_URL}/api/auth/login`, {
          data: { email: 'invalid.user@example.com', password: 'WrongPassword!' }
        })
      )
    );

    expect(responses).toHaveLength(count);
    for (const r of responses) {
      // Accept 400/401/429; ensure not a server error.
      expect(r.status()).toBeGreaterThanOrEqual(200);
      expect(r.status()).toBeLessThan(600);
      expect([400, 401, 429]).toContain(r.status());
    }
  });
});