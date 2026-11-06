import test from 'node:test';
import assert from 'node:assert/strict';

// El servidor arranca al importarse; usamos un puerto efímero.
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
const { server } = await import('../server.js');
await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

test.after(() => new Promise((resolve) => server.close(resolve)));

test('GET /api/health responde vivo', async () => {
  const res = await fetch(`${base}/api/health`);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.status, 'vivo');
});

test('GET / entrega la interfaz', async () => {
  const res = await fetch(`${base}/`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  assert.match(html, /Vecinas/i);
  assert.match(html, /id="graph"/);
});

test('GET /app.js y /styles.css se sirven con su tipo', async () => {
  const js = await fetch(`${base}/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') || '', /javascript/);
  const css = await fetch(`${base}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') || '', /text\/css/);
});

test('POST /api/analyze analiza el proyecto de ejemplo', async () => {
  const res = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'sample' }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.ok(data.report.summary.files > 5);
  assert.ok(data.report.findings.length > 5);
  assert.ok(data.report.graph.nodes.length > 5);
  assert.ok(data.report.insights.length > 0);
});

test('POST /api/analyze acepta un fragmento pegado', async () => {
  const res = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'paste', path: 'ejemplo.ts', code: 'const token = "abc123456789";\n' }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.report.files.length, 1);
  assert.equal(data.report.files[0].path, 'ejemplo.ts');
  assert.ok(data.report.findings.some((f) => f.rule === 'secret'));
});

test('POST /api/analyze rechaza peticiones sin archivos', async () => {
  const res = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'files', files: [] }),
  });
  const data = await res.json();
  assert.equal(res.status, 400);
  assert.equal(data.ok, false);
  assert.match(data.error, /archivos/i);
});

test('una ruta de API desconocida no rompe el servidor', async () => {
  const res = await fetch(`${base}/api/no-existe`);
  assert.equal(res.status, 404);
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
});
