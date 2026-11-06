/* ============================================================
   Vecinas — interfaz
   Sin frameworks: estado en memoria, render por plantillas.
   ============================================================ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  report: null,
  graphColor: 'risk',
  severity: 'todos',
  search: '',
  graphFocused: null,
  payload: null,
};

const SKIP_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'svg', 'pdf',
  'woff', 'woff2', 'ttf', 'eot', 'otf', 'mp3', 'mp4', 'mov', 'webm', 'wav',
  'zip', 'gz', 'tar', 'rar', '7z', 'jar', 'exe', 'dll', 'so', 'dylib', 'bin',
  'class', 'o', 'a', 'pyc', 'db', 'sqlite', 'csv', 'xlsx', 'docx', 'pptx', 'psd',
  'lock', 'map', 'min.js', 'min.css',
]);

const SEV_ORDER = ['critico', 'alto', 'medio', 'bajo'];
const SEV_LABEL = { critico: 'crítico', alto: 'alto', medio: 'medio', bajo: 'bajo' };
const CAT_LABEL = {
  seguridad: 'seguridad', errores: 'errores', mantenibilidad: 'mantenibilidad',
  rendimiento: 'rendimiento', calidad: 'calidad', portabilidad: 'portabilidad',
};

/* ------------------------------- utilidades ------------------------------- */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('es-MX').format(n);
}

function riskColor(risk) {
  if (risk <= 18) return '#5eead4';
  if (risk <= 34) return '#a3e635';
  if (risk <= 52) return '#ffd166';
  if (risk <= 70) return '#ffa657';
  return '#ff6b6b';
}

function riskLabel(risk) {
  if (risk <= 18) return 'bajo';
  if (risk <= 34) return 'moderado';
  if (risk <= 52) return 'medio';
  if (risk <= 70) return 'alto';
  return 'crítico';
}

function shortPath(p, max = 46) {
  if (!p) return '';
  return p.length > max ? '…' + p.slice(-max + 1) : p;
}

/* --------------------------------- red ---------------------------------- */

async function postAnalyze(payload) {
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let data;
  try { data = await res.json(); } catch { throw new Error('El servidor devolvió una respuesta inesperada'); }
  if (!res.ok || !data.ok) {
    const err = new Error(data.error || 'No se pudo analizar');
    err.hint = data.hint || null;
    throw err;
  }
  return data.report;
}

/* ------------------------------- progreso ------------------------------- */

let stepTimer = null;

function progressMarkup(title) {
  return `
    <div class="progress-head">
      <span class="spinner" aria-hidden="true"></span>
      <strong id="progressTitle">${esc(title)}</strong>
    </div>
    <ol class="steps" id="steps">
      <li data-step="descarga">Reuniendo archivos</li>
      <li data-step="lectura">Leyendo y enmascarando código</li>
      <li data-step="metricas">Midiendo funciones y complejidad</li>
      <li data-step="grafo">Tejiendo el grafo de dependencias</li>
      <li data-step="reglas">Buscando señales de error</li>
      <li data-step="riesgo">Estimando riesgo por archivo</li>
    </ol>`;
}

function startProgress(title) {
  const progress = $('#progress');
  progress.innerHTML = progressMarkup(title);
  progress.hidden = false;
  $('#loader').hidden = true;
  $('#analisis').hidden = true;

  const steps = $$('#steps li');
  steps.forEach((li) => li.classList.remove('is-active', 'is-done'));
  let i = 0;
  steps[0].classList.add('is-active');
  clearInterval(stepTimer);
  stepTimer = setInterval(() => {
    if (i < steps.length - 1) {
      steps[i].classList.remove('is-active');
      steps[i].classList.add('is-done');
      i++;
      steps[i].classList.add('is-active');
    }
  }, 620);
}

function finishProgress() {
  clearInterval(stepTimer);
  $$('#steps li').forEach((li) => { li.classList.remove('is-active'); li.classList.add('is-done'); });
}

function stopProgressWithError(message, hint) {
  clearInterval(stepTimer);
  const progress = $('#progress');
  progress.hidden = false;
  progress.innerHTML = `
    <div class="progress-head"><strong>No pude completar el análisis</strong></div>
    <div class="err">${esc(message)}${hint ? `<small>${esc(hint)}</small>` : ''}</div>
    <div class="field-row end">
      <span class="muted small">Revisa el origen del código e inténtalo de nuevo.</span>
      <button class="btn btn-ghost" id="retryBtn">Volver</button>
    </div>`;
  $('#retryBtn').addEventListener('click', resetUi);
}

