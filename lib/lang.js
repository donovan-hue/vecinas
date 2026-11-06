/**
 * Detección de lenguaje y "enmascarado" del código.
 *
 * Enmascarar = reemplazar comentarios y el contenido de los strings por
 * espacios (conservando los saltos de línea y la numeración de líneas). Así
 * las reglas de análisis no se disparan con texto que aparece dentro de un
 * string o de un comentario, y las líneas reportadas siguen siendo exactas.
 */

const FAMILY_OF_EXT = {
  js: 'c', jsx: 'c', mjs: 'c', cjs: 'c',
  ts: 'c', tsx: 'c', mts: 'c', cts: 'c',
  java: 'c', go: 'c', c: 'c', h: 'c', cpp: 'c', cc: 'c', cxx: 'c', hpp: 'c',
  cs: 'c', rs: 'c', php: 'c', swift: 'c', kt: 'c', kts: 'c', scala: 'c', dart: 'c',
  py: 'python', pyi: 'python',
  rb: 'ruby', rake: 'ruby',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  sql: 'sql',
  html: 'markup', htm: 'markup', vue: 'markup', svelte: 'markup',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  json: 'data', yml: 'data', yaml: 'data', toml: 'data', xml: 'data', ini: 'data',
  md: 'text', mdx: 'text', txt: 'text',
};

const LANG_OF_EXT = {
  js: ['JavaScript', '#f7df1e'], jsx: ['JavaScript (JSX)', '#f7df1e'],
  mjs: ['JavaScript', '#f7df1e'], cjs: ['JavaScript', '#f7df1e'],
  ts: ['TypeScript', '#3178c6'], tsx: ['TypeScript (TSX)', '#3178c6'],
  mts: ['TypeScript', '#3178c6'], cts: ['TypeScript', '#3178c6'],
  py: ['Python', '#4b8bbe'], pyi: ['Python', '#4b8bbe'],
  java: ['Java', '#e76f00'], go: ['Go', '#00add8'],
  c: ['C', '#a8b9cc'], h: ['C/C++ header', '#a8b9cc'],
  cpp: ['C++', '#00599c'], cc: ['C++', '#00599c'], cxx: ['C++', '#00599c'], hpp: ['C++', '#00599c'],
  cs: ['C#', '#9b4f96'], rs: ['Rust', '#dea584'], php: ['PHP', '#777bb3'],
  rb: ['Ruby', '#cc342d'], swift: ['Swift', '#fa7343'], kt: ['Kotlin', '#a97bff'],
  kts: ['Kotlin', '#a97bff'], scala: ['Scala', '#c22d40'], dart: ['Dart', '#00b4ab'],
  sh: ['Shell', '#89e051'], bash: ['Shell', '#89e051'], zsh: ['Shell', '#89e051'],
  sql: ['SQL', '#e38c00'],
  html: ['HTML', '#e34c26'], htm: ['HTML', '#e34c26'],
  vue: ['Vue', '#41b883'], svelte: ['Svelte', '#ff3e00'],
  css: ['CSS', '#563d7c'], scss: ['Sass/SCSS', '#c6538c'], sass: ['Sass/SCSS', '#c6538c'], less: ['Less', '#1d365d'],
  json: ['JSON', '#8b949e'], yml: ['YAML', '#8b949e'], yaml: ['YAML', '#8b949e'],
  toml: ['TOML', '#8b949e'], xml: ['XML', '#8b949e'], ini: ['INI', '#8b949e'],
  md: ['Markdown', '#8b949e'], mdx: ['Markdown', '#8b949e'], txt: ['Texto', '#8b949e'],
};

/** Lenguajes con código "analizable" (el resto solo cuenta para métricas). */
const CODE_FAMILIES = new Set(['c', 'python', 'ruby', 'shell', 'sql', 'css', 'markup']);

