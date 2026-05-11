import http from 'node:http';

const port = Number(process.env.PORT || process.argv.find((arg) => arg.startsWith('--port='))?.split('=')[1] || 4210);

const page = (title, body) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: Arial, sans-serif; margin: 32px; color: #172033; }
      nav { display: flex; gap: 16px; margin: 0 0 24px; }
      article, form, section { border: 1px solid #d8dee8; border-radius: 8px; padding: 16px; margin: 12px 0; max-width: 720px; }
      label { display: block; margin-top: 12px; font-weight: 700; }
      input, select, button { margin-top: 6px; padding: 9px 11px; }
    </style>
  </head>
  <body>${body}</body>
</html>`;

const routes = {
  '/': page('Project Health Center', `
    <main>
      <h1>Project Health Center</h1>
      <nav aria-label="Primary navigation">
        <a href="/">Dashboard</a>
        <a href="/intake">Delivery Intake</a>
        <a href="/reports">Release Reports</a>
      </nav>
      <section aria-label="Active Delivery Streams">
        <h2>Active Delivery Streams</h2>
        <article><h3>Mobile Checkout Stabilization</h3><p>Sprint Confidence: High</p><p>Risk: Payment retry coverage pending</p></article>
        <article><h3>Enterprise Reporting Refresh</h3><p>Sprint Confidence: Medium</p><p>Risk: Data export validation pending</p></article>
      </section>
      <button type="button" aria-label="Review delivery risks">Review Risks</button>
    </main>`),
  '/intake': page('Delivery Intake', `
    <main>
      <h1>Delivery Intake</h1>
      <nav aria-label="Primary navigation"><a href="/">Dashboard</a><a href="/reports">Release Reports</a></nav>
      <form aria-label="Delivery intake form">
        <label for="workstream-name">Workstream Name</label>
        <input id="workstream-name" name="workstreamName" required placeholder="Payments QA" />
        <label for="owner-email">Owner Email</label>
        <input id="owner-email" name="ownerEmail" type="email" required placeholder="owner@example.com" />
        <label for="priority">Priority</label>
        <select id="priority" name="priority"><option>High</option><option>Medium</option><option>Low</option></select>
        <button type="submit">Save Intake</button>
      </form>
      <p role="status">Intake Saved</p>
    </main>`),
  '/reports': page('Release Reports', `
    <main>
      <h1>Release Reports</h1>
      <nav aria-label="Primary navigation"><a href="/">Dashboard</a><a href="/intake">Delivery Intake</a></nav>
      <section><h2>Release Readiness</h2><p>Regression Coverage: 82 percent</p><p>Blocked Stories: 2</p><button type="button">Export Report</button></section>
    </main>`),
};

http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  const html = routes[url.pathname] || routes['/'];
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(port, '127.0.0.1', () => {
  console.log(`Angular compatibility fixture listening on http://127.0.0.1:${port}`);
});