function resetUi() {
  clearInterval(stepTimer);
  state.report = null;
  state.payload = null;
  const progress = $('#progress');
  progress.hidden = true;
  progress.innerHTML = progressMarkup('Analizando…');
  $('#loader').hidden = false;
  $('#analisis').hidden = true;
  closeDrawer();
  $('#pickedFiles').hidden = true;
  $('#pickedFiles').innerHTML = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* -------------------------------- flujo --------------------------------- */

async function runAnalysis(payload, title = 'Analizando…') {
  startProgress(title);
  const t0 = performance.now();
  try {
    const report = await postAnalyze(payload);
    finishProgress();
    const elapsed = Math.round(performance.now() - t0);
    report.meta.clientMs = elapsed;
    state.report = report;
    state.payload = payload;
    state.severity = 'todos';
    state.search = '';
    $('#searchFindings').value = '';
    renderReport(report);
    setTimeout(() => {
      $('#progress').hidden = true;
      $('#analisis').hidden = false;
      $('#analisis').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 220);
  } catch (err) {
    stopProgressWithError(err.message || 'Error inesperado', err.hint);
  }
}

async function analyzeRepo(input) {
  const repo = String(input || '').trim();
  if (!repo) { toast('Escribe la URL o el nombre del repositorio'); return; }
  await runAnalysis({ type: 'github', repo }, `Descargando y leyendo ${repo}…`);
}

function toast(message) {
  const zone = $('#loader');
  let el = $('#loaderToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loaderToast';
    el.className = 'err';
    el.style.background = 'rgba(94,234,212,0.08)';
    el.style.borderColor = 'rgba(94,234,212,0.3)';
    el.style.color = '#a7f3e8';
    zone.appendChild(el);
  }
  el.textContent = message;
  setTimeout(() => { el?.remove(); }, 3500);
}

/* ---------------------------- archivos locales ---------------------------- */

const picked = [];

function addPicked(entries) {
  for (const item of entries) {
    if (picked.length >= 400) break;
    const ext = (item.file.name.split('.').pop() || '').toLowerCase();
    if (SKIP_EXT.has(ext)) continue;
    if (item.file.size > 512 * 1024) continue;
    if (picked.some((p) => p.path === item.path)) continue;
    picked.push(item);
  }
  renderPicked();
}

function renderPicked() {
  const list = $('#pickedFiles');
  if (!picked.length) { list.hidden = true; list.innerHTML = ''; return; }
  list.hidden = false;
  const totalKb = Math.round(picked.reduce((acc, p) => acc + p.file.size, 0) / 1024);
  list.innerHTML = `
    <li><span>${picked.length} archivo(s) listos · ${fmt(totalKb)} KB</span>
      <button class="link-btn" id="sendPicked">Analizar ahora →</button></li>
    ${picked.slice(0, 8).map((p) => `<li><span>${esc(p.path)}</span><span>${Math.max(1, Math.round(p.file.size / 1024))} KB</span></li>`).join('')}
    ${picked.length > 8 ? `<li><span>… y ${picked.length - 8} más</span><span></span></li>` : ''}`;
  $('#sendPicked').addEventListener('click', sendPicked);
}

async function sendPicked() {
  if (!picked.length) return;
  const files = [];
  for (const item of picked) {
    try {
      const content = await item.file.text();
      files.push({ path: item.path, content });
    } catch { /* ilegible: se omite */ }
  }
  if (!files.length) { toast('No pude leer los archivos elegidos'); return; }
  const first = picked[0].path.split('/');
  const name = first.length > 1 ? first[0] : 'archivos-locales';
  await runAnalysis({ type: 'files', name, files }, `Leyendo ${files.length} archivo(s)…`);
}

async function walkEntry(entry, prefix, out) {
  if (out.length > 700) return;
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, path: prefix + entry.name });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch = [];
    do {
      batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`, out);
    } while (batch.length > 0);
  }
}

async function handleDrop(event) {
  event.preventDefault();
  $('#dropzone').classList.remove('is-over');
  const dt = event.dataTransfer;
  if (!dt) return;
  const entries = Array.from(dt.items || [])
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!entries.length) {
    addPicked(Array.from(dt.files || []).map((file) => ({ file, path: file.name })));
    return;
  }
  const collected = [];
  for (const entry of entries) await walkEntry(entry, '', collected);
  addPicked(collected);
}

/* ------------------------------- render --------------------------------- */

function renderReport(report) {
  const { meta, summary } = report;
  const srcLabel = meta.source?.type === 'github' ? `repositorio · ${meta.source.branch}`
    : meta.source?.type === 'paste' ? 'fragmento pegado'
      : meta.source?.type === 'sample' ? 'proyecto de ejemplo'
        : 'archivos locales';

  $('#srcLabel').textContent = srcLabel;
  $('#projectTitle').textContent = meta.projectName;
  const metaBits = [
    `${fmt(summary.files)} archivos`,
    `${fmt(summary.codeLines)} líneas de código`,
    `análisis en ${fmt(meta.durationMs)} ms`,
  ];
  if (meta.source?.url) metaBits.unshift(meta.source.url.replace('https://', ''));
  if (meta.skippedCount) metaBits.push(`${fmt(meta.skippedCount)} archivo(s) omitidos`);
  $('#projectMeta').textContent = metaBits.join(' · ');

  renderKpis(report);
  renderInsights(report);
  renderRiskList(report);
  renderGraph(report);
  renderFindings(report);
  renderFiles(report);
  renderLanguages(report);
  renderStack(report);
  renderStructure(report);
  renderDeps(report);
}

function renderKpis(report) {
  const { summary, meta } = report;
  const f = summary.findings;
  const health = 100 - summary.risk;
  const circumference = 2 * Math.PI * 30;
  const offset = circumference * (1 - health / 100);
  const color = riskColor(summary.risk);

  $('#kpis').innerHTML = `
    <div class="kpi is-health">
      <svg class="gauge" viewBox="0 0 72 72" aria-hidden="true">
        <circle cx="36" cy="36" r="30" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="6"/>
        <circle cx="36" cy="36" r="30" fill="none" stroke="${color}" stroke-width="6"
          stroke-linecap="round" stroke-dasharray="${circumference.toFixed(1)}"
          stroke-dashoffset="${offset.toFixed(1)}"
          transform="rotate(-90 36 36)"/>
        <text x="36" y="41" text-anchor="middle" font-size="19">${esc(summary.grade)}</text>
      </svg>
      <div>
        <div class="kpi-label">Salud del código</div>
        <div class="kpi-value">${health}<span class="muted" style="font-size:14px;font-weight:500">/100</span></div>
        <div class="kpi-sub">${esc(summary.gradeLabel)} · riesgo ${summary.risk}/100</div>
      </div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Archivos</div>
      <div class="kpi-value">${fmt(summary.files)}</div>
      <div class="kpi-sub">${meta.languages.length} lenguaje(s) detectado(s)</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Líneas de código</div>
      <div class="kpi-value">${fmt(summary.codeLines)}</div>
      <div class="kpi-sub">${fmt(summary.totalLines)} con comentarios y blancos</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Funciones</div>
      <div class="kpi-value">${fmt(summary.functions)}</div>
      <div class="kpi-sub">complejidad media ${summary.avgComplexity}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Complejidad</div>
      <div class="kpi-value">${fmt(summary.complexity)}</div>
      <div class="kpi-sub">${summary.avgComplexity} por archivo</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Hallazgos</div>
      <div class="kpi-value">${fmt(f.total)}</div>
      <div class="sev-legend">
        ${SEV_ORDER.map((s) => `<span class="sev-pill"><i class="dot ${s}"></i>${f[s] || 0}</span>`).join('')}
      </div>
    </div>`;
}

function renderInsights(report) {
  const list = report.insights || [];
  if (!list.length) {
    $('#insights').innerHTML = '<div class="empty">Sin señales de riesgo destacables. El código se ve ordenado.</div>';
    return;
  }
  $('#insights').innerHTML = list.map((ins) => `
    <article class="insight" data-sev="${esc(ins.severity)}">
      <h4>${esc(ins.title)} <span class="sev-label">${esc(SEV_LABEL[ins.severity] || ins.severity)}</span></h4>
      <p>${esc(ins.detail)}</p>
      ${ins.action ? `<p class="action">${esc(ins.action)}</p>` : ''}
      ${ins.evidence?.length ? `<div class="evidence">${ins.evidence.slice(0, 4).map((e) => `
        <span class="ev" ${e.line ? `data-open="${esc(e.path)}"` : ''} title="${esc(e.path)}${e.line ? ':' + e.line : ''}">${esc(shortPath(e.path, 34)) || '—'}</span>`).join('')}</div>` : ''}
    </article>`).join('');

  $$('#insights .ev[data-open]').forEach((el) => {
    el.addEventListener('click', () => openFile(el.dataset.open));
  });
}

function renderRiskList(report) {
  const files = report.files.slice(0, 12);
  $('#riskList').innerHTML = files.map((f, i) => `
    <li class="risk-item" data-open="${esc(f.path)}" title="${esc(f.prediction)}">
      <span class="risk-rank">${String(i + 1).padStart(2, '0')}</span>
      <div class="risk-main">
        <div class="risk-path">${esc(shortPath(f.path, 40))}</div>
        <div class="risk-why">${esc(f.riskReasons?.[0]?.detail || f.prediction)}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <div class="bar"><i style="width:${f.risk}%;background:${riskColor(f.risk)}"></i></div>
        <span class="risk-score">${f.risk}</span>
      </div>
    </li>`).join('') || '<li class="empty">Sin archivos de código.</li>';

  $$('#riskList .risk-item').forEach((el) => el.addEventListener('click', () => openFile(el.dataset.open)));
}

/* --------------------------------- grafo -------------------------------- */

function layoutGraph(nodes, edges, width = 900, height = 430) {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const n = nodes.length;
  const pos = nodes.map((node, i) => {
    const angle = i * 2.399963;
    const radius = 130 + (i % 7) * 18;
    return { x: width / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius };
  });

  const links = edges.map((e) => ({ s: index.get(e.source), t: index.get(e.target) }))
    .filter((l) => l.s != null && l.t != null);

  const area = width * height;
  const k = Math.sqrt(area / Math.max(1, n)) * 0.62;
  const iterations = n > 90 ? 220 : 320;

  for (let iter = 0; iter < iterations; iter++) {
    // repulsión
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = (Math.random() - 0.5) * 2; dy = (Math.random() - 0.5) * 2; d2 = 4; }
        const dist = Math.sqrt(d2);
        const force = (k * k) / d2;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        pos[i].x += fx; pos[i].y += fy;
        pos[j].x -= fx; pos[j].y -= fy;
      }
    }
    // atracción por aristas
    for (const l of links) {
      const dx = pos[l.t].x - pos[l.s].x;
      const dy = pos[l.t].y - pos[l.s].y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist * dist) / k * 0.035;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      pos[l.s].x += fx; pos[l.s].y += fy;
      pos[l.t].x -= fx; pos[l.t].y -= fy;
    }
    // gravedad al centro
    for (const p of pos) {
      p.x += (width / 2 - p.x) * 0.012;
      p.y += (height / 2 - p.y) * 0.012;
    }
    // enfriar
    if (iter % 40 === 0) for (const p of pos) { p.x += (Math.random() - 0.5) * 2; p.y += (Math.random() - 0.5) * 2; }
  }

  // ajustar al lienzo
  const pad = 34;
  const xs = pos.map((p) => p.x); const ys = pos.map((p) => p.y);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const spanX = Math.max(1, maxX - minX); const spanY = Math.max(1, maxY - minY);
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
  for (const p of pos) {
    p.x = pad + (p.x - minX) * scale + ((width - pad * 2) - spanX * scale) / 2;
    p.y = pad + (p.y - minY) * scale + ((height - pad * 2) - spanY * scale) / 2;
  }

  return { pos, links };
}

function renderGraph(report) {
  const svg = $('#graph');
  const { nodes, edges } = report.graph;
  $('#graphMeta').textContent = `${nodes.length} archivo(s) · ${edges.length} conexión(es)${report.graph.truncated ? ' · grafo abreviado' : ''}`;

  if (!nodes.length) {
    svg.innerHTML = '';
    $('#graphMeta').textContent = 'Sin dependencias que dibujar (archivos sueltos).';
    renderLegend(report);
    return;
  }

  const W = 900; const H = 430;
  const { pos, links } = layoutGraph(nodes, edges, W, H);

  const maxLoc = Math.max(...nodes.map((n) => n.loc), 1);
  const radiusOf = (n) => 4 + Math.sqrt(n.loc / maxLoc) * 13;
  const labelNodes = new Set(
    nodes.slice().sort((a, b) => (b.fanIn + b.loc / 50) - (a.fanIn + a.loc / 50)).slice(0, 16).map((n) => n.id),
  );

  const edgeSvg = links.map((l) => {
    const a = pos[l.s]; const b = pos[l.t];
    const cycle = nodes[l.s].inCycle && nodes[l.t].inCycle;
    return `<line class="edge ${cycle ? 'is-cycle' : ''}" data-from="${esc(nodes[l.s].id)}" data-to="${esc(nodes[l.t].id)}"
      x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"/>`;
  }).join('');

  const nodeSvg = nodes.map((node, i) => {
    const p = pos[i];
    const color = state.graphColor === 'risk' ? riskColor(node.risk) : node.color;
    const r = radiusOf(node);
    return `<g class="node ${node.isEntry ? 'is-entry' : ''} ${node.inCycle ? 'is-cycle' : ''}"
        data-id="${esc(node.id)}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">
      <circle r="${r.toFixed(1)}" fill="${color}" fill-opacity="0.88"/>
      ${labelNodes.has(node.id) ? `<text y="${(r + 10).toFixed(1)}" text-anchor="middle">${esc(node.label)}</text>` : ''}
    </g>`;
  }).join('');

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `<g class="edges">${edgeSvg}</g><g class="nodes">${nodeSvg}</g>`;

  renderLegend(report);

  // interacción
  const wrap = svg.closest('.graph-wrap');
  const tooltip = $('#tooltip');

  const clearFocus = () => {
    wrap.classList.remove('is-focused');
    $$('.node', svg).forEach((n) => n.classList.remove('is-hot'));
    $$('.edge', svg).forEach((e) => e.classList.remove('is-hot'));
    tooltip.hidden = true;
  };

  $$('.node', svg).forEach((g) => {
    const node = nodes.find((n) => n.id === g.dataset.id);
    g.addEventListener('mouseenter', (ev) => {
      wrap.classList.add('is-focused');
      g.classList.add('is-hot');
      const neighbors = new Set([node.id]);
      $$('.edge', svg).forEach((e) => {
        if (e.dataset.from === node.id || e.dataset.to === node.id) {
          e.classList.add('is-hot');
          neighbors.add(e.dataset.from); neighbors.add(e.dataset.to);
        }
      });
      $$('.node', svg).forEach((n) => { if (neighbors.has(n.dataset.id)) n.classList.add('is-hot'); });
      const rect = wrap.getBoundingClientRect();
      tooltip.hidden = false;
      tooltip.style.left = `${ev.clientX - rect.left}px`;
      tooltip.style.top = `${ev.clientY - rect.top}px`;
      tooltip.innerHTML = `
        <div class="tt-path">${esc(node.id)}</div>
        <div class="tt-meta">
          <span>riesgo <b style="color:${riskColor(node.risk)}">${node.risk}</b></span>
          <span>${fmt(node.loc)} LOC</span>
          <span>${node.fanIn} entradas / ${node.fanOut} salidas</span>
          ${node.inCycle ? '<span style="color:#ffa657">en ciclo</span>' : ''}
        </div>`;
    });
    g.addEventListener('mouseleave', clearFocus);
    g.addEventListener('click', () => openFile(node.id));
  });

  svg.addEventListener('mouseleave', clearFocus);
}

