/**
 * Descarga de repositorios públicos de GitHub.
 * Usa api.github.com para los metadatos y codeload.github.com para el zipball,
 * así el análisis se hace con UNA descarga en lugar de cientos de peticiones.
 */
import { readZip, stripCommonPrefix } from './zip.js';
import { getJson, getBuffer } from './http.js';

const MAX_DOWNLOAD_BYTES = 60 * 1024 * 1024;

export function parseRepoInput(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Escribe la URL de un repositorio de GitHub');

  const clean = raw.replace(/\s+/g, '');
  let owner;
  let repo;
  let ref = null;

  if (clean.startsWith('git@github.com:')) {
    const [o, r] = clean.slice('git@github.com:'.length).replace(/\.git$/, '').split('/');
    owner = o; repo = r;
  } else if (/^https?:\/\//i.test(clean) || clean.startsWith('github.com/')) {
    const withProto = /^https?:\/\//i.test(clean) ? clean : `https://${clean}`;
    let url;
    try { url = new URL(withProto); } catch { throw new Error('La URL no es válida'); }
    if (!/^(www\.)?github\.com$/i.test(url.hostname)) {
      throw new Error('Por ahora solo acepto repositorios de github.com');
    }
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    owner = parts[0];
    repo = (parts[1] || '').replace(/\.git$/, '');
    const treeIdx = parts.indexOf('tree');
    const blobIdx = parts.indexOf('blob');
    const idx = treeIdx !== -1 ? treeIdx : blobIdx;
    if (idx !== -1 && parts[idx + 1]) ref = parts.slice(idx + 1).join('/');
  } else if (/^[\w.-]+\/[\w.-]+$/.test(clean)) {
    const [o, r] = clean.split('/');
    owner = o; repo = r.replace(/\.git$/, '');
  } else {
    throw new Error('Formato no reconocido. Ejemplo: https://github.com/usuario/repo');
  }

  if (!owner || !repo) throw new Error('No pude identificar usuario y repositorio en esa URL');
  return { owner, repo, ref };
}

function authHeaders() {
  const headers = { 'User-Agent': 'vecinas-code-analyzer', Accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function fetchRepo(input, { maxFileSize = 512 * 1024 } = {}) {
  const { owner, repo, ref } = parseRepoInput(input);
  const meta = await getJson(`https://api.github.com/repos/${owner}/${repo}`, { headers: authHeaders() });
  const branch = ref || meta.default_branch || 'main';

  const candidates = [
    `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`,
    `https://codeload.github.com/${owner}/${repo}/zip/${branch}`,
  ];

  let buffer = null;
  let lastError = null;
  for (const url of candidates) {
    try {
      const { body } = await getBuffer(url, { maxBytes: MAX_DOWNLOAD_BYTES });
      if (body.length > MAX_DOWNLOAD_BYTES) {
        throw new Error(`El repositorio pesa ${(body.length / 1048576).toFixed(1)} MB; el límite es ${MAX_DOWNLOAD_BYTES / 1048576} MB`);
      }
      buffer = body;
      break;
    } catch (err) {
      lastError = err;
      if (/límite es/.test(err.message)) throw err;
    }
  }

  if (!buffer) throw lastError || new Error('No pude descargar el repositorio');

  let extracted;
  try {
    extracted = readZip(buffer, { maxFileSize });
  } catch (err) {
    throw new Error(`El archivo descargado no parece un ZIP válido: ${err.message}`);
  }

  const files = stripCommonPrefix(extracted.files);

  return {
    files,
    meta: {
      owner,
      repo,
      branch,
      fullName: meta.full_name || `${owner}/${repo}`,
      description: meta.description || '',
      stars: meta.stargazers_count ?? null,
      language: meta.language || null,
      private: Boolean(meta.private),
      url: meta.html_url || `https://github.com/${owner}/${repo}`,
    },
    skipped: extracted.skipped,
  };
}
