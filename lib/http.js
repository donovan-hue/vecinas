/**
 * Cliente HTTP mínimo sobre node:https.
 *
 * Existe por dos motivos: seguir redirecciones de forma explícita y confiar
 * también en los certificados del sistema (entornos con proxy corporativo o
 * CA propia añadida al almacén del sistema). Si nada de eso aplica, se usan
 * los certificados raíz que trae Node.
 */
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import tls from 'node:tls';

const CA_CANDIDATES = [
  process.env.VECINAS_CA,
  process.env.NODE_EXTRA_CA_CERTS,
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/cert.pem',
  '/usr/local/etc/openssl/cert.pem',
];

let cachedCa;

export function loadCa() {
  if (cachedCa !== undefined) return cachedCa;
  const roots = [...(tls.rootCertificates || [])];
  for (const candidate of CA_CANDIDATES) {
    if (!candidate) continue;
    try {
      const content = fs.readFileSync(candidate, 'utf8');
      if (content.includes('BEGIN CERTIFICATE')) {
        cachedCa = [...new Set([...roots, content])];
        return cachedCa;
      }
    } catch { /* seguimos con el siguiente */ }
  }
  cachedCa = roots.length ? roots : undefined;
  return cachedCa;
}

function requestOnce(url, { headers = {}, timeout = 30000, maxBytes = 80 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'http:' ? http : https;
    const req = lib.request(
      target,
      {
        method: 'GET',
        headers: { 'User-Agent': 'vecinas-code-analyzer', 'Accept-Encoding': 'identity', ...headers },
        timeout,
        ...(target.protocol === 'https:' ? { ca: loadCa() } : {}),
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error(`La descarga supera ${Math.round(maxBytes / 1048576)} MB`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Tiempo de espera agotado al conectar con GitHub')));
    req.on('error', reject);
    req.end();
  });
}

export async function get(url, options = {}) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const res = await requestOnce(current, options);
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    return res;
  }
  throw new Error('Demasiadas redirecciones');
}

export async function getJson(url, options = {}) {
  const res = await get(url, { ...options, headers: { Accept: 'application/vnd.github+json', ...(options.headers || {}) } });
  if (res.status === 404) throw new Error('No encuentro ese recurso en GitHub (¿existe o es privado?)');
  if (res.status === 403 || res.status === 429) throw new Error('GitHub limitó las peticiones (rate limit). Espera unos minutos.');
  if (res.status < 200 || res.status >= 300) throw new Error(`GitHub respondió ${res.status}`);
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new Error('GitHub devolvió una respuesta que no pude interpretar');
  }
}

export async function getBuffer(url, options = {}) {
  const res = await get(url, options);
  if (res.status < 200 || res.status >= 300) throw new Error(`Descarga falló (${res.status})`);
  return { body: res.body, headers: res.headers };
}
