/**
 * Motor de análisis de Vecinas.
 *
 * Recibe archivos en memoria ({path, content}) y devuelve un informe completo:
 * métricas, grafo de dependencias, hallazgos por regla, ciclos, duplicación,
 * señales de arquitectura y una estimación de riesgo por archivo.
 *
 * Todo es heurístico y determinista: no ejecuta el código analizado.
 */
import path from 'node:path';
import { detectLanguage, stripCode } from './lang.js';
import { analyzeRules, SEVERITY_WEIGHT } from './rules.js';

export const LIMITS = {
  maxFiles: 400,
  maxFileBytes: 512 * 1024,
  maxLinesPerFile: 6000,
  maxFindings: 3000,
};

const IGNORED_DIRS = new Set([
  'node_modules', 'bower_components', 'jspm_packages', 'vendor', '.git', '.hg', '.svn',
  'dist', 'build', 'out', 'coverage', '.nyc_output', '.next', '.nuxt', '.output', '.svelte-kit',
  '.turbo', '.parcel-cache', '.cache', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  '.venv', 'venv', 'env', 'site-packages', 'target', 'obj', '.idea', '.vscode', '.DS_Store',
  'Pods', 'DerivedData', 'tmp', 'temp', '.terraform', 'public/vendor', 'static/vendor',
]);

const IGNORED_FILE_RE = [
  /^package-lock\.json$/i, /^yarn\.lock$/i, /^pnpm-lock\.yaml$/i, /^composer\.lock$/i,
  /^Gemfile\.lock$/i, /^poetry\.lock$/i, /^Cargo\.lock$/i, /^go\.sum$/i, /^\.DS_Store$/i,
  /\.min\.(js|css)$/i, /\.map$/i, /\.snap$/i, /\.lock$/i,
];

const IGNORED_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tiff', 'svg',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'mp3', 'mp4', 'mov', 'avi', 'webm', 'wav', 'ogg',
  'pdf', 'zip', 'gz', 'tar', 'rar', '7z', 'jar', 'war',
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'o', 'a', 'pyc', 'pyo',
  'db', 'sqlite', 'sqlite3', 'parquet', 'csv', 'xls', 'xlsx', 'doc', 'docx', 'ppt', 'pptx',
  'psd', 'ai', 'sketch', 'fig',
]);

const ENTRY_NAMES = new Set([
  'index.js', 'index.jsx', 'index.ts', 'index.tsx', 'main.js', 'main.ts', 'main.mjs', 'main.cjs',
  'server.js', 'server.ts', 'app.js', 'app.ts', 'app.py', 'main.py', 'manage.py', '__main__.py',
  'wsgi.py', 'asgi.py', 'main.go', 'Main.java', 'Program.cs', 'index.php', 'app.rb', 'config.ru',
  'main.rs', 'lib.rs', 'index.html', 'Dockerfile',
]);

const NODE_BUILTINS = new Set([
  'fs', 'path', 'http', 'https', 'crypto', 'os', 'util', 'events', 'stream', 'url', 'zlib',
  'child_process', 'net', 'tls', 'dns', 'cluster', 'worker_threads', 'process', 'buffer',
  'assert', 'querystring', 'readline', 'string_decoder', 'timers', 'vm', 'tty', 'dgram',
  'perf_hooks', 'async_hooks', 'v8', 'module', 'repl', 'inspector', 'punycode',
]);

const SEV_ORDER = { critico: 4, alto: 3, medio: 2, bajo: 1 };

/* ------------------------------------------------------------------ */
/* 1. Preparación de archivos                                          */
/* ------------------------------------------------------------------ */

function shouldIgnorePath(relPath) {
  const parts = relPath.split('/');
  const fileName = parts[parts.length - 1];
  for (let i = 0; i < parts.length - 1; i++) {
    if (IGNORED_DIRS.has(parts[i])) return 'carpeta ignorada (' + parts[i] + ')';
  }
  for (const re of IGNORED_FILE_RE) if (re.test(fileName)) return 'archivo generado';
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (IGNORED_EXT.has(ext)) return 'archivo binario o de datos';
  if (fileName.startsWith('.') && !fileName.startsWith('.env.example')) return 'archivo oculto';
  return null;
}

export function prepareFiles(rawFiles) {
  const seen = new Set();
  const skipped = [];
  const files = [];

  const normalized = [];
  for (const raw of Array.isArray(rawFiles) ? rawFiles : []) {
    if (!raw || typeof raw.path !== 'string' || typeof raw.content !== 'string') continue;
    const clean = raw.path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/{2,}/g, '/');
    if (!clean || clean.includes('..')) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    normalized.push({ path: clean, content: raw.content });
  }

  // Primero los archivos de código: si hay que recortar, se conserva lo útil.
  const decorated = normalized.map((f) => ({ ...f, language: detectLanguage(f.path) }));
  decorated.sort((a, b) => {
    if (a.language.analyzable !== b.language.analyzable) return a.language.analyzable ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  for (const file of decorated) {
    const ignoreReason = shouldIgnorePath(file.path);
    if (ignoreReason) { skipped.push({ path: file.path, reason: ignoreReason }); continue; }

    const sizeBytes = Buffer.byteLength(file.content, 'utf8');
    if (sizeBytes > LIMITS.maxFileBytes) {
      skipped.push({ path: file.path, reason: `pesa ${(sizeBytes / 1024).toFixed(0)} KB (límite ${LIMITS.maxFileBytes / 1024} KB)` });
      continue;
    }
    if (file.content.includes('\u0000')) {
      skipped.push({ path: file.path, reason: 'contenido binario' });
      continue;
    }
    if (files.length >= LIMITS.maxFiles) {
      skipped.push({ path: file.path, reason: `fuera del límite de ${LIMITS.maxFiles} archivos` });
      continue;
    }

    let content = file.content;
    let truncated = false;
    const lineCount = content.split('\n').length;
    if (lineCount > LIMITS.maxLinesPerFile) {
      content = content.split('\n').slice(0, LIMITS.maxLinesPerFile).join('\n');
      truncated = true;
    }

    files.push({ path: file.path, content, language: file.language, sizeBytes, truncated });
  }

  return { files, skipped };
}

/* ------------------------------------------------------------------ */
/* 2. Extracción de bloques (funciones, clases) y métricas             */
/* ------------------------------------------------------------------ */

const DECISION_RE = {
  c: /\b(if|for|while|case|catch)\b|&&|\|\||\?(?![.?])/g,
  python: /\b(if|elif|for|while|except|and|or)\b/g,
  ruby: /\b(if|unless|while|until|rescue|when|and|or)\b/g,
  shell: /\b(if|for|while|until|case|elif)\b|&&|\|\|/g,
  sql: /\b(case|when|and|or|if)\b/gi,
};

function countDecisions(text, family) {
  const re = DECISION_RE[family];
  if (!re) return 0;
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

function braceDepthAt(maskedLines) {
  const depths = [];
  let depth = 0;
  for (const line of maskedLines) {
    depths.push(depth);
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  return depths;
}

function findBraceEnd(maskedLines, startIdx) {
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < maskedLines.length; i++) {
    for (const ch of maskedLines[i]) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') {
        depth--;
        if (started && depth <= 0) return i;
      }
    }
  }
  return maskedLines.length - 1;
}

