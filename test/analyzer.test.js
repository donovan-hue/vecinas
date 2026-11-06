import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProject, prepareFiles } from '../lib/analyzer.js';
import { stripCode, detectLanguage } from '../lib/lang.js';
import { SAMPLE_FILES } from '../lib/samples.js';
import { parseRepoInput } from '../lib/github.js';

const rulesOf = (report) => new Set(report.findings.map((f) => f.rule));

test('ignora carpetas generadas, archivos binarios y lockfiles', () => {
  const { files, skipped } = prepareFiles([
    { path: 'src/index.js', content: 'const a = 1;\n' },
    { path: 'node_modules/lib/index.js', content: 'module.exports = {};' },
    { path: 'dist/app.min.js', content: 'var a=1;' },
    { path: 'package-lock.json', content: '{}' },
    { path: 'logo.png', content: 'no importa' },
    { path: 'src/binario.js', content: 'const a = "\u0000";' },
  ]);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'src/index.js');
  assert.ok(skipped.length >= 4);
});

test('el enmascarado quita comentarios y strings sin mover las líneas', () => {
  const src = [
    'const saludo = "hola // no es comentario";',
    '// esto sí es comentario',
    'if (saludo === "hola") { console.log(saludo); }',
  ].join('\n');
  const { maskedLines, lines, codeLines } = stripCode(src, 'c');
  assert.equal(lines.length, 3);
  assert.equal(maskedLines.length, 3);
  assert.ok(!maskedLines[0].includes('hola'));
  assert.ok(!maskedLines[1].includes('comentario'));
  assert.ok(maskedLines[2].includes('if ('));
  assert.equal(codeLines, 2);
});

test('detecta lenguajes por extensión', () => {
  assert.equal(detectLanguage('a/b/app.tsx').name, 'TypeScript (TSX)');
  assert.equal(detectLanguage('main.py').family, 'python');
  assert.equal(detectLanguage('Dockerfile').analyzable, false);
  assert.equal(detectLanguage('x.js').isCode, true);
});

test('el proyecto de ejemplo produce un informe coherente', () => {
  const report = analyzeProject(SAMPLE_FILES, { projectName: 'ejemplo' });

  assert.ok(report.summary.files >= 8, 'analiza todos los archivos');
  assert.ok(report.summary.codeLines > 150);
  assert.ok(report.summary.functions > 5);
  assert.ok(report.graph.nodes.length >= 8);
  assert.ok(report.graph.edges.length >= 5, 'encuentra imports internos');
  assert.ok(report.findings.length >= 10);
  assert.equal(report.summary.findings.total, report.findings.length);

  const rules = rulesOf(report);
  for (const expected of ['secret', 'js-eval', 'js-empty-catch', 'py-except-bare', 'py-mutable-default', 'py-sql-injection', 'todo']) {
    assert.ok(rules.has(expected), `debería detectar la regla ${expected}`);
  }

  assert.ok(report.cycles.length >= 1, 'detecta el ciclo auth ↔ users');
  const cyclePaths = report.cycles.flat();
  assert.ok(cyclePaths.some((p) => p.includes('auth')));
  assert.ok(cyclePaths.some((p) => p.includes('users')));

  const risks = report.files.map((f) => f.risk);
  assert.deepEqual(risks, [...risks].sort((a, b) => b - a), 'los archivos vienen ordenados por riesgo');
  assert.ok(report.summary.risk > 10 && report.summary.risk <= 100);
  assert.ok(['A', 'B', 'C', 'D', 'E'].includes(report.summary.grade));
  assert.equal(report.summary.salud, 100 - report.summary.risk);

  assert.ok(report.duplication.blockCount >= 1, 'detecta el archivo copiado');
  assert.ok(report.meta.languages.some((l) => l.name === 'JavaScript'));
  assert.ok(report.meta.languages.some((l) => l.name === 'Python'));
  assert.ok(report.insights.length >= 3);
  assert.ok(report.insights.some((i) => i.id === 'ciclos'));
});

