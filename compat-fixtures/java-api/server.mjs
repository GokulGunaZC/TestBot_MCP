import http from 'node:http';

const port = Number(process.env.PORT || process.argv.find((arg) => arg.startsWith('--port='))?.split('=')[1] || 4250);
const inventory = [
  { sku: 'sku-100', name: 'Surgical Mask Kit', quantity: 420 },
  { sku: 'sku-101', name: 'ICU Sensor Pack', quantity: 85 }
];

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  if (url.pathname === '/api/inventory' && req.method === 'GET') return send(res, 200, { inventory });
  if (url.pathname === '/api/inventory' && req.method === 'POST') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      if (!body.sku || !body.quantity) return send(res, 400, { error: 'sku and quantity are required' });
      return send(res, 201, { item: { sku: body.sku, name: body.name || 'New Inventory Item', quantity: body.quantity } });
    });
    return;
  }
  if (url.pathname.startsWith('/api/inventory/') && req.method === 'GET') {
    return send(res, 200, { item: inventory[0] });
  }
  return send(res, 404, { error: 'not found' });
}).listen(port, '127.0.0.1', () => {
  console.log(`Java API compatibility fixture listening on http://127.0.0.1:${port}`);
});
