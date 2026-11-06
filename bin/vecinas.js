#!/usr/bin/env node
/**
 * CLI de Vecinas: analiza una carpeta local sin abrir el navegador.
 *
 *   vecinas .                 informe legible
 *   vecinas . --json          informe completo en JSON
 *   vecinas . --limite 40     falla (exit 1) si el riesgo global supera 40
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { analyzeProject } from '../lib/analyzer.js';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('-')) || '.';
const asJson = args.includes('--json');
const limitIdx = args.findIndex((a) => a === '--limite' || a === '--limit');
const threshold = limitIdx !== -1 ? Number(args[limitIdx + 1]) : null;
const onlyCode = args.includes('--solo-codigo');

const HARD_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', 'target', 'coverage', '.turbo']);

const COLOR = process.stdout.isTTY && !args.includes('--no-color');
const c = {
  dim: (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s),
  mint: (s) => (COLOR ? `\x1b[38;5;79m${s}\x1b[0m` : s),
  red: (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s),
  orange: (s) => (COLOR ? `\x1b[38;5;215m${s}\x1b[0m` : s),
  yellow: (s) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s),
  blue: (s) => (COLOR ? `\x1b[34m${s}\x1b[0m` : s),
};

async function collect(dir, base = dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (HARD_SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(full, base, out);
    } else if (entry.isFile()) {
      const rel = path.relative(base, full).split(path.sep).join('/');
      try {
        const stat = await fs.stat(full);
        if (stat.size > 512 * 1024) continue;
        const content = await fs.readFile(full, 'utf8');
        out.push({ path: rel, content });
      } catch { /* ilegible o binario */ }
    }
  }
  return out;
}

const sevColor = { critico: c.red, alto: c.orange, medio: c.yellow, bajo: c.blue };

function printReport(report) {
  const { summary, meta } = report;
  console.log('');
  console.log(`${c.bold('vecinas')} ${c.dim('· análisis de código')}`);
  console.log('');
  console.log(`${c.dim('proyecto')}  ${meta.projectName}`);
  console.log(`${c.dim('archivos')}  ${summary.files}   ${c.dim('líneas')} ${summary.codeLines}   ${c.dim('funciones')} ${summary.functions}`);
  console.log(`${c.dim('riesgo')}    ${summary.risk}/100  ${c.dim('salud')} ${100 - summary.risk}/100  ${c.dim('nota')} ${summary.grade} ${summary.gradeLabel}`);
  console.log(`${c.dim('hallazgos')} ${summary.findings.total} ` +
    `(${c.red(`críticos ${summary.findings.critico}`)}, ${c.orange(`altos ${summary.findings.alto}`)}, ${c.yellow(`medios ${summary.findings.medio}`)}, ${c.blue(`bajos ${summary.findings.bajo}`)})`);

  if (meta.languages.length) {
    console.log('');
    console.log(c.dim('lenguajes: ') + meta.languages.slice(0, 5).map((l) => `${l.name} ${l.pct}%`).join(c.dim(' · ')));
  }

  if (report.insights.length) {
    console.log('');
    console.log(c.bold('Lo que anticipamos'));
    for (const ins of report.insights.slice(0, 6)) {
      const paint = sevColor[ins.severity] || ((s) => s);
      console.log(`  ${paint('●')} ${ins.title}`);
      console.log(`    ${c.dim(ins.detail.slice(0, 150))}`);
    }
  }

  if (report.files.length) {
    console.log('');
    console.log(c.bold('Archivos con más riesgo'));
    for (const f of report.files.slice(0, 8)) {
      const paint = sevColor[f.risk > 60 ? 'critico' : f.risk > 40 ? 'alto' : f.risk > 25 ? 'medio' : 'bajo'];
      console.log(`  ${paint(String(f.risk).padStart(3))}  ${f.path} ${c.dim(`(${f.codeLines} LOC, complejidad ${f.complexity}, ${f.findingCount} hallazgos)`)}`);
      if (f.risk >= 40) console.log(`       ${c.dim(f.prediction)}`);
    }
  }

  const top = report.findings.filter((f) => f.severity === 'critico' || f.severity === 'alto').slice(0, 6);
  if (top.length) {
    console.log('');
    console.log(c.bold('Hallazgos prioritarios'));
    for (const f of top) {
      const paint = sevColor[f.severity] || ((s) => s);
      console.log(`  ${paint(f.severity.padEnd(8))} ${f.path}${f.line ? ':' + f.line : ''} ${c.dim('— ' + f.title)}`);
    }
  }

  if (report.cycles.length) {
    console.log('');
    console.log(c.bold('Ciclos de dependencia'));
    for (const cycle of report.cycles.slice(0, 4)) console.log('  ' + c.orange(cycle.join(' → ') + ' → ↩'));
  }

  console.log('');
}

const started = Date.now();
const files = await collect(target);
if (!files.length) {
  console.error(`No encontré archivos analizables en ${target}`);
  process.exit(2);
}

const report = analyzeProject(files, {
  projectName: path.basename(path.resolve(target)),
  source: { type: 'local', label: target },
  startedAt: started,
});

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printReport(report);
  if (onlyCode) {
    console.log(c.dim('Archivos analizados:'));
    for (const f of report.files) console.log(`  ${f.path}`);
  }
}

if (threshold != null && !Number.isNaN(threshold) && report.summary.risk > threshold) {
  console.error(c.red(`Riesgo global ${report.summary.risk} supera el límite ${threshold}`));
  process.exit(1);
}
