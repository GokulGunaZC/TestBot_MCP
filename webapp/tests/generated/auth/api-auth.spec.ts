import { test, expect } from '../__testbot-fixture';

const BASE_URL = 'http://localhost:3000';

test.describe('Auth API', () => {
  test('POST /api/auth/login contract success shape OR bounded client error [CAT:api_contract]', async ({ request }) => {
    // Contract: response schema includes { success: boolean, userId: string }
    // Status codes are not explicitly documented in endpoint contract; keep assertions bounded.
    const res = await request.post(`${BASE_URL}/api/auth/login`, {
      data: {
        email: 'user@example.com',
        password: 'password123'
      }
    });

    expect(res.status(), 'Login should not produce server errors').toBeLessThan(500);

    const ct = res.headers()['content-type'] || '';
    // Prefer JSON, but allow non-JSON error responses without failing the suite.
    if (ct.includes('application/json')) {
      const body = await res.json();
      expect(body).toBeTruthy();
      if (res.status() < 300) {
        expect(typeof body.success).toBe('boolean');
        if (body.success === true) {
          expect(typeof body.userId).toBe('string');
        }
      } else {
        // Error responses use { error: string } shape
        expect(typeof body.error).toBe('string');
      }
    }
  });

  test('POST /api/auth/login missing fields -> 400 (workflow expectation) [CAT:api_negative]', async ({ request }) => {
    // From workflow "API validation": missing fields return 400.
    const res = await request.post(`${BASE_URL}/api/auth/login`, {
      data: {
        email: 'user@example.com'
      }
    });

    expect(res.status()).toBe(400);
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);

    const ct = res.headers()['content-type'] || '';
    // If server returns JSON, ensure it's parseable (do not invent error schema).
    if (ct.includes('application/json')) {
      const body = await res.json();
      expect(body).toBeTruthy();
    }
  });

  test('POST /api/auth/login invalid credentials -> 401 (workflow expectation) [CAT:api_negative]', async ({ request }) => {
    // From workflow "API validation": wrong credentials return 401.
    const res = await request.post(`${BASE_URL}/api/auth/login`, {
      data: {
        email: 'user@example.com',
        password: 'definitely-wrong-password'
      }
    });

    expect(res.status()).toBe(401);
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);

    const ct = res.headers()['content-type'] || '';
    if (ct.includes('application/json')) {
      const body = await res.json();
      expect(body).toBeTruthy();
    }
  });

  test('POST /api/auth/signup contract success shape OR bounded client error [CAT:api_contract]', async ({ request }) => {
    // Contract: response schema includes { success: boolean, userId: string }
    // Exact statuses are not documented; keep assertions bounded and deterministic.
    const res = await request.post(`${BASE_URL}/api/auth/signup`, {
      data: {
        email: 'newuser@example.com',
        full_name: 'New User',
        password: 'password123'
      }
    });

    expect(res.status(), 'Signup should not produce server errors').toBeLessThan(500);

    const ct = res.headers()['content-type'] || '';
    if (ct.includes('application/json')) {
      const body = await res.json();
      expect(body).toBeTruthy();
      if (res.status() < 300) {
        expect(typeof body.success).toBe('boolean');
        if (body.success === true) {
          expect(typeof body.userId).toBe('string');
        }
      } else {
        expect(typeof body.error).toBe('string');
      }
    }
  });
});