export function extensionOf(path) {
  const base = String(path).split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function detectLanguage(path) {
  const ext = extensionOf(path);
  const family = FAMILY_OF_EXT[ext] || 'unknown';
  const [name, color] = LANG_OF_EXT[ext] || (ext ? [`${ext.toUpperCase()}`, '#8b949e'] : ['Sin extensión', '#8b949e']);
  return {
    ext,
    id: ext || 'none',
    name,
    color,
    family,
    isCode: CODE_FAMILIES.has(family),
    analyzable: family !== 'unknown' && family !== 'data' && family !== 'text',
  };
}

const STRIP_CONFIG = {
  c: {
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    quotes: ['"', "'", '`'],
  },
  python: {
    lineComments: ['#'],
    blockComments: [['"""', '"""'], ["'''", "'''"]],
    quotes: ['"', "'"],
  },
  ruby: {
    lineComments: ['#'],
    blockComments: [['=begin', '=end']],
    quotes: ['"', "'"],
  },
  shell: {
    lineComments: ['#'],
    blockComments: [],
    quotes: ['"', "'"],
  },
  sql: {
    lineComments: ['--'],
    blockComments: [['/*', '*/']],
    quotes: ["'", '"'],
  },
  css: {
    lineComments: [],
    blockComments: [['/*', '*/']],
    quotes: ['"', "'"],
  },
  markup: {
    lineComments: [],
    blockComments: [['<!--', '-->']],
    quotes: ['"', "'"],
  },
};


/** ¿El `/` de esta posición inicia una expresión regular (y no una división)? */
function looksLikeRegexStart(src, i) {
  let j = i - 1;
  while (j >= 0 && (src[j] === ' ' || src[j] === '\t')) j--;
  if (j < 0) return true;
  const prev = src[j];
  if ('(,=:[!&|?{};+-*%<>~^'.includes(prev)) return true;
  // return /re/, typeof /re/, case /re/
  const word = src.slice(Math.max(0, j - 8), j + 1).match(/([A-Za-z_$]+)$/);
  if (word && ['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await', 'void'].includes(word[1])) return true;
  return false;
}

/**
 * Devuelve { masked, lines, maskedLines, commentLines } donde `masked` tiene
 * comentarios, strings y literales de regex reemplazados por espacios.
 */
export function stripCode(src, family) {
  const cfg = STRIP_CONFIG[family] || STRIP_CONFIG.c;
  const n = src.length;
  const out = new Array(n);

  // Índices donde empieza cada línea, para calcular números de línea rápido.
  const lineStarts = [0];
  for (let k = 0; k < n; k++) if (src[k] === '\n') lineStarts.push(k + 1);
  const lineAt = (idx) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  const commentFlags = new Set();
  let i = 0;
  while (i < n) {
    const ch = src[i];

    if (ch === '\n') { out[i] = '\n'; i++; continue; }

    let opened = false;
    for (const token of cfg.lineComments) {
      if (src.startsWith(token, i)) {
        commentFlags.add(lineAt(i));
        while (i < n && src[i] !== '\n') { out[i] = ' '; i++; }
        opened = true;
        break;
      }
    }
    if (opened) continue;

    for (const [open, close] of cfg.blockComments) {
      if (src.startsWith(open, i)) {
        const endIdx = src.indexOf(close, i + open.length);
        const stop = endIdx === -1 ? n : endIdx + close.length;
        const from = lineAt(i);
        const to = endIdx === -1 ? lineStarts.length : lineAt(stop - 1);
        for (let l = from; l <= to; l++) commentFlags.add(l);
        for (; i < stop; i++) out[i] = src[i] === '\n' ? '\n' : ' ';
        opened = true;
        break;
      }
    }
    if (opened) continue;

    // Literales de expresión regular (solo familia C): /.../flags
    if (ch === '/' && family === 'c' && looksLikeRegexStart(src, i)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        for (let k = i; k < j; k++) out[k] = src[k] === '\n' ? '\n' : ' ';
        i = j;
        continue;
      }
    }

    let isQuote = false;
    for (const q of cfg.quotes) {
      if (src.startsWith(q, i)) {
        const multi = q.length > 1;
        for (let k = 0; k < q.length; k++) out[i + k] = ' ';
        i += q.length;
        while (i < n) {
          if (src[i] === '\\' && i + 1 < n && src[i + 1] !== '\n') {
            out[i] = ' '; out[i + 1] = ' '; i += 2; continue;
          }
          if (src.startsWith(q, i)) {
            for (let k = 0; k < q.length; k++) out[i + k] = ' ';
            i += q.length;
            break;
          }
          if (!multi && src[i] === '\n') break; // string sin cerrar: no comemos el resto del archivo
          out[i] = src[i] === '\n' ? '\n' : ' ';
          i++;
        }
        isQuote = true;
        break;
      }
    }
    if (isQuote) continue;

    out[i] = ch;
    i++;
  }

  // Relleno defensivo (por si el bucle saliera antes de tiempo).
  for (let k = 0; k < n; k++) if (out[k] === undefined) out[k] = src[k] === '\n' ? '\n' : ' ';

  const masked = out.join('');
  const lines = src.split('\n');
  const maskedLines = masked.split('\n');

  const blankLines = [];
  const codeLineIdx = new Set();
  const commentOnlyIdx = new Set();
  for (let l = 0; l < maskedLines.length; l++) {
    const lineNo = l + 1;
    const hasCode = maskedLines[l].trim().length > 0;
    const isComment = commentFlags.has(lineNo);
    if (hasCode) codeLineIdx.add(lineNo);
    if (!hasCode && !isComment) blankLines.push(lineNo);
    if (isComment && !hasCode) commentOnlyIdx.add(lineNo);
  }

  return {
    masked,
    lines,
    maskedLines,
    commentLines: commentFlags.size,
    commentOnly: commentOnlyIdx.size,
    codeLines: codeLineIdx.size,
    blankLines: blankLines.length,
    totalLines: lines.length,
  };
}

/** Número de línea de cada match de una regex global sobre un texto. */
export function lineNumbersOf(src, regex) {
  const result = [];
  let m;
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  while ((m = re.exec(src)) !== null) {
    const before = src.slice(0, m.index);
    result.push(before.split('\n').length);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return result;
}