test('encuentra ciclos triangulares y no los duplica', () => {
  const report = analyzeProject(
    [
      { path: 'a.js', content: "import { b } from './b';\nexport const a = 1;\n" },
      { path: 'b.js', content: "import { c } from './c';\nexport const b = 2;\n" },
      { path: 'c.js', content: "import { a } from './a';\nexport const c = 3;\n" },
    ],
    { projectName: 'ciclo' },
  );
  assert.equal(report.cycles.length, 1);
  assert.equal(new Set(report.cycles[0]).size, 3);
  assert.ok(report.files.every((f) => f.inCycle));
  assert.ok(report.findings.some((f) => f.rule === 'ciclo-dependencia'));
});

test('resuelve imports relativos, índices y alias @/', () => {
  const report = analyzeProject(
    [
      { path: 'src/app.js', content: "import x from './lib';\nimport y from '@/utils/format';\nimport z from 'lodash';\n" },
      { path: 'src/lib/index.js', content: 'export default 1;\n' },
      { path: 'src/utils/format.js', content: 'export const y = 1;\n' },
    ],
    { projectName: 'resolucion' },
  );
  const app = report.files.find((f) => f.path === 'src/app.js');
  const targets = app.imports.map((i) => i.target).sort();
  assert.deepEqual(targets, ['src/lib/index.js', 'src/utils/format.js']);
  assert.ok(app.externalImports.some((d) => d.name === 'lodash'));
  assert.ok(report.externalDependencies.some((d) => d.name === 'lodash'));
});

test('reglas de Python: except desnudo, shell=True y SQL interpolado', () => {
  const py = [
    'import subprocess',
    'def correr(cmd):',
    '    subprocess.run(cmd, shell=True)',
    '    try:',
    '        valor = int("1")',
    '    except:',
    '        pass',
    '    cursor.execute(f"DELETE FROM t WHERE id = {valor}")',
    '',
  ].join('\n');
  const report = analyzeProject([{ path: 'tarea.py', content: py }], { projectName: 'py' });
  const rules = rulesOf(report);
  assert.ok(rules.has('py-shell-true'));
  assert.ok(rules.has('py-except-bare'));
  assert.ok(rules.has('py-sql-injection'));
});

test('no marca como secreto lo que viene de variables de entorno', () => {
  const js = [
    "const apiKey = process.env.API_KEY;",
    "const token = 'short';",
    "const password = 'unaClaveLargaDeVerdad123';",
  ].join('\n');
  const report = analyzeProject([{ path: 'cfg.js', content: js }], { projectName: 'secretos' });
  const secrets = report.findings.filter((f) => f.rule === 'secret');
  assert.equal(secrets.length, 1);
  assert.equal(secrets[0].line, 3);
});

test('los archivos grandes se recortan y queda registrado', () => {
  const big = Array.from({ length: 6100 }, (_, i) => `const v${i} = ${i};`).join('\n');
  const report = analyzeProject([{ path: 'grande.js', content: big }], { projectName: 'grande' });
  assert.equal(report.files[0].truncated, true);
  assert.ok(report.files[0].codeLines <= 6000);
});

test('parseRepoInput acepta las formas habituales de GitHub', () => {
  assert.deepEqual(parseRepoInput('https://github.com/expressjs/express'), { owner: 'expressjs', repo: 'express', ref: null });
  assert.deepEqual(parseRepoInput('expressjs/express.git'), { owner: 'expressjs', repo: 'express', ref: null });
  assert.deepEqual(parseRepoInput('https://github.com/facebook/react/tree/main/packages'), {
    owner: 'facebook', repo: 'react', ref: 'main/packages',
  });
  assert.deepEqual(parseRepoInput('git@github.com:owner/repo.git'), { owner: 'owner', repo: 'repo', ref: null });
  assert.throws(() => parseRepoInput('https://gitlab.com/a/b'), /github\.com/);
});

test('un proyecto vacío no rompe el análisis', () => {
  const report = analyzeProject([], { projectName: 'vacío' });
  assert.equal(report.summary.files, 0);
  assert.equal(report.summary.risk, 0);
  assert.deepEqual(report.findings, []);
  assert.equal(report.summary.grade, 'A');
});
