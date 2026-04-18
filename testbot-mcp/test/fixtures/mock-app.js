'use strict';

/**
 * Tiny mock customer app used by the pipeline integration test.
 *
 *   GET  /                 — home (public)
 *   GET  /login            — login form (public)
 *   POST /login            — accepts form-encoded username/password
 *                            valid creds: admin/admin123, user/user123
 *                            sets 'session=<role>' cookie + 302 to /dashboard
 *                            invalid creds: 401 + failure banner
 *   GET  /dashboard        — auth-gated (requires session cookie)
 *   GET  /admin            — admin-only
 *   GET  /api/health       — public JSON
 *   GET  /api/items        — auth-gated JSON
 *
 * Returns { server, baseURL, stop } from start().
 */

const http = require('node:http');

const USERS = {
  admin: { password: 'admin123', role: 'admin' },
  user: { password: 'user123', role: 'user' },
};

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const [k, ...rest] = pair.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join('='));
  }
  return out;
}

function parseFormBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      const params = new URLSearchParams(body);
      resolve(Object.fromEntries(params.entries()));
    });
    req.on('error', () => resolve({}));
  });
}

function html(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Mock App</title></head><body>${body}</body></html>`;
}

function homePage() {
  return html(`
    <nav><a href="/">Home</a> | <a href="/login">Login</a> | <a href="/dashboard">Dashboard</a></nav>
    <h1>Welcome</h1>
    <p>This is the Healix mock customer app.</p>
  `);
}

function loginPage(errorMsg) {
  const banner = errorMsg
    ? `<div role="alert" class="error" data-testid="login-error">${errorMsg}</div>`
    : '';
  return html(`
    <nav><a href="/">Home</a></nav>
    <h1>Sign in</h1>
    ${banner}
    <form method="POST" action="/login">
      <label>Email <input type="email" name="email" required autocomplete="username" /></label>
      <label>Password <input type="password" name="password" required autocomplete="current-password" /></label>
      <button type="submit">Log in</button>
    </form>
  `);
}

function dashboardPage(role) {
  return html(`
    <nav><a href="/">Home</a> | <a href="/logout">Logout</a></nav>
    <h1 data-testid="welcome">Welcome, ${role}</h1>
    <div data-testid="user-role" id="user-role">${role}</div>
    ${role === 'admin' ? '<a href="/admin">Admin area</a>' : ''}
  `);
}

function adminPage() {
  return html(`
    <h1 data-testid="admin-title">Admin Dashboard</h1>
    <p>Admin-only content.</p>
  `);
}

function start({ logRequests = false } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (logRequests) {
        // eslint-disable-next-line no-console
        console.log('[mock-app]', req.method, req.url);
      }
      const url = new URL(req.url, 'http://local');
      const method = req.method || 'GET';
      const cookies = parseCookies(req.headers.cookie);
      const session = cookies.session || null;

      // --- Public routes ---------------------------------------------------
      if (method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(homePage());
        return;
      }
      if (method === 'GET' && url.pathname === '/login') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(loginPage(url.searchParams.get('error') || ''));
        return;
      }
      if (method === 'POST' && url.pathname === '/login') {
        const body = await parseFormBody(req);
        // Accept both "email" and "username" to mirror typical apps.
        const id = String(body.email || body.username || '').split('@')[0].toLowerCase();
        const pw = String(body.password || '');
        const u = USERS[id];
        if (u && u.password === pw) {
          res.writeHead(302, {
            'set-cookie': `session=${u.role}; Path=/; HttpOnly; SameSite=Lax`,
            location: '/dashboard',
          });
          res.end();
          return;
        }
        res.writeHead(401, { 'content-type': 'text/html' });
        res.end(loginPage('Invalid email or password'));
        return;
      }
      if (method === 'GET' && url.pathname === '/logout') {
        res.writeHead(302, {
          'set-cookie': 'session=; Path=/; Max-Age=0',
          location: '/',
        });
        res.end();
        return;
      }
      if (method === 'GET' && url.pathname === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // --- Auth-gated routes ----------------------------------------------
      if (!session) {
        if (url.pathname === '/dashboard' || url.pathname === '/admin') {
          res.writeHead(302, { location: '/login' });
          res.end();
          return;
        }
        if (url.pathname === '/api/items') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
      }

      if (method === 'GET' && url.pathname === '/dashboard') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(dashboardPage(session));
        return;
      }
      if (method === 'GET' && url.pathname === '/admin') {
        if (session !== 'admin') {
          res.writeHead(403, { 'content-type': 'text/html' });
          res.end(html('<h1>Forbidden</h1>'));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(adminPage());
        return;
      }
      if (method === 'GET' && url.pathname === '/api/items') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: session === 'admin' ? ['a', 'b', 'c'] : ['a'] }));
        return;
      }

      // --- 404 --------------------------------------------------------------
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end(html('<h1>Not found</h1>'));
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const baseURL = `http://127.0.0.1:${addr.port}`;
      const stop = () => new Promise((r) => server.close(r));
      resolve({ server, baseURL, stop });
    });
  });
}

module.exports = { start, USERS };
