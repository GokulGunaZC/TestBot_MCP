const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { exploreWithPlaywright } = require('../src/playwright-explorer');

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const path = req.url.split('?')[0];
    const heading = path === '/orders' ? 'Orders' : (path === '/admin' ? 'Admin' : 'Home');
    res.end(`<!doctype html>
      <html>
        <head><title>${heading}</title></head>
        <body>
          <h1>${heading}</h1>
          <nav>
            <a href="/admin#/products">Admin products</a>
            <a href="/products?q=book">Book search</a>
          </nav>
          <button id="orders-nav" onclick="history.pushState({}, '', '/orders'); document.querySelector('h1').textContent = 'Orders';">Orders</button>
          <button id="menu-toggle" onclick="document.getElementById('menu').innerHTML = '<a href=&quot;/checkout&quot;>Checkout</a>';">Menu</button>
          <div id="menu"></div>
        </body>
      </html>`);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        baseURL: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('playwright heuristic explores hash, query, and click-driven routes', async () => {
  const fixture = await startFixtureServer();
  try {
    const result = await exploreWithPlaywright({ baseURL: fixture.baseURL });
    assert.equal(result.available, true);
    const paths = new Set((result.artifact.routes || []).map((route) => route.path));
    assert.equal(paths.has('/'), true);
    assert.equal(paths.has('/admin#/products'), true);
    assert.equal(paths.has('/products?q=book'), true);
    assert.equal(paths.has('/orders'), true);
    assert.equal(paths.has('/checkout'), true);
  } finally {
    await fixture.close();
  }
});
