import http from 'node:http';

const port = Number(process.env.PORT || process.argv.find((arg) => arg.startsWith('--port='))?.split('=')[1] || 4240);
const workOrders = [
  { id: 'wo-100', title: 'Packaging Line Calibration', priority: 'high', status: 'open' },
  { id: 'wo-101', title: 'Cold Storage Inspection', priority: 'medium', status: 'scheduled' }
];

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  if (url.pathname === '/api/health' && req.method === 'GET') return send(res, 200, { status: 'ok', service: 'fulfillment-api' });
  if (url.pathname === '/api/work-orders' && req.method === 'GET') return send(res, 200, { workOrders });
  if (url.pathname === '/api/work-orders' && req.method === 'POST') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      if (!body.title || !body.priority) return send(res, 400, { error: 'title and priority are required' });
      return send(res, 201, { workOrder: { id: 'wo-102', title: body.title, priority: body.priority, status: 'open' } });
    });
    return;
  }
  if (url.pathname.startsWith('/api/work-orders/') && req.method === 'DELETE') {
    return send(res, 200, { id: url.pathname.split('/').pop(), status: 'deleted' });
  }
  return send(res, 404, { error: 'not found' });
}).listen(port, '127.0.0.1', () => {
  console.log(`Node API compatibility fixture listening on http://127.0.0.1:${port}`);
});
