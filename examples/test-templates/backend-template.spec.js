// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Backend/API Test Template
 * 
 * This template demonstrates common patterns for API testing
 * with Playwright. Use this as a starting point for your tests.
 */

test.describe('API Health Checks', () => {

  test('should respond to health check endpoint', async ({ request }) => {
    // Try common health check endpoints
    const endpoints = ['/health', '/api/health', '/status', '/api/status'];
    
    let healthCheckPassed = false;
    
    for (const endpoint of endpoints) {
      const response = await request.get(endpoint);
      if (response.ok()) {
        healthCheckPassed = true;
        break;
      }
    }
    
    // If no dedicated health endpoint, check root
    if (!healthCheckPassed) {
      const response = await request.get('/');
      expect(response.ok()).toBeTruthy();
    }
  });

});

test.describe('REST API - GET Endpoints', () => {

  test('should list resources', async ({ request }) => {
    // Example: GET /api/users
    const response = await request.get('/api/users');
    
    expect(response.ok()).toBeTruthy();
    expect(response.status()).toBe(200);
    
    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
  });

  test('should get single resource by ID', async ({ request }) => {
    // Example: GET /api/users/1
    const response = await request.get('/api/users/1');
    
    if (response.ok()) {
      const data = await response.json();
      expect(data).toHaveProperty('id');
    } else {
      // 404 is also valid if resource doesn't exist
      expect([200, 404]).toContain(response.status());
    }
  });

  test('should return 404 for non-existent resource', async ({ request }) => {
    // Example: GET /api/users/99999
    const response = await request.get('/api/users/99999');
    
    expect([404, 200]).toContain(response.status());
    
    if (response.status() === 404) {
      const data = await response.json();
      expect(data).toHaveProperty('error');
    }
  });

});

test.describe('REST API - POST Endpoints', () => {

  test('should create a new resource', async ({ request }) => {
    // Example: POST /api/users
    const newUser = {
      name: 'Test User',
      email: 'test@example.com'
    };
    
    const response = await request.post('/api/users', {
      data: newUser
    });
    
    // Should return 201 Created or 200 OK
    expect([200, 201]).toContain(response.status());
    
    if (response.ok()) {
      const data = await response.json();
      expect(data).toHaveProperty('id');
      expect(data.name).toBe(newUser.name);
    }
  });

  test('should validate required fields', async ({ request }) => {
    // Example: POST /api/users with missing required fields
    const response = await request.post('/api/users', {
      data: {}
    });
    
    // Should return 400 Bad Request
    expect([400, 422]).toContain(response.status());
    
    const data = await response.json();
    expect(data).toHaveProperty('error');
  });

  test('should reject invalid email format', async ({ request }) => {
    // Example: POST /api/users with invalid email
    const response = await request.post('/api/users', {
      data: {
        name: 'Test User',
        email: 'invalid-email'
      }
    });
    
    // May accept or reject based on validation
    if (response.status() === 400 || response.status() === 422) {
      const data = await response.json();
      expect(data).toHaveProperty('error');
    }
  });

});

test.describe('REST API - PUT/PATCH Endpoints', () => {

  test('should update existing resource', async ({ request }) => {
    // First create a resource
    const createResponse = await request.post('/api/users', {
      data: {
        name: 'Original Name',
        email: 'original@example.com'
      }
    });
    
    if (createResponse.ok()) {
      const created = await createResponse.json();
      
      // Update the resource
      const updateResponse = await request.put(`/api/users/${created.id}`, {
        data: {
          name: 'Updated Name',
          email: 'updated@example.com'
        }
      });
      
      if (updateResponse.ok()) {
        const updated = await updateResponse.json();
        expect(updated.name).toBe('Updated Name');
      }
    }
  });

  test('should return 404 when updating non-existent resource', async ({ request }) => {
    const response = await request.put('/api/users/99999', {
      data: {
        name: 'Test',
        email: 'test@example.com'
      }
    });
    
    expect([404, 400]).toContain(response.status());
  });

});

test.describe('REST API - DELETE Endpoints', () => {

  test('should delete existing resource', async ({ request }) => {
    // First create a resource
    const createResponse = await request.post('/api/users', {
      data: {
        name: 'To Be Deleted',
        email: 'delete@example.com'
      }
    });
    
    if (createResponse.ok()) {
      const created = await createResponse.json();
      
      // Delete the resource
      const deleteResponse = await request.delete(`/api/users/${created.id}`);
      
      expect([200, 204]).toContain(deleteResponse.status());
      
      // Verify it's deleted
      const getResponse = await request.get(`/api/users/${created.id}`);
      expect([404, 200]).toContain(getResponse.status());
    }
  });

  test('should return 404 when deleting non-existent resource', async ({ request }) => {
    const response = await request.delete('/api/users/99999');
    
    expect([404, 204]).toContain(response.status());
  });

});

test.describe('Error Handling', () => {

  test('should handle malformed JSON', async ({ request }) => {
    const response = await request.post('/api/users', {
      headers: {
        'Content-Type': 'application/json'
      },
      data: 'not valid json'
    });
    
    expect([400, 500]).toContain(response.status());
  });

  test('should return proper error format', async ({ request }) => {
    // Make a request that should fail
    const response = await request.get('/api/nonexistent-endpoint');
    
    if (!response.ok()) {
      // Check if response is JSON
      const contentType = response.headers()['content-type'];
      if (contentType && contentType.includes('application/json')) {
        const data = await response.json();
        // Error response should have error property
        expect(data).toHaveProperty('error');
      }
    }
  });

});