function findPythonBlockEnd(lines, startIdx, baseIndent) {
  let end = startIdx;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
    if (indent <= baseIndent && !line.trim().startsWith('#')) return end;
    end = i;
  }
  return end;
}

const JS_FUNCTION_PATTERNS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*[A-Za-z_$]?[\w$]*\s*\([^)]*\)\s*\{/,
];

const JS_METHOD_RE = /^\s+(?:(?:public|private|protected|static|async|get|set|readonly|override)\s+)*#?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::\s*[^{]+)?\{/;

function extractBlocks(file, stripped) {
  const { language, content } = file;
  const lines = stripped.lines;
  const maskedLines = stripped.maskedLines;
  const blocks = [];
  const classes = [];
  const family = language.family;

  if (family === 'c' || family === 'markup' || family === 'css') {
    const depths = braceDepthAt(maskedLines);
    for (let i = 0; i < maskedLines.length; i++) {
      const masked = maskedLines[i];
      if (!masked || !masked.trim()) continue;

      if (/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.test(masked)) {
        const name = masked.match(/class\s+([A-Za-z_$][\w$]*)/)[1];
        classes.push({ name, line: i + 1, endLine: findBraceEnd(maskedLines, i) + 1 });
      }

      let name = null;
      for (const re of JS_FUNCTION_PATTERNS) {
        const m = masked.match(re);
        if (m) { name = m[1] || '(anónima)'; break; }
      }
      if (!name && depths[i] > 0) {
        const m = masked.match(JS_METHOD_RE);
        if (m && !/^\s*(if|for|while|switch|catch|return|else|do|try)\b/.test(masked.trim())) {
          name = m[1];
        }
      }
      if (!name) continue;

      const endIdx = findBraceEnd(maskedLines, i);
      const bodyMasked = maskedLines.slice(i, endIdx + 1).join('\n');
      blocks.push({
        name,
        line: i + 1,
        endLine: endIdx + 1,
        lines: endIdx - i + 1,
        complexity: 1 + countDecisions(bodyMasked, family),
      });
      i = Math.max(i, Math.min(endIdx, i)); // seguimos línea a línea: permite funciones anidadas
    }
  } else if (family === 'python') {
    for (let i = 0; i < maskedLines.length; i++) {
      const line = maskedLines[i];
      if (!line || !line.trim()) continue;
      const indent = line.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
      const defMatch = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
      if (defMatch) {
        const endIdx = findPythonBlockEnd(lines, i, indent);
        const body = maskedLines.slice(i, endIdx + 1).join('\n');
        blocks.push({
          name: defMatch[1], line: i + 1, endLine: endIdx + 1,
          lines: endIdx - i + 1, complexity: 1 + countDecisions(body, family),
        });
        continue;
      }
      const classMatch = line.match(/^\s*class\s+([A-Za-z_]\w*)/);
      if (classMatch) {
        classes.push({ name: classMatch[1], line: i + 1, endLine: findPythonBlockEnd(lines, i, indent) + 1 });
      }
    }
  } else if (family === 'ruby') {
    for (let i = 0; i < maskedLines.length; i++) {
      const line = maskedLines[i];
      const defMatch = line && line.match(/^\s*def\s+(self\.)?([A-Za-z_]\w*[?!=]?)/);
      if (!defMatch) continue;
      const indent = line.match(/^[ \t]*/)[0].length;
      let endIdx = i;
      for (let j = i + 1; j < maskedLines.length; j++) {
        const l = maskedLines[j];
        if (!l.trim()) continue;
        const ind = l.match(/^[ \t]*/)[0].length;
        if (ind === indent && /^\s*end\b/.test(l)) { endIdx = j; break; }
        endIdx = j;
      }
      const body = maskedLines.slice(i, endIdx + 1).join('\n');
      blocks.push({
        name: defMatch[2], line: i + 1, endLine: endIdx + 1,
        lines: endIdx - i + 1, complexity: 1 + countDecisions(body, family),
      });
    }
  } else if (family === 'shell') {
    for (let i = 0; i < maskedLines.length; i++) {
      const m = maskedLines[i] && maskedLines[i].match(/^\s*(?:function\s+)?([\w-]+)\s*\(\)\s*\{/);
      if (!m) continue;
      const endIdx = findBraceEnd(maskedLines, i);
      const body = maskedLines.slice(i, endIdx + 1).join('\n');
      blocks.push({
        name: m[1], line: i + 1, endLine: endIdx + 1,
        lines: endIdx - i + 1, complexity: 1 + countDecisions(body, family),
      });
    }
  }

  const maxDepth = maskedLines.reduce((acc, line) => {
    let cur = 0;
    let localMax = 0;
    for (const ch of line) {
      if (ch === '{') { cur++; localMax = Math.max(localMax, cur); }
      else if (ch === '}') cur--;
    }
    return { depth: acc.depth, max: Math.max(acc.max, localMax) };
  }, { depth: 0, max: 0 });

  let depth = 0;
  let deepest = 0;
  for (const line of maskedLines) {
    for (const ch of line) {
      if (ch === '{') { depth++; deepest = Math.max(deepest, depth); }
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  if (family === 'python') {
    for (const line of maskedLines) {
      if (!line.trim()) continue;
      const indent = line.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
      deepest = Math.max(deepest, Math.floor(indent / 4));
    }
  }

  // En Python la clase y la función ya suman dos niveles de indentación:
  // descontamos uno para comparar con lenguajes de llaves.
  const adjusted = family === 'python' ? Math.max(0, Math.max(deepest, maxDepth.max) - 1) : Math.max(deepest, maxDepth.max);
  return { blocks, classes, maxDepth: adjusted };
}

/* ------------------------------------------------------------------ */
/* 3. Imports y exports                                                */
/* ------------------------------------------------------------------ */

function extractImports(file) {
  const { content, language } = file;
  const ext = language.ext;
  const specs = new Set();
  const lines = content.split('\n');

  const addAll = (re) => {
    let m;
    let flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    if (!flags.includes('m')) flags += 'm';
    const g = new RegExp(re.source, flags);
    while ((m = g.exec(content)) !== null) {
      const spec = m[1];
      if (spec && spec.length < 250) specs.add(spec);
      if (m.index === g.lastIndex) g.lastIndex++;
    }
  };

  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte'].includes(ext)) {
    addAll(/import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/);
    addAll(/import\s+['"]([^'"]+)['"]/);
    addAll(/(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    addAll(/export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/);
  } else if (ext === 'py' || ext === 'pyi') {
    addAll(/^[ \t]*from\s+([\w.]+)\s+import\s+/);
    addAll(/^[ \t]*import\s+([\w.]+)/);
  } else if (ext === 'go') {
    let m;
    const g = /^\s*(?:import\s+)?(?:[\w.]+\s+)?"([\w./-]+)"\s*$/gm;
    while ((m = g.exec(content)) !== null) specs.add(m[1]);
  } else if (ext === 'java' || ext === 'kt' || ext === 'kts' || ext === 'scala' || ext === 'cs') {
    addAll(/^\s*(?:import|using)\s+(?:static\s+)?([\w.]+)\s*;?/);
  } else if (['c', 'h', 'cpp', 'cc', 'cxx', 'hpp'].includes(ext)) {
    addAll(/#include\s+[<"]([^>"]+)[>"]/);
  } else if (ext === 'php') {
    addAll(/^\s*(?:require|require_once|include|include_once)\s*\(?\s*['"]([^'"]+)['"]/);
    addAll(/^\s*use\s+([\w\\]+)\s*;/);
  } else if (ext === 'rb') {
    addAll(/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/);
  } else if (ext === 'rs') {
    addAll(/^\s*(?:use|mod)\s+(?:crate::)?([\w:]+)/);
  } else if (ext === 'sh' || ext === 'bash' || ext === 'zsh') {
    addAll(/^\s*(?:source|\.)\s+["']?([^\s"']+)["']?/);
  }

  const exports = new Set();
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'].includes(ext)) {
    for (const line of lines) {
      const m = line.match(/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/);
      if (m) exports.add(m[1]);
      const def = line.match(/^\s*export\s+default\s+([A-Za-z_$][\w$]*)/);
      if (def) exports.add(def[1]);
      const braces = line.match(/^\s*export\s*\{([^}]*)\}/);
      if (braces) {
        for (const piece of braces[1].split(',')) {
          const nm = piece.trim().split(/\s+as\s+/).pop();
          if (nm) exports.add(nm);
        }
      }
      const modExports = line.match(/module\.exports\s*=\s*(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))/);
      if (modExports) {
        if (modExports[1]) {
          for (const piece of modExports[1].split(',')) {
            const nm = piece.trim().split(':')[0].trim();
            if (nm) exports.add(nm);
          }
        } else if (modExports[2]) exports.add(modExports[2]);
      }
      const single = line.match(/module\.exports\.([A-Za-z_$][\w$]*)\s*=/);
      if (single) exports.add(single[1]);
    }
  } else if (ext === 'py') {
    for (const line of lines) {
      const m = line.match(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/);
      if (m && !m[1].startsWith('_')) exports.add(m[1]);
    }
  } else if (ext === 'go') {
    for (const line of lines) {
      const m = line.match(/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)\s*\(/);
      if (m) exports.add(m[1]);
    }
  } else if (ext === 'rb') {
    for (const line of lines) {
      const m = line.match(/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/);
      if (m) exports.add(m[1]);
    }
  }

  return { imports: Array.from(specs), exports: Array.from(exports) };
}

function packageNameOf(spec) {
  if (!spec) return null;
  if (spec.startsWith('node:')) return null;
  const clean = spec.replace(/^['"]|['"]$/g, '');
  if (!clean) return null;
  const parts = clean.split('/');
  if (clean.startsWith('@')) return parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
  if (spec.startsWith('#') || spec.startsWith('~')) return null;
  return parts[0];
}

function resolveImport(fromPath, spec, pathSet, language) {
  const dir = path.posix.dirname(fromPath);
  const candidates = [];
  const tryPaths = (base) => {
    const exts = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.vue', '.svelte', '.css', '.scss', '.py', '.rb', '.php', '.go', '.java', '.cs', '.rs'];
    for (const ext of exts) candidates.push(base.endsWith(ext) && ext ? base : base + ext);
    for (const ext of exts.filter(Boolean)) candidates.push(`${base}/index${ext}`);
  };

  if (language.ext === 'py' || language.ext === 'pyi') {
    const isRelative = spec.startsWith('.');
    if (isRelative) {
      const dots = (spec.match(/^\.+/) || [''])[0].length;
      const rest = spec.slice(dots).replace(/\./g, '/');
      let base = dir;
      for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
      const target = rest ? `${base}/${rest}` : base;
      tryPaths(target);
    } else {
      const p = spec.replace(/\./g, '/');
      tryPaths(p);
      tryPaths(`${dir}/${p.split('/')[0]}`);
    }
  } else if (spec.startsWith('.')) {
    tryPaths(path.posix.normalize(`${dir}/${spec}`));
  } else if (spec.startsWith('@/') || spec.startsWith('~/')) {
    const rest = spec.slice(2);
    tryPaths(rest);
    tryPaths(`src/${rest}`);
  } else if (spec.startsWith('/')) {
    tryPaths(spec.slice(1));
  } else {
    // Go / Java / PHP con namespaces: buscar por ruta conocida.
    const dotted = spec.replace(/\\/g, '/').replace(/\./g, '/').replace(/^\/+/, '');
    tryPaths(dotted);
  }

  for (const candidate of candidates) {
    const norm = candidate.replace(/\/{2,}/g, '/').replace(/^\.\//, '');
    if (pathSet.has(norm)) return { resolved: norm };
  }

  // Includes de C por nombre de archivo.
  if (['c', 'h', 'cpp', 'cc', 'cxx', 'hpp'].includes(language.ext)) {
    for (const p of pathSet) if (p.endsWith('/' + spec) || p === spec) return { resolved: p };
  }

  // Python con src/ u otras raíces: buscar por sufijo de módulo.
  if (language.ext === 'py' || language.ext === 'pyi') {
    const modulePath = spec.replace(/^\.+/, '').replace(/\./g, '/');
    if (modulePath) {
      for (const candidate of [`${modulePath}.py`, `${modulePath}/__init__.py`]) {
        for (const p of pathSet) {
          if (p === candidate || p.endsWith('/' + candidate)) return { resolved: p };
        }
      }
    }
  }

  if (spec.startsWith('node:')) return { external: null, builtin: spec.slice(5) };
  const pkg = packageNameOf(spec);
  if (pkg && NODE_BUILTINS.has(pkg)) return { external: null, builtin: pkg };
  return { external: pkg || spec };
}

/* ------------------------------------------------------------------ */
/* 4. Grafo, ciclos, duplicación                                       */
/* ------------------------------------------------------------------ */

function buildGraph(files) {
  const pathSet = new Set(files.map((f) => f.path));
  const byPath = new Map(files.map((f) => [f.path, f]));

  for (const file of files) {
    file.edges = [];
    file.externalDeps = new Map();
    for (const spec of file.rawImports) {
      const res = resolveImport(file.path, spec, pathSet, file.language);
      if (res.resolved && res.resolved !== file.path) {
        file.edges.push({ target: res.resolved, raw: spec });
        byPath.get(res.resolved).fanIn++;
        file.fanOut++;
      } else if (res.external) {
        file.externalDeps.set(res.external, (file.externalDeps.get(res.external) || 0) + 1);
      }
    }
    file.externalDeps = Array.from(file.externalDeps.entries()).map(([name, count]) => ({ name, count }));
  }
}

function findCycles(files) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const state = new Map(); // 0 = nuevo, 1 = en pila, 2 = listo
  const stack = [];
  const cycles = [];
  const seenCycles = new Set();

  const visit = (p) => {
    state.set(p, 1);
    stack.push(p);
    const node = byPath.get(p);
    for (const edge of node ? node.edges : []) {
      const t = edge.target;
      if (!byPath.has(t)) continue;
      const st = state.get(t) || 0;
      if (st === 0) visit(t);
      else if (st === 1) {
        const start = stack.indexOf(t);
        if (start !== -1) {
          const cycle = stack.slice(start);
          const key = [...cycle].sort().join('|');
          if (!seenCycles.has(key)) {
            seenCycles.add(key);
            cycles.push(cycle);
            for (const member of cycle) {
              const f = byPath.get(member);
              if (f) f.inCycle = true;
            }
          }
        }
      }
    }
    stack.pop();
    state.set(p, 2);
  };

  for (const f of files) if (!state.get(f.path)) visit(f.path);
  return cycles;
}

function normalizeCodeLine(line) {
  return line.trim().replace(/\s+/g, ' ');
}

function detectDuplication(files, windowSize = 6) {
  const windows = new Map(); // hash -> [{path, line}]
  for (const file of files) {
    if (!file.language.analyzable || file.language.family === 'data') continue;
    const useful = [];
    file.stripped.maskedLines.forEach((line, idx) => {
      const norm = normalizeCodeLine(line);
      if (norm.length >= 12 && !/^[})\];,]+$/.test(norm)) {
        useful.push({ norm, line: idx + 1 });
      }
    });
    for (let i = 0; i + windowSize <= useful.length; i++) {
      const chunk = useful.slice(i, i + windowSize);
      // Sólo cuentan como duplicado si las líneas son consecutivas en el archivo.
      let consecutive = true;
      for (let k = 1; k < chunk.length; k++) if (chunk[k].line !== chunk[k - 1].line + 1) { consecutive = false; break; }
      if (!consecutive) continue;
      const key = chunk.map((c) => c.norm).join('\n');
      if (!windows.has(key)) windows.set(key, []);
      windows.get(key).push({ path: file.path, line: chunk[0].line, endLine: chunk[chunk.length - 1].line });
    }
  }

  const blocks = [];
  const dupLinesByFile = new Map();
  for (const [, occurrences] of windows) {
    if (occurrences.length < 2) continue;
    const distinct = new Set(occurrences.map((o) => `${o.path}:${o.line}`));
    if (distinct.size < 2) continue;
    const distinctFiles = new Set(occurrences.map((o) => o.path));
    if (distinctFiles.size === 1 && occurrences.length < 2) continue;
    blocks.push({ occurrences: occurrences.slice(0, 8), count: occurrences.length, lines: windowSize });
    for (const occ of occurrences) {
      const set = dupLinesByFile.get(occ.path) || new Set();
      for (let l = occ.line; l <= occ.endLine; l++) set.add(l);
      dupLinesByFile.set(occ.path, set);
    }
  }

  blocks.sort((a, b) => b.count - a.count);
  return { blocks: blocks.slice(0, 40), dupLinesByFile, blockCount: blocks.length };
}

/* ------------------------------------------------------------------ */
/* 5. Stack tecnológico y arquitectura                                 */
/* ------------------------------------------------------------------ */

function detectStack(files) {
  const stack = [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const read = (p) => byPath.get(p)?.content || null;
  const hasFile = (re) => files.some((f) => re.test(f.path));

  const add = (name, kind, evidence) => {
    if (!stack.some((s) => s.name === name)) stack.push({ name, kind, evidence });
  };

  const pkgRaw = read('package.json');
  if (pkgRaw) {
    add('Node.js', 'runtime', 'package.json');
    try {
      const pkg = JSON.parse(pkgRaw);
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const known = {
        react: ['React', 'frontend'], next: ['Next.js', 'framework'], vue: ['Vue', 'frontend'],
        nuxt: ['Nuxt', 'framework'], svelte: ['Svelte', 'frontend'], '@sveltejs/kit': ['SvelteKit', 'framework'],
        express: ['Express', 'backend'], fastify: ['Fastify', 'backend'], koa: ['Koa', 'backend'],
        '@nestjs/core': ['NestJS', 'backend'], vite: ['Vite', 'build'], webpack: ['Webpack', 'build'],
        typescript: ['TypeScript', 'lenguaje'], tailwindcss: ['Tailwind CSS', 'estilos'],
        prisma: ['Prisma', 'base de datos'], '@prisma/client': ['Prisma', 'base de datos'],
        mongoose: ['Mongoose', 'base de datos'], sequelize: ['Sequelize', 'base de datos'],
        jest: ['Jest', 'pruebas'], vitest: ['Vitest', 'pruebas'], mocha: ['Mocha', 'pruebas'],
        playwright: ['Playwright', 'pruebas'], '@playwright/test': ['Playwright', 'pruebas'],
        cypress: ['Cypress', 'pruebas'], eslint: ['ESLint', 'calidad'], axios: ['Axios', 'cliente HTTP'],
        graphql: ['GraphQL', 'API'], socket: ['Sockets', 'tiempo real'], 'socket.io': ['Socket.IO', 'tiempo real'],
        electron: ['Electron', 'escritorio'], react_native: ['React Native', 'móvil'],
        'react-native': ['React Native', 'móvil'], redux: ['Redux', 'estado'], zustand: ['Zustand', 'estado'],
      };
      for (const dep of Object.keys(deps)) {
        if (known[dep]) add(known[dep][0], known[dep][1], `package.json · ${dep}`);
      }
    } catch { /* package.json inválido: seguimos */ }
  }

  if (hasFile(/(^|\/)requirements\.txt$|(^|\/)pyproject\.toml$|(^|\/)Pipfile$/)) add('Python', 'runtime', 'requirements.txt / pyproject.toml');
  if (hasFile(/(^|\/)go\.mod$/)) add('Go', 'runtime', 'go.mod');
  if (hasFile(/(^|\/)Cargo\.toml$/)) add('Rust', 'runtime', 'Cargo.toml');
  if (hasFile(/(^|\/)composer\.json$/)) add('PHP', 'runtime', 'composer.json');
  if (hasFile(/(^|\/)Gemfile$/)) add('Ruby', 'runtime', 'Gemfile');

  const pyReq = read('requirements.txt') || '';
  for (const [dep, name] of [['django', 'Django'], ['flask', 'Flask'], ['fastapi', 'FastAPI'], ['pandas', 'Pandas'], ['numpy', 'NumPy'], ['torch', 'PyTorch'], ['tensorflow', 'TensorFlow'], ['sqlalchemy', 'SQLAlchemy'], ['pytest', 'pytest']]) {
    if (new RegExp(`^${dep}`, 'im').test(pyReq)) add(name, dep === 'pytest' ? 'pruebas' : 'librería', 'requirements.txt');
  }

  if (hasFile(/(^|\/)Dockerfile$/)) add('Docker', 'infraestructura', 'Dockerfile');
  if (hasFile(/(^|\/)docker-compose\.ya?ml$/)) add('Docker Compose', 'infraestructura', 'docker-compose.yml');
  if (hasFile(/^\.github\/workflows\/.+\.ya?ml$/)) add('GitHub Actions', 'CI/CD', '.github/workflows');
  if (hasFile(/(^|\/)terraform\/|\.tf$/)) add('Terraform', 'infraestructura', '*.tf');
  if (hasFile(/(^|\/)schema\.prisma$/)) add('Prisma', 'base de datos', 'schema.prisma');
  if (hasFile(/(^|\/)\.env(\.example)?$/)) add('Variables de entorno', 'configuración', '.env');

  return stack;
}

function detectEntryPoints(files) {
  const entries = [];
  for (const f of files) {
    const base = path.posix.basename(f.path);
    const isKnown = ENTRY_NAMES.has(base) && f.language.analyzable;
    const shebang = /^#!.*\b(node|python3?|bash|sh|ruby|php)\b/.test(f.content.slice(0, 120));
    const pkgMain = base === 'package.json' && /"main"\s*:/.test(f.content);
    if (isKnown || shebang) entries.push({ path: f.path, reason: shebang ? 'shebang ejecutable' : 'nombre de entrada habitual' });
    else if (pkgMain) entries.push({ path: f.path, reason: 'define "main" en package.json' });
  }
  return entries.slice(0, 20);
}

function detectAreas(files) {
  const areas = new Map();
  for (const f of files) {
    const parts = f.path.split('/');
    const key = parts.length > 1 ? parts[0] : '(raíz)';
    if (!areas.has(key)) areas.set(key, { name: key, files: 0, codeLines: 0, riskSum: 0 });
    const area = areas.get(key);
    area.files++;
    area.codeLines += f.codeLines;
    area.riskSum += f.risk;
  }
  return Array.from(areas.values())
    .map((a) => ({ name: a.name, files: a.files, codeLines: a.codeLines, risk: Math.round(a.riskSum / a.files) }))
    .sort((a, b) => b.codeLines - a.codeLines)
    .slice(0, 12);
}

/* ------------------------------------------------------------------ */
/* 6. Riesgo por archivo                                               */
/* ------------------------------------------------------------------ */

function computeFileRisk(file, stats) {
  const reasons = [];
  let score = 0;

  if (file.complexity > 1) {
    const fnCount = file.functions.length;
    const signal = fnCount ? file.complexity / fnCount : Math.min(40, file.codeLines / 30);
    const complexityPoints = Math.min(28, signal * 2.2);
    if (complexityPoints >= 3) {
      reasons.push({
        label: 'Complejidad',
        points: Math.round(complexityPoints),
        detail: fnCount
          ? `${signal.toFixed(1)} caminos por función (${file.complexity} en ${fnCount})`
          : `${file.complexity} caminos sin funciones identificadas`,
      });
    }
    score += complexityPoints;
  }

  const severitySum = file.findings.reduce((acc, f) => acc + (SEVERITY_WEIGHT[f.severity] || 0), 0);
  if (severitySum > 0) {
    const points = Math.min(28, severitySum * 1.8);
    score += points;
    const critical = file.findings.filter((f) => f.severity === 'critico').length;
    const high = file.findings.filter((f) => f.severity === 'alto').length;
    reasons.push({
      label: 'Hallazgos',
      points: Math.round(points),
      detail: [critical ? `${critical} crítico(s)` : '', high ? `${high} alto(s)` : ''].filter(Boolean).join(' · ') || `${file.findings.length} hallazgo(s)`,
    });
  }

  if (file.codeLines > 250) {
    const points = Math.min(12, ((file.codeLines - 250) / 750) * 12 + 3);
    score += points;
    reasons.push({ label: 'Tamaño', points: Math.round(points), detail: `${file.codeLines} líneas de código en un archivo` });
  }

  if (file.inCycle) {
    score += 12;
    reasons.push({ label: 'Ciclo de imports', points: 12, detail: 'participa en una dependencia circular' });
  }

  if (file.fanIn > 0) {
    const points = Math.min(10, file.fanIn * 2);
    score += points;
    if (points >= 4) reasons.push({ label: 'Centralidad', points: Math.round(points), detail: `${file.fanIn} archivo(s) dependen de éste` });
  }

  if (!stats.hasTests) {
    score += 6;
    reasons.push({ label: 'Sin pruebas', points: 6, detail: 'el proyecto no incluye pruebas automatizadas' });
  } else if (!stats.testedFiles.has(file.path)) {
    score += 2;
  }

  if (file.dupLines > 0 && file.codeLines > 0) {
    const points = Math.min(10, (file.dupLines / file.codeLines) * 14);
    score += points;
    if (points >= 2) reasons.push({ label: 'Duplicación', points: Math.round(points), detail: `${file.dupLines} línea(s) repetidas` });
  }

  const risk = Math.max(0, Math.min(100, Math.round(score)));
  reasons.sort((a, b) => b.points - a.points);
  return { risk, reasons: reasons.slice(0, 4) };
}

function predictFailure(file) {
  const top = file.findings.filter((f) => f.severity === 'critico' || f.severity === 'alto');
  if (top.length) {
    const kinds = Array.from(new Set(top.map((f) => f.title))).slice(0, 2);
    return `Falla probable en ${kinds.join(' / ').toLowerCase()}.`;
  }
  if (file.inCycle) return 'Recarga o importación circular: puede romper el arranque o dejar exports vacíos.';
  if (file.complexity > 30) return 'Demasiadas ramas: casos límite sin cubrir y regresiones al modificar.';
  if (file.codeLines > 400) return 'Archivo extenso: cambios laterales inesperados al editar.';
  if (file.fanIn >= 4) return 'Nodo central: un error aquí se propaga a varios módulos.';
  return 'Riesgo bajo: mantenimiento normal.';
}

/* ------------------------------------------------------------------ */
/* 7. Informe final                                                    */
/* ------------------------------------------------------------------ */

function gradeFrom(risk) {
  if (risk <= 15) return { grade: 'A', label: 'Sólido' };
  if (risk <= 30) return { grade: 'B', label: 'Sano' };
  if (risk <= 48) return { grade: 'C', label: 'Regular' };
  if (risk <= 66) return { grade: 'D', label: 'Frágil' };
  return { grade: 'E', label: 'Crítico' };
}

export function analyzeProject(rawFiles, { projectName = 'Proyecto', source = null, startedAt = Date.now() } = {}) {
  const { files: prepared, skipped } = prepareFiles(rawFiles);
  const hasTests = prepared.some((f) => /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[a-z]+$|_test\.py$|(^|\/)test_.*\.py$/.test(f.path));
  const testedFiles = new Set(
    prepared.filter((f) => /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[a-z]+$|_test\.py$|(^|\/)test_.*\.py$/.test(f.path)).map((f) => f.path),
  );

  const files = prepared.map((f) => {
    const stripped = stripCode(f.content, f.language.family);
    const { blocks, classes, maxDepth } = extractBlocks(f, stripped);
    const { imports, exports } = extractImports(f);
    const decisions = countDecisions(stripped.masked, f.language.family);
    const complexity = 1 + decisions;
    const functions = blocks.slice(0, 400);
    const longest = functions.reduce((acc, b) => (b.lines > (acc?.lines || 0) ? b : acc), null);

    const isCode = f.language.isCode;
    return {
      path: f.path,
      content: f.content,
      language: f.language,
      isCode,
      sizeBytes: f.sizeBytes,
      truncated: f.truncated,
      lines: stripped.totalLines,
      codeLines: isCode ? stripped.codeLines : 0,
      rawCodeLines: stripped.codeLines,
      commentLines: stripped.commentOnly,
      blankLines: stripped.blankLines,
      functions,
      classes,
      complexity,
      avgFunctionComplexity: blocks.length ? Math.round((complexity / blocks.length) * 10) / 10 : 0,
      maxDepth,
      longestFunction: longest ? { name: longest.name, lines: longest.lines, line: longest.line } : null,
      rawImports: imports,
      exports,
      stripped,
      findings: [],
      fanIn: 0,
      fanOut: 0,
      inCycle: false,
      isTest: testedFiles.has(f.path),
      risk: 0,
      riskReasons: [],
      dupLines: 0,
      externalDeps: [],
      edges: [],
    };
  });

  // Reglas sobre cada archivo.
  for (const file of files) {
    file.findings = analyzeRules(file, { hasTests });
  }

  buildGraph(files);
  const cycles = findCycles(files);

  // Cada archivo que participa en un ciclo se marca también como hallazgo.
  const cycleOf = new Map();
  for (const cycle of cycles) for (const member of cycle) cycleOf.set(member, cycle);
  for (const file of files) {
    if (!file.inCycle) continue;
    const cycle = cycleOf.get(file.path) || [];
    file.findings.push({
      rule: 'ciclo-dependencia',
      severity: 'alto',
      category: 'mantenibilidad',
      title: 'Dependencia circular',
      detail: `Este archivo forma parte de un ciclo (${cycle.join(' → ')}). Al importarse mutuamente, uno de los dos se evalúa a medio construir: exports vacíos o undefined.`,
      fix: 'Rompe el ciclo extrayendo lo compartido a un módulo neutral o inyectando la dependencia.',
      path: file.path,
      line: null,
      snippet: '',
    });
  }

  const { blocks: dupBlocks, dupLinesByFile, blockCount } = detectDuplication(files);
  for (const file of files) {
    file.dupLines = dupLinesByFile.get(file.path)?.size || 0;
    delete file.stripped; // ya no se necesita: el código original no se devuelve al cliente
  }

  const entries = detectEntryPoints(files);
  const entryPaths = new Set(entries.map((e) => e.path));
  for (const file of files) {
    file.isEntry = entryPaths.has(file.path);
  }

  const stats = { hasTests, testedFiles };
  for (const file of files) {
    const { risk, reasons } = computeFileRisk(file, stats);
    file.risk = risk;
    file.riskReasons = reasons;
    file.prediction = predictFailure(file);
    delete file.rawImports;
  }

  const totalCodeLines = files.reduce((acc, f) => acc + f.codeLines, 0);
  const totalLines = files.reduce((acc, f) => acc + f.lines, 0);
  const totalFunctions = files.reduce((acc, f) => acc + f.functions.length, 0);
  const totalComplexity = files.reduce((acc, f) => acc + f.complexity, 0);

  const findings = files.flatMap((f) => f.findings);
  const bySeverity = { critico: 0, alto: 0, medio: 0, bajo: 0 };
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;

  // Riesgo global: mezcla de los archivos más riesgosos y la densidad de hallazgos.
  const sortedRisks = files.map((f) => f.risk).sort((a, b) => b - a);
  const topSlice = sortedRisks.slice(0, Math.max(1, Math.ceil(sortedRisks.length * 0.25)));
  const topAvg = topSlice.reduce((a, b) => a + b, 0) / (topSlice.length || 1);
  const allAvg = sortedRisks.reduce((a, b) => a + b, 0) / (sortedRisks.length || 1);
  // Densidad de hallazgos por archivo (no por línea): evita castigar proyectos grandes.
  const weightSum = findings.reduce((acc, f) => acc + (SEVERITY_WEIGHT[f.severity] || 0), 0);
  const perFileWeight = files.length ? weightSum / files.length : 0;
  const densityPoints = Math.min(30, perFileWeight * 1.2);
  const cyclePoints = Math.min(12, cycles.length * 6);
  const overallRisk = Math.round(Math.min(100, topAvg * 0.55 + allAvg * 0.2 + densityPoints + cyclePoints));
  const { grade, label } = gradeFrom(overallRisk);

  const languages = new Map();
  for (const f of files) {
    if (!f.isCode) continue;
    const key = f.language.name;
    if (!languages.has(key)) languages.set(key, { name: key, color: f.language.color, files: 0, codeLines: 0 });
    const l = languages.get(key);
    l.files++;
    l.codeLines += f.codeLines;
  }
  const languageList = Array.from(languages.values())
    .map((l) => ({ ...l, pct: totalCodeLines ? Math.round((l.codeLines / totalCodeLines) * 100) : 0 }))
    .sort((a, b) => b.codeLines - a.codeLines);

  const externalMap = new Map();
  for (const f of files) {
    for (const dep of f.externalDeps) {
      const entry = externalMap.get(dep.name) || { name: dep.name, imports: 0, files: 0 };
      entry.imports += dep.count;
      entry.files++;
      externalMap.set(dep.name, entry);
    }
  }
  const externalDependencies = Array.from(externalMap.values()).sort((a, b) => b.imports - a.imports).slice(0, 60);

  const graphNodes = files.slice(0, 120).map((f) => ({
    id: f.path,
    label: path.posix.basename(f.path),
    risk: f.risk,
    lang: f.language.id,
    color: f.language.color,
    loc: f.codeLines,
    fanIn: f.fanIn,
    fanOut: f.fanOut,
    inCycle: f.inCycle,
    isEntry: f.isEntry,
    isTest: f.isTest,
  }));
  const nodeIds = new Set(graphNodes.map((n) => n.id));
  const graphEdges = [];
  for (const f of files) {
    for (const e of f.edges) {
      if (nodeIds.has(f.path) && nodeIds.has(e.target)) {
        graphEdges.push({ source: f.path, target: e.target, raw: e.raw });
      }
    }
  }

  const insights = buildInsights({ files, findings, bySeverity, cycles, entries, externalDependencies, hasTests, totalCodeLines, dupBlocks, blockCount });

  const publicFiles = files.map((f) => ({
    path: f.path,
    language: { id: f.language.id, name: f.language.name, color: f.language.color, family: f.language.family },
    sizeBytes: f.sizeBytes,
    truncated: f.truncated,
    isCode: f.isCode,
    lines: f.lines,
    codeLines: f.codeLines,
    displayLines: f.codeLines || f.rawCodeLines,
    commentLines: f.commentLines,
    blankLines: f.blankLines,
    functionsCount: f.functions.length,
    functions: f.functions.slice(0, 40),
    classes: f.classes.slice(0, 20),
    complexity: f.complexity,
    avgFunctionComplexity: f.avgFunctionComplexity,
    maxDepth: f.maxDepth,
    longestFunction: f.longestFunction,
    imports: f.edges.map((e) => ({ raw: e.raw, target: e.target })),
    externalImports: f.externalDeps,
    exports: f.exports.slice(0, 60),
    fanIn: f.fanIn,
    fanOut: f.fanOut,
    inCycle: f.inCycle,
    isEntry: f.isEntry,
    isTest: f.isTest,
    risk: f.risk,
    riskReasons: f.riskReasons,
    prediction: f.prediction,
    dupLines: f.dupLines,
    findingCount: f.findings.length,
    topFindings: f.findings
      .slice()
      .sort((a, b) => SEV_ORDER[b.severity] - SEV_ORDER[a.severity])
      .slice(0, 6)
      .map((x) => ({ rule: x.rule, severity: x.severity, title: x.title, line: x.line })),
  }));

  return {
    meta: {
      projectName,
      source,
      analyzedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      limits: LIMITS,
      skipped: skipped.slice(0, 60),
      skippedCount: skipped.length,
      languages: languageList,
    },
    summary: {
      files: files.length,
      codeLines: totalCodeLines,
      totalLines,
      functions: totalFunctions,
      complexity: totalComplexity,
      avgComplexity: files.length ? Math.round((totalComplexity / files.length) * 10) / 10 : 0,
      findings: { ...bySeverity, total: findings.length },
      risk: overallRisk,
      salud: 100 - overallRisk,
      grade,
      gradeLabel: label,
      avgFileRisk: Math.round(allAvg),
      hasTests,
    },
    graph: { nodes: graphNodes, edges: graphEdges, truncated: files.length > graphNodes.length },
    cycles: cycles.slice(0, 20),
    duplication: {
      blocks: dupBlocks.map((b) => ({ count: b.count, lines: b.lines, occurrences: b.occurrences })),
      blockCount,
      percent: totalCodeLines ? Math.round((Array.from(dupLinesByFile.values()).reduce((a, s) => a + s.size, 0) / totalCodeLines) * 100) : 0,
    },
    findings: findings
      .sort((a, b) => SEV_ORDER[b.severity] - SEV_ORDER[a.severity] || a.path.localeCompare(b.path))
      .slice(0, LIMITS.maxFindings),
    insights,
    files: publicFiles.sort((a, b) => b.risk - a.risk),
    entries,
    areas: detectAreas(files),
    stack: detectStack(files),
    externalDependencies,
  };
}

function buildInsights({ files, findings, bySeverity, cycles, entries, externalDependencies, hasTests, totalCodeLines, dupBlocks, blockCount }) {
  const insights = [];
  const push = (insight) => insights.push(insight);

  const secrets = findings.filter((f) => f.rule === 'secret');
  if (secrets.length) {
    push({
      id: 'secretos', severity: 'critico', icon: 'llave',
      title: 'Posibles credenciales dentro del código',
      detail: `Detecté ${secrets.length} asignación(es) con pinta de secreto. Si el repositorio es público, esas llaves ya deben considerarse comprometidas.`,
      action: 'Muévelas a variables de entorno y rota las llaves.',
      evidence: secrets.slice(0, 4).map((f) => ({ path: f.path, line: f.line })),
    });
  }

  if (cycles.length) {
    push({
      id: 'ciclos', severity: 'alto', icon: 'bucle',
      title: `${cycles.length} dependencia(s) circular(es)`,
      detail: 'Dos o más módulos se importan entre sí. Al cargarse, uno recibe el otro a medio construir: exports vacíos, undefined y fallos intermitentes difíciles de reproducir.',
      action: 'Extrae el código compartido a un módulo de utilidades o usa inyección de dependencias.',
      evidence: cycles.slice(0, 3).map((c) => ({ path: c.join(' → '), line: null })),
    });
  }

  const silent = findings.filter((f) => f.rule === 'js-empty-catch' || f.rule === 'py-except-pass' || f.rule === 'js-catch-silent');
  if (silent.length) {
    push({
      id: 'silenciados', severity: 'alto', icon: 'silencio',
      title: `${silent.length} error(es) silenciado(s)`,
      detail: 'Hay bloques catch/except que no registran ni propagan la excepción. El programa sigue como si nada y el fallo aparece mucho después, lejos del origen.',
      action: 'Registra el error o vuelve a lanzarlo; si de verdad es opcional, deja un comentario explicando por qué.',
      evidence: silent.slice(0, 4).map((f) => ({ path: f.path, line: f.line })),
    });
  }

  const complexFiles = files
    .filter((f) => f.avgFunctionComplexity >= 12 && !['css', 'markup'].includes(f.language.family))
    .sort((a, b) => b.avgFunctionComplexity - a.avgFunctionComplexity);
  if (complexFiles.length) {
    const worst = complexFiles[0];
    push({
      id: 'complejidad', severity: worst.avgFunctionComplexity >= 24 ? 'alto' : 'medio', icon: 'ramas',
      title: `${complexFiles.length} archivo(s) con complejidad alta`,
      detail: `El más cargado es ${worst.path}: ${worst.avgFunctionComplexity} caminos por función de media. Cada rama extra es un camino que puede no estar probado.`,
      action: 'Divide en funciones pequeñas con una sola responsabilidad.',
      evidence: complexFiles.slice(0, 4).map((f) => ({ path: f.path, line: null })),
    });
  }

  if (!hasTests) {
    push({
      id: 'sin-pruebas', severity: totalCodeLines > 400 ? 'alto' : 'medio', icon: 'pruebas',
      title: 'No hay pruebas automatizadas',
      detail: 'Ningún archivo de prueba en lo analizado. Sin red de seguridad, cualquier cambio es una apuesta: los errores se descubren en producción.',
      action: 'Empieza por pruebas de los módulos con más riesgo de la lista.',
      evidence: [],
    });
  }

  const orphans = files.filter((f) => f.fanIn === 0 && !f.isEntry && !f.isTest && f.language.analyzable && f.codeLines > 25 && !f.isConfig);
  if (orphans.length >= 2) {
    push({
      id: 'huerfanos', severity: 'medio', icon: 'huerfano',
      title: `${orphans.length} archivo(s) que nadie importa`,
      detail: 'Código que no entra por ningún camino conocido: o es código muerto, o se carga de forma dinámica y el análisis no lo ve. En ambos casos envejece sin que nadie lo note.',
      action: 'Borra lo que no se use; documenta lo que se cargue dinámicamente.',
      evidence: orphans.slice(0, 5).map((f) => ({ path: f.path, line: null })),
    });
  }

  const hubs = files.filter((f) => f.fanIn >= 4).sort((a, b) => b.fanIn - a.fanIn);
  if (hubs.length) {
    push({
      id: 'hubs', severity: 'medio', icon: 'nucleo',
      title: `${hubs.length} archivo(s) concentran las dependencias`,
      detail: `${hubs[0].path} lo importan ${hubs[0].fanIn} archivos. Es el punto donde un cambio pequeño se convierte en un fallo general.`,
      action: 'Trátalo como API estable: cambios compatibles y pruebas antes de tocarlo.',
      evidence: hubs.slice(0, 4).map((f) => ({ path: f.path, line: null })),
    });
  }

  if (blockCount > 0) {
    push({
      id: 'duplicacion', severity: blockCount > 8 ? 'medio' : 'bajo', icon: 'copias',
      title: `${blockCount} bloque(s) de código duplicado`,
      detail: 'La misma lógica en varios lugares: al corregir un error en una copia, las demás siguen fallando.',
      action: 'Unifica en una función compartida.',
      evidence: dupBlocks.slice(0, 3).map((b) => ({ path: b.occurrences[0].path, line: b.occurrences[0].line })),
    });
  }

  const riskyDeps = externalDependencies.filter((d) => d.name === 'lodash' || d.name === 'moment' || d.name === 'request');
  if (riskyDeps.length) {
    push({
      id: 'deps', severity: 'bajo', icon: 'paquete',
      title: 'Dependencias pesadas o sin mantenimiento',
      detail: `${riskyDeps.map((d) => d.name).join(', ')}: revisa si siguen mantenidas o si el estándar actual ya las cubre.`,
      action: 'Evalúa alternativas nativas antes de la próxima actualización.',
      evidence: riskyDeps.map((d) => ({ path: `imports: ${d.name}`, line: null })),
    });
  }

  const todoCount = findings.filter((f) => f.rule === 'todo').length;
  if (todoCount >= 3) {
    push({
      id: 'todos', severity: 'bajo', icon: 'nota',
      title: `${todoCount} pendientes marcados (TODO/FIXME)`,
      detail: 'Son deudas anotadas por quien escribió el código: pistas directas de dónde ya se sabe que algo puede fallar.',
      action: 'Conviértelos en tareas con dueño y fecha.',
      evidence: findings.filter((f) => f.rule === 'todo').slice(0, 4).map((f) => ({ path: f.path, line: f.line })),
    });
  }

  if (entries.length === 0 && files.length) {
    push({
      id: 'entradas', severity: 'bajo', icon: 'entrada',
      title: 'No identifiqué un punto de entrada',
      detail: 'No hay index/main/server habitual ni shebang. Puede ser una librería (normal) o un proyecto con arranque no convencional.',
      action: 'Si es una aplicación, deja documentado cómo arranca.',
      evidence: [],
    });
  }

  const order = { critico: 0, alto: 1, medio: 2, bajo: 3 };
  return insights.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9)).slice(0, 10);
}