function renderLegend(report) {
  const legend = $('#legend');
  if (state.graphColor === 'risk') {
    legend.innerHTML = `
      <div class="row"><span class="swatch" style="background:#5eead4"></span>riesgo bajo</div>
      <div class="row"><span class="swatch" style="background:#ffd166"></span>medio</div>
      <div class="row"><span class="swatch" style="background:#ff6b6b"></span>crítico</div>
      <div class="row"><span class="swatch" style="background:none;border:1.5px solid #5eead4"></span>punto de entrada</div>`;
  } else {
    const langs = (report.meta.languages || []).slice(0, 5);
    legend.innerHTML = langs.map((l) => `<div class="row"><span class="swatch" style="background:${l.color}"></span>${esc(l.name)}</div>`).join('');
  }
}

/* ------------------------------- hallazgos ------------------------------- */

function renderFindings(report) {
  const findings = report.findings || [];
  const counts = { todos: findings.length };
  for (const s of SEV_ORDER) counts[s] = findings.filter((f) => f.severity === s).length;

  $('#findingsMeta').textContent = `${fmt(findings.length)} hallazgo(s) en ${fmt(new Set(findings.map((f) => f.path)).size)} archivo(s)`;

  $('#sevChips').innerHTML = [
    `<button class="sev-chip ${state.severity === 'todos' ? 'is-active' : ''}" data-sev="todos">Todos <span class="count">${counts.todos}</span></button>`,
    ...SEV_ORDER.map((s) => `<button class="sev-chip ${state.severity === s ? 'is-active' : ''}" data-sev="${s}">
      <i class="dot ${s}"></i>${SEV_LABEL[s]} <span class="count">${counts[s]}</span></button>`),
  ].join('');

  $$('#sevChips .sev-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.severity = btn.dataset.sev;
      renderFindings(report);
    });
  });

  const term = state.search.trim().toLowerCase();
  const filtered = findings.filter((f) => {
    const sevOk = state.severity === 'todos' || f.severity === state.severity;
    if (!sevOk) return false;
    if (!term) return true;
    return `${f.path} ${f.title} ${f.rule} ${f.category}`.toLowerCase().includes(term);
  });

  const LIMIT = 80;
  const shown = filtered.slice(0, LIMIT);

  if (!filtered.length) {
    $('#findings').innerHTML = '<div class="empty">Nada con ese filtro. Prueba con otra severidad o limpia la búsqueda.</div>';
    return;
  }

  $('#findings').innerHTML = shown.map((f) => `
    <article class="finding">
      <span class="stripe ${esc(f.severity)}"></span>
      <div>
        <h4>${esc(f.title)} <span class="cat">${esc(CAT_LABEL[f.category] || f.category)} · ${esc(f.rule)}</span></h4>
        <div class="where"><b>${esc(shortPath(f.path, 52))}</b>${f.line ? `:${f.line}` : ''}</div>
        ${f.snippet ? `<div class="snippet">${esc(f.snippet)}</div>` : ''}
        <div class="why">${esc(f.detail)}</div>
        <div class="fix">${esc(f.fix)}</div>
      </div>
    </article>`).join('') + (filtered.length > LIMIT
    ? `<div class="empty">Mostrando ${LIMIT} de ${fmt(filtered.length)}. Afina con la búsqueda o el filtro de severidad.</div>`
    : '');
}

