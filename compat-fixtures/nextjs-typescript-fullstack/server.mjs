import http from 'node:http';

const port = Number(process.env.PORT || process.argv.find((arg) => arg.startsWith('--port='))?.split('=')[1] || 4230);

const json = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
};

const html = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Operations Hub</title><style>
body{font-family:Arial,sans-serif;margin:32px;color:#172033}nav{display:flex;gap:16px;margin-bottom:24px}section,article{border:1px solid #d8dee8;border-radius:8px;padding:16px;margin:12px 0;max-width:720px}button{padding:9px 11px}
</style></head><body>${body}</body></html>`;

const home = html(`<main><h1>Operations Hub</h1><nav aria-label="Primary navigation"><a href="/">Home</a><a href="/customers">Customers</a></nav><section aria-label="Incident Queue"><h2>Incident Queue</h2><article><h3>Payments Latency</h3><p>Severity: High</p><p>Owner: Platform Response</p></article><article><h3>Search Index Delay</h3><p>Severity: Medium</p><p>Owner: Search Guild</p></article></section><button type="button">Acknowledge Incident</button></main>`);
const customers = html(`<main><h1>Customer Portfolio</h1><nav aria-label="Primary navigation"><a href="/">Home</a><a href="/customers">Customers</a></nav><section><h2>Priority Customers</h2><ul><li>Summit Foods - Platinum support</li><li>Metro Health - Renewal due</li><li>Bluebird Energy - Expansion review</li></ul></section></main>`);

http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  if (url.pathname === '/api/incidents' && req.method === 'GET') {
    return json(res, 200, { incidents: [
      { id: 'inc-100', title: 'Payments Latency', severity: 'high', owner: 'Platform Response' },
      { id: 'inc-101', title: 'Search Index Delay', severity: 'medium', owner: 'Search Guild' }
    ] });
  }
  if (url.pathname === '/api/incidents' && req.method === 'POST') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      if (!body.title || !body.severity) return json(res, 400, { error: 'title and severity are required' });
      return json(res, 201, { incident: { id: 'inc-102', title: body.title, severity: body.severity, owner: body.owner || 'Unassigned' } });
    });
    return;
  }
  if (url.pathname === '/api/metrics') return json(res, 200, { metrics: { openIncidents: 2, responseSla: '94 percent', customerHealth: 'stable' } });
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(url.pathname === '/customers' ? customers : home);
}).listen(port, '127.0.0.1', () => {
  console.log(`Next.js compatibility fixture listening on http://127.0.0.1:${port}`);
});
