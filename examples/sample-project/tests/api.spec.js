// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('API Endpoints', () => {
  test('should list all users', async ({ request }) => {
    const response = await request.get('/api/users');
    expect(response.ok()).toBeTruthy();
    
    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
    expect(data.length).toBeGreaterThanOrEqual(0);
  });

  test('should get user by ID', async ({ request }) => {
    const response = await request.get('/api/users/1');
    expect(response.ok()).toBeTruthy();
    
    const data = await response.json();
    expect(data).toHaveProperty('id');
    expect(data).toHaveProperty('name');
    expect(data).toHaveProperty('email');
  });

  test('should return 404 for non-existent user', async ({ request }) => {
    const response = await request.get('/api/users/99999');
    expect(response.status()).toBe(404);
  });

  test('should create a new user', async ({ request }) => {
    const newUser = {
      name: 'Test User',
      email: 'test@example.com'
    };
    
    const response = await request.post('/api/users', {
      data: newUser
    });
    
    expect([200, 201]).toContain(response.status());
    
    const data = await response.json();
    expect(data.name).toBe(newUser.name);
    expect(data.email).toBe(newUser.email);
  });
});
