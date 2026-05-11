import http from 'node:http';

const port = Number(process.env.PORT || process.argv.find((arg) => arg.startsWith('--port='))?.split('=')[1] || 4260);
const claims = [
  { claimId: 'clm-100', member: 'Orthopedic Review', status: 'pending' },
  { claimId: 'clm-101', member: 'Cardiology Follow Up', status: 'approved' }
];

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  if (url.pathname === '/api/claims' && req.method === 'GET') return send(res, 200, { claims });
  if (url.pathname === '/api/claims' && req.method === 'POST') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      if (!body.claimId || !body.member) return send(res, 400, { error: 'claimId and member are required' });
      return send(res, 201, { claim: { claimId: body.claimId, member: body.member, status: body.status || 'pending' } });
    });
    return;
  }
  if (url.pathname.startsWith('/api/claims/') && req.method === 'GET') {
    return send(res, 200, { claim: claims[0] });
  }
  return send(res, 404, { error: 'not found' });
}).listen(port, '127.0.0.1', () => {
  console.log(`.NET-shaped API compatibility fixture listening on http://127.0.0.1:${port}`);
});