/* -------------------------------- archivos ------------------------------- */

function renderFiles(report) {
  const rows = report.files.slice(0, 200);
  $('#fileRows').innerHTML = rows.map((f) => `
    <tr data-open="${esc(f.path)}">
      <td class="path" title="${esc(f.path)}">${esc(shortPath(f.path, 44))}
        ${f.inCycle ? '<span class="badge" style="color:#ffa657;border-color:rgba(255,166,87,.4)">ciclo</span>' : ''}
        ${f.isEntry ? '<span class="badge" style="color:#5eead4;border-color:rgba(94,234,212,.4)">entrada</span>' : ''}
      </td>
      <td class="num">${fmt(f.displayLines ?? f.codeLines)}</td>
      <td class="num">${fmt(f.complexity)}</td>
      <td class="num">${f.findingCount || '—'}</td>
      <td>
        <div class="risk-cell">
          <div class="bar"><i style="width:${f.risk}%;background:${riskColor(f.risk)}"></i></div>
          <span class="risk-score">${f.risk}</span>
        </div>
      </td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">Sin archivos.</td></tr>';

  $$('#fileRows tr[data-open]').forEach((tr) => tr.addEventListener('click', () => openFile(tr.dataset.open)));
}

function renderLanguages(report) {
  const langs = report.meta.languages || [];
  $('#langBars').innerHTML = langs.slice(0, 8).map((l) => `
    <div class="lang-row">
      <span class="lang-name" title="${esc(l.name)}">${esc(l.name)}</span>
      <div class="lang-track"><div class="lang-fill" style="width:${Math.max(2, l.pct)}%;background:${l.color}"></div></div>
      <span class="lang-pct">${l.pct}%</span>
    </div>`).join('') || '<div class="empty">Sin datos.</div>';
}

function renderStack(report) {
  const stack = report.stack || [];
  $('#stackChips').innerHTML = stack.length
    ? stack.map((s) => `<span class="stack-chip"><span class="kind">${esc(s.kind)}</span>${esc(s.name)}</span>`).join('')
    : '<div class="empty">No reconocí un framework o runtime concreto.</div>';
}

function renderStructure(report) {
  const parts = [];
  const cycles = report.cycles || [];
  if (cycles.length) {
    parts.push(`<div class="struct-block">
      <h4>Ciclos de dependencia <span>${cycles.length}</span></h4>
      ${cycles.slice(0, 6).map((c) => `<div class="cycle">${c.map((p) => esc(shortPath(p, 40))).join(' → ')} → ↩</div>`).join('')}
    </div>`);
  }

  const dup = report.duplication;
  if (dup && dup.blockCount) {
    parts.push(`<div class="struct-block">
      <h4>Duplicación <span>${dup.blockCount} bloque(s) · ~${dup.percent}% del código</span></h4>
      ${dup.blocks.slice(0, 4).map((b) => `<div class="dup-item">
        <div class="where">${b.occurrences.slice(0, 2).map((o) => `${esc(shortPath(o.path, 32))}<span>:${o.line}</span>`).join(' &nbsp;↔&nbsp; ')}</div>
        <div>${b.lines} líneas idénticas repetidas ${b.count} veces</div>
      </div>`).join('')}
    </div>`);
  }

  const areas = report.areas || [];
  if (areas.length > 1) {
    parts.push(`<div class="struct-block">
      <h4>Áreas del proyecto</h4>
      <div class="lang-bars">
        ${areas.slice(0, 6).map((a) => `<div class="lang-row">
          <span class="lang-name" title="${esc(a.name)}">${esc(a.name)}</span>
          <div class="lang-track"><div class="lang-fill" style="width:${Math.min(100, Math.max(3, (a.codeLines / Math.max(1, areas[0].codeLines)) * 100))}%;background:${riskColor(a.risk)}"></div></div>
          <span class="lang-pct">${a.files}</span>
        </div>`).join('')}
      </div>
    </div>`);
  }

  if (!parts.length) {
    parts.push('<div class="empty">Sin ciclos ni duplicación relevante.</div>');
  }
  $('#structure').innerHTML = `<div class="structure">${parts.join('')}</div>`;
}

function renderDeps(report) {
  const deps = report.externalDependencies || [];
  $('#deps').innerHTML = deps.length
    ? deps.map((d) => `<span class="dep"><b>${esc(d.name)}</b> <span>×${d.imports}</span></span>`).join('')
    : '<div class="empty">Sin dependencias externas: todo apunta a archivos del propio proyecto.</div>';
}

/* --------------------------------- ficha -------------------------------- */

function openFile(path) {
  const report = state.report;
  if (!report) return;
  const file = report.files.find((f) => f.path === path);
  if (!file) return;

  const findings = (report.findings || []).filter((f) => f.path === path);
  const drawer = $('#drawer');
  const body = $('#drawerBody');

  $('#drawerLang').textContent = `${file.language.name} · ${file.path.split('/').length > 1 ? file.path.split('/').slice(0, -1).join('/') : 'raíz'}`;
  $('#drawerTitle').textContent = file.path;

  const reasons = (file.riskReasons || []).map((r) => `<div class="reason"><span>${esc(r.label)} · ${esc(r.detail)}</span><span>+${r.points}</span></div>`).join('');

  body.innerHTML = `
    <div class="metric-grid">
      <div class="metric"><div class="k">Riesgo</div><div class="v" style="color:${riskColor(file.risk)}">${file.risk}</div></div>
      <div class="metric"><div class="k">Líneas</div><div class="v">${fmt(file.codeLines)}</div></div>
      <div class="metric"><div class="k">Complejidad</div><div class="v">${fmt(file.complexity)}</div></div>
      <div class="metric"><div class="k">Funciones</div><div class="v">${fmt(file.functionsCount)}</div></div>
      <div class="metric"><div class="k">Entradas</div><div class="v">${fmt(file.fanIn)}</div></div>
      <div class="metric"><div class="k">Salidas</div><div class="v">${fmt(file.fanOut)}</div></div>
    </div>

    <div class="prediction"><b>Predicción</b>${esc(file.prediction)}</div>

    ${reasons ? `<div><h4 class="block-title">Por qué este riesgo</h4><div class="reasons">${reasons}</div></div>` : ''}
    ${file.longestFunction ? `<div><h4 class="block-title">Función más larga</h4>
      <div class="reason"><span>${esc(file.longestFunction.name)}</span><span>${fmt(file.longestFunction.lines)} líneas · línea ${file.longestFunction.line}</span></div></div>` : ''}

    <div>
      <h4 class="block-title">Hallazgos (${findings.length})</h4>
      <div class="file-findings">
        ${findings.length ? findings.map((f) => `
          <div class="file-finding" data-sev="${esc(f.severity)}">
            <div class="t">${esc(f.title)}</div>
            <div class="m">${f.line ? `línea ${f.line} · ` : ''}${esc(SEV_LABEL[f.severity])} · ${esc(f.rule)}</div>
            ${f.snippet ? `<div class="snippet">${esc(f.snippet)}</div>` : ''}
            <div class="m" style="color:#8d9cb2;font-family:var(--sans)">${esc(f.fix)}</div>
          </div>`).join('') : '<div class="empty">Ninguno. Este archivo no disparó reglas.</div>'}
      </div>
    </div>

    ${file.imports?.length ? `<div><h4 class="block-title">Importa a (${file.imports.length})</h4>
      <div class="pill-list">${file.imports.slice(0, 24).map((i) => `<span class="pill" title="${esc(i.raw)}">${esc(shortPath(i.target, 34))}</span>`).join('')}</div></div>` : ''}

    ${file.externalImports?.length ? `<div><h4 class="block-title">Paquetes externos</h4>
      <div class="pill-list">${file.externalImports.map((d) => `<span class="pill">${esc(d.name)} ×${d.count}</span>`).join('')}</div></div>` : ''}

    ${file.exports?.length ? `<div><h4 class="block-title">Exporta (${file.exports.length})</h4>
      <div class="pill-list">${file.exports.slice(0, 30).map((e) => `<span class="pill">${esc(e)}</span>`).join('')}</div></div>` : ''}

    ${file.truncated ? '<div class="err">Archivo recortado: se analizaron las primeras 6 000 líneas.</div>' : ''}`;

  drawer.hidden = false;
  $('#scrim').hidden = false;
  body.scrollTop = 0;
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
}

/* ------------------------------- descarga ------------------------------- */

function downloadJson() {
  if (!state.report) return;
  const blob = new Blob([JSON.stringify(state.report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const name = String(state.report.meta.projectName || 'proyecto').replace(/[^\w.-]+/g, '-').toLowerCase();
  a.href = url;
  a.download = `vecinas-${name}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* -------------------------------- eventos ------------------------------- */

function initEvents() {
  // pestañas
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => { t.classList.remove('is-active'); t.setAttribute('aria-selected', 'false'); });
      tab.classList.add('is-active');
      tab.setAttribute('aria-selected', 'true');
      $$('.panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === tab.dataset.tab));
    });
  });

  $('#repoBtn').addEventListener('click', () => analyzeRepo($('#repoInput').value));
  $('#repoInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') analyzeRepo(e.target.value); });
  $$('.chip-quick').forEach((chip) => chip.addEventListener('click', () => {
    $('#repoInput').value = `https://github.com/${chip.dataset.repo}`;
    analyzeRepo(chip.dataset.repo);
  }));

  $('#sampleBtn').addEventListener('click', () => runAnalysis({ type: 'sample' }, 'Analizando el proyecto de ejemplo…'));

  // archivos
  const dropzone = $('#dropzone');
  dropzone.addEventListener('click', () => $('#fileInput').click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); }
  });
  $('#pickFiles').addEventListener('click', () => $('#fileInput').click());
  $('#pickDir').addEventListener('click', () => $('#dirInput').click());
  $('#fileInput').addEventListener('change', (e) => {
    addPicked(Array.from(e.target.files || []).map((file) => ({ file, path: file.name })));
    e.target.value = '';
  });
  $('#dirInput').addEventListener('change', (e) => {
    addPicked(Array.from(e.target.files || []).map((file) => ({
      file,
      path: file.webkitRelativePath || file.name,
    })));
    e.target.value = '';
  });
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('is-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-over'));
  dropzone.addEventListener('drop', handleDrop);

  // pegar
  $('#pasteBtn').addEventListener('click', async () => {
    const code = $('#pasteCode').value;
    if (!code.trim()) { toast('Pega algo de código primero'); return; }
    await runAnalysis({ type: 'paste', code, path: $('#pasteName').value || 'fragmento.js' }, 'Leyendo el fragmento…');
  });

  // resultados
  $('#againBtn').addEventListener('click', resetUi);
  $('#jsonBtn').addEventListener('click', downloadJson);

  $('#searchFindings').addEventListener('input', (e) => {
    state.search = e.target.value;
    if (state.report) renderFindings(state.report);
  });

  $$('.graph-controls .seg').forEach((seg) => {
    seg.addEventListener('click', () => {
      $$('.graph-controls .seg').forEach((s) => s.classList.remove('is-active'));
      seg.classList.add('is-active');
      state.graphColor = seg.dataset.color;
      if (state.report) renderGraph(state.report);
    });
  });

  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
}

initEvents();
