/**
 * Servidor de Vecinas: sirve la interfaz y el API de análisis.
 * Sin dependencias externas. Escucha en 0.0.0.0 para funcionar detrás de un proxy.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from './lib/analyzer.js';
import { fetchRepo } from './lib/github.js';
import { SAMPLE_FILES, SAMPLE_NAME } from './lib/samples.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY_BYTES = 25 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`El envío supera ${Math.round(MAX_BODY_BYTES / 1048576)} MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { ok: false, error: 'Ruta no permitida' });
    return;
  }
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('no es archivo');
    const ext = path.extname(filePath).toLowerCase();
    const body = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=120',
    });
    res.end(body);
  } catch {
    // SPA: cualquier ruta desconocida devuelve el index (salvo assets)
    if (!path.extname(rel)) {
      try {
        const body = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(body);
        return;
      } catch { /* cae al 404 */ }
    }
    sendJson(res, 404, { ok: false, error: 'No encontrado' });
  }
}

async function handleAnalyze(req, res) {
  let payload;
  try {
    const raw = await readBody(req);
    if (!raw) throw new Error('Cuerpo vacío');
    payload = JSON.parse(raw);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: `No pude leer la petición: ${err.message}` });
    return;
  }

  const startedAt = Date.now();
  const type = payload?.type || 'files';

  try {
    if (type === 'github') {
      const repoInput = String(payload.repo || '').trim();
      if (!repoInput) throw new Error('Falta la URL del repositorio');
      const { files, meta, skipped } = await fetchRepo(repoInput);
      if (!files.length) throw new Error('El repositorio no tiene archivos analizables');
      const report = analyzeProject(files, {
        projectName: meta.fullName,
        source: { type: 'github', label: meta.fullName, url: meta.url, branch: meta.branch, meta },
        startedAt,
      });
      report.meta.skippedFromDownload = skipped;
      sendJson(res, 200, { ok: true, report });
      return;
    }

    if (type === 'paste') {
      const code = String(payload.code || '');
      if (!code.trim()) throw new Error('No hay código que analizar');
      if (code.length > 900 * 1024) throw new Error('El código supera 900 KB');
      const fileName = String(payload.path || 'fragmento.js').trim().slice(0, 200) || 'fragmento.js';
      const report = analyzeProject([{ path: fileName, content: code }], {
        projectName: fileName,
        source: { type: 'paste', label: fileName },
        startedAt,
      });
      sendJson(res, 200, { ok: true, report });
      return;
    }

    if (type === 'sample') {
      const report = analyzeProject(SAMPLE_FILES, {
        projectName: SAMPLE_NAME,
        source: { type: 'sample', label: 'Proyecto de ejemplo' },
        startedAt,
      });
      sendJson(res, 200, { ok: true, report });
      return;
    }

    // type === 'files'
    const files = Array.isArray(payload?.files) ? payload.files : [];
    if (!files.length) throw new Error('No recibí archivos');
    const projectName = String(payload?.name || 'Proyecto').slice(0, 160) || 'Proyecto';
    const report = analyzeProject(files, {
      projectName,
      source: { type: 'files', label: projectName },
      startedAt,
    });
    if (!report.summary.files) {
      throw new Error('Ninguno de los archivos enviados se puede analizar (revisa extensiones y tamaños)');
    }
    sendJson(res, 200, { ok: true, report });
  } catch (err) {
    const message = err?.message || 'Error inesperado durante el análisis';
    const hint = /límite|rate limit|privado|No encuentro/i.test(message)
      ? 'Puedes subir los archivos manualmente desde la pestaña "Subir archivos".'
      : null;
    sendJson(res, 400, { ok: false, error: message, hint });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  try {
    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, status: 'vivo', version: '1.0.0', uptime: process.uptime() });
      return;
    }
    if (url.pathname === '/api/analyze' && req.method === 'POST') {
      await handleAnalyze(req, res);
      return;
    }
    if (url.pathname === '/api/limites') {
      const { LIMITS } = await import('./lib/analyzer.js');
      sendJson(res, 200, { ok: true, limites: LIMITS });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { ok: false, error: 'Ruta de API desconocida' });
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, url.pathname);
      return;
    }
    sendJson(res, 405, { ok: false, error: 'Método no permitido' });
  } catch (err) {
    console.error('[vecinas] error:', err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Error interno del servidor' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Vecinas escuchando en http://${HOST}:${PORT}`);
  if (process.env.NODE_ENV !== 'test') {
    console.log('Analiza un repositorio de GitHub, sube archivos o pega código.');
  }
});

export { server };

if (process.env.NODE_ENV !== 'test') {
  const shutdown = () => {
    console.log('\nCerrando Vecinas…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Evita que un fallo inesperado tumbe el servicio en silencio.
process.on('unhandledRejection', (reason) => console.error('[vecinas] promesa rechazada:', reason));

void fs;
