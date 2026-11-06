/**
 * Reglas de Vecinas: qué se considera señal de un error futuro.
 *
 * Cada hallazgo lleva severidad, categoría, explicación y arreglo sugerido,
 * porque el objetivo no es asustar sino decir qué hacer.
 */

export const SEVERITY_WEIGHT = { critico: 25, alto: 12, medio: 5, bajo: 1.5 };

const JS_EXTS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte']);
const C_LIKE_EXTS = new Set(['java', 'go', 'cs', 'kt', 'kts', 'scala', 'swift', 'dart', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'rs', 'php']);

const MAX_PER_RULE = 6;
const MAX_PER_FILE = 120;

export function analyzeRules(file, ctx = {}) {
  const { masked, lines, maskedLines } = file.stripped;
  const ext = file.language.ext;
  const family = file.language.family;
  const findings = [];
  const seen = new Set();

  const snippetOf = (line) => (lines[line - 1] || '').trim().slice(0, 180);

  const add = (rule, severity, category, title, detail, fix, line, extra = {}) => {
    if (findings.length >= MAX_PER_FILE) return;
    const key = `${rule}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      rule, severity, category, title, detail, fix,
      path: file.path,
      line: line || null,
      snippet: line ? snippetOf(line) : '',
      ...extra,
    });
  };

  const scan = (pattern, handler, { max = MAX_PER_RULE, source = maskedLines } = {}) => {
    let count = 0;
    for (let i = 0; i < source.length; i++) {
      if (count >= max) break;
      const line = source[i];
      if (!line) continue;
      const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      let m;
      while ((m = re.exec(line)) !== null) {
        if (count >= max) break;
        if (handler(m, i + 1, line) !== false) count++;
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
  };

  /* ------------------------- genéricas ------------------------- */

  scan(/\b(TODO|FIXME|HACK|XXX)\b/, (m, line) => {
    if (!/(TODO|FIXME|HACK|XXX)/.test(lines[line - 1] || '')) return false;
    const label = m[1];
    add('todo', 'bajo', 'mantenibilidad', `Pendiente marcado: ${label}`,
      'Quien escribió el código dejó aquí una duda o una deuda conocida.',
      'Conviértelo en una tarea con responsable o resuélvelo antes de que crezca.',
      line);
  }, { max: 8, source: lines });

  const isFixture = /(^|\/)(test|tests|__tests__|spec|fixtures?|samples?|examples?)(\/|\.|$)/i.test(file.path);
  scan(/(?:api[_-]?key|apikey|secret|password|passwd|token|private[_-]?key|access[_-]?key)\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/i, (m, line) => {
    if (isFixture) return false;
    const text = lines[line - 1] || '';
    if (/(process\.env|os\.environ|import\.meta\.env|example|placeholder|xxxx|dummy|demo|ejemplo|fake|sample|<.*>|\$\{)/i.test(text)) return false;
    add('secret', 'critico', 'seguridad', 'Posible secreto escrito en el código',
      'Hay una credencial literal. Cualquiera con acceso al repositorio (o al historial) puede usarla.',
      'Llévala a una variable de entorno, elimínala del historial y rota la llave.',
      line);
  }, { max: 5, source: lines });

  const nonLogic = file.language.family === 'css' || file.language.family === 'markup';
  if (file.codeLines > 500 && !nonLogic && file.isCode !== false) {
    add('archivo-largo', 'medio', 'mantenibilidad', 'Archivo demasiado grande',
      `${file.codeLines} líneas de código en un solo archivo: cuesta leerlo completo y cada cambio obliga a recorrerlo entero.`,
      'Divide por responsabilidad; archivos de 200-300 líneas se revisan mejor.', null);
  }

  if (file.maxDepth >= 10 && !nonLogic) {
    add('anidamiento', 'alto', 'mantenibilidad', 'Anidamiento excesivo',
      `${file.maxDepth} niveles de anidación: la lógica es difícil de seguir y hay combinaciones que nadie prueba.`,
      'Usa retornos tempranos (early return) y extrae bloques internos a funciones.', null);
  } else if (file.maxDepth >= 6 && !nonLogic) {
    add('anidamiento-medio', 'medio', 'mantenibilidad', 'Anidamiento profundo',
      `${file.maxDepth} niveles de bloques anidados.`,
      'Aplana con retornos tempranos.', null);
  }

  const isStyle = file.language.family === 'css' || file.language.family === 'markup' || file.language.family === 'sql';
  const fnCount = file.functions.length;
  const avgFnComplexity = file.avgFunctionComplexity ?? (fnCount ? file.complexity / fnCount : 0);

  if (!isStyle) {
    if (avgFnComplexity >= 24 || (!fnCount && file.complexity >= 150)) {
      add('complejidad-alta', 'alto', 'mantenibilidad', 'Complejidad ciclomática muy alta',
        `Media de ${avgFnComplexity.toFixed(1)} caminos por función: muchas combinaciones que nadie prueba.`,
        'Divide el archivo en funciones con una sola decisión cada una.', null);
    } else if (avgFnComplexity >= 12 || (!fnCount && file.complexity >= 60)) {
      add('complejidad-media', 'medio', 'mantenibilidad', 'Complejidad elevada',
        `Media de ${avgFnComplexity.toFixed(1)} caminos por función.`,
        'Identifica la función con más ramas y divídela.', null);
    }
  }

  for (const fn of file.functions) {
    if (fn.lines >= 90) {
      add('funcion-larga', 'medio', 'mantenibilidad', `Función ${fn.name} muy larga`,
        `${fn.lines} líneas en una sola función, con complejidad ${fn.complexity}.`,
        'Separa preparación, cálculo y salida en funciones distintas.', fn.line);
      break;
    }
  }

  const longFn = file.functions.slice().sort((a, b) => b.complexity - a.complexity)[0];
  if (longFn && longFn.complexity >= 25) {
    add('funcion-compleja', 'alto', 'mantenibilidad', `Función ${longFn.name} con demasiadas ramas`,
      `Complejidad ${longFn.complexity} en ${longFn.lines} líneas: cada rama nueva multiplica los casos límite.`,
      'Extrae condiciones a funciones con nombre propio y simplifica los `if` anidados.', longFn.line);
  }

  /* --------------------------- JavaScript / TypeScript --------------------------- */

  const catchBlocks = () => {
    const occurrences = [];
    for (let i = 0; i < maskedLines.length; i++) {
      const m = maskedLines[i].match(/\bcatch\s*(?:\([^)]*\))?\s*\{/);
      if (!m) continue;
      // Cuerpo: desde el `{` de la misma línea (o las siguientes) hasta cerrar.
      let depth = 0;
      let body = '';
      let started = false;
      let endLine = i;
      for (let j = i; j < Math.min(maskedLines.length, i + 120); j++) {
        const src = j === i ? maskedLines[j].slice(maskedLines[j].indexOf(m[0]) + m[0].lastIndexOf('{')) : maskedLines[j];
        for (const ch of src) {
          if (ch === '{') { depth++; started = true; body += ch; }
          else if (ch === '}') { depth--; body += ch; }
          else body += ch;
        }
        endLine = j;
        if (started && depth <= 0) break;
      }
      const raw = lines.slice(i, endLine + 1).join('\n');
      occurrences.push({ line: i + 1, body: body.replace(/[{}]/g, ' ').trim(), raw });
    }
    return occurrences;
  };

  // Un catch vacío pero con un comentario está justificado a propósito.
  const hasJustification = (raw) => /\/\/|\/\*|#/.test(raw);

  if (JS_EXTS.has(ext)) {
    scan(/\beval\s*\(/, (m, line) => {
      add('js-eval', 'critico', 'seguridad', 'Uso de eval()',
        'eval ejecuta texto como código: si algo de fuera influye en ese texto, tienes ejecución remota.',
        'Sustituye por JSON.parse, un mapa de funciones o un parser explícito.', line);
    });

    scan(/new\s+Function\s*\(/, (m, line) => {
      add('js-new-function', 'alto', 'seguridad', 'Función creada desde texto',
        'new Function compila cadenas en tiempo de ejecución, con los mismos riesgos que eval.',
        'Evita generarla dinámicamente; usa funciones declaradas.', line);
    });

    scan(/\.(innerHTML|outerHTML)\s*\+?=/, (m, line) => {
      if (/=\s*(['"`])\1\s*;?\s*$/.test(lines[line - 1] || '')) return false;
      add('js-innerhtml', 'alto', 'seguridad', 'HTML inyectado con innerHTML',
        'Asignar innerHTML con datos externos abre la puerta a XSS: el navegador ejecuta lo que llegue.',
        'Usa textContent, o sanea con una librería (DOMPurify) antes de insertar HTML.', line);
    }, { max: 3 });

    scan(/dangerouslySetInnerHTML/, (m, line) => {
      add('js-dangerously', 'alto', 'seguridad', 'dangerouslySetInnerHTML en React',
        'El nombre lo advierte: React no puede escapar ese HTML.',
        'Sanea el contenido o reemplázalo por nodos de React.', line);
    });

    for (const block of catchBlocks()) {
      if (block.body.length === 0 && !hasJustification(block.raw)) {
        add('js-empty-catch', 'alto', 'errores', 'catch vacío: el error desaparece',
          'Se captura la excepción y no se hace nada. El flujo continúa con datos inconsistentes y el fallo real aparece mucho después.',
          'Registra con contexto o vuelve a lanzar (throw). Si es intencional, coméntalo.', block.line);
      } else if (!hasJustification(block.raw) && !/\bthrow\b|[A-Za-z_$][\w$.]*\s*\(/.test(block.body)) {
        add('js-catch-silent', 'medio', 'errores', 'catch que no registra ni propaga',
          'El bloque captura el error pero no lo registra, no lo re-lanza y no informa a nadie: queda silenciado.',
          'Registra el error o vuelve a lanzarlo; nunca lo descartes en silencio.', block.line);
      }
    }

    scan(/\.then\s*\(/, (m, line, text) => {
      const window = maskedLines.slice(Math.max(0, line - 1), line + 3).join(' ');
      if (/\.catch\s*\(/.test(text) || /\.catch\s*\(/.test(window) || /try\s*\{/.test(maskedLines[line - 2] || '')) return false;
      if (!window.includes('.catch(')) {
        add('js-then-sin-catch', 'medio', 'errores', 'Promesa sin manejo de error',
          'Un .then sin .catch deja la excepción como "unhandled rejection": según el runtime, proceso caído o aviso perdido.',
          'Añade .catch(…) o usa async/await dentro de try/catch.', line);
      }
    }, { max: 4 });

    scan(/JSON\.parse\s*\(/, (m, line) => {
      const context = maskedLines.slice(Math.max(0, line - 4), line + 2).join(' ');
      if (/try\s*\{/.test(context)) return false;
      add('js-json-parse', 'medio', 'errores', 'JSON.parse sin protección',
        'Si el texto viene de fuera (API, archivo, localStorage) puede no ser JSON válido y lanzar SyntaxError.',
        'Envuelve la llamada en try/catch y valida la forma del objeto.', line);
    }, { max: 4 });

    scan(/[^=!<>]==[^=]/, (m, line) => {
      if (/[=!<>]===/.test(maskedLines[line - 1])) return false;
      add('js-igualdad-laxa', 'bajo', 'errores', 'Comparación con == (igualdad laxa)',
        '== convierte tipos antes de comparar: 0 == "0" es true y "1" == 1 también. De ahí salen condiciones que se cumplen cuando no deberían.',
        'Usa === y !==.', line);
    }, { max: 5 });

    if (!file.isTest) {
      scan(/console\.(log|debug|info)\s*\(/, (m, line) => {
        add('js-console', 'bajo', 'calidad', 'console.log olvidado',
          'Salida de depuración dentro del código de producción: ruido en logs y, a veces, datos sensibles impresos.',
          'Usa un logger con niveles o elimínalo.', line);
      }, { max: 3 });
    }

    scan(/^\s*var\s+/, (m, line) => {
      add('js-var', 'bajo', 'calidad', 'Declaración con var',
        'var se "eleva" al inicio de la función y no respeta el bloque: provoca valores inesperados en bucles y callbacks.',
        'Usa const (o let si de verdad se reasigna).', line);
    }, { max: 3 });

    scan(/\bdebugger\b/, (m, line) => {
      add('js-debugger', 'medio', 'calidad', 'Sentencia debugger',
        'Si llega a producción, congela la ejecución donde el usuario abra las herramientas de desarrollo.',
        'Quítala antes de publicar.', line);
    });

    scan(/(?:readFileSync|writeFileSync|appendFileSync|execSync|readdirSync)\s*\(/, (m, line) => {
      add('js-fs-sync', 'medio', 'rendimiento', 'Operación de disco síncrona',
        'Bloquea el event loop: mientras espera el disco, el servidor no atiende a nadie.',
        'Usa las versiones con promesas (fs.promises) o callbacks.', line);
    }, { max: 3 });

    scan(/\bsetInterval\s*\(/, (m, line) => {
      add('js-setinterval', 'bajo', 'rendimiento', 'setInterval sin limpieza',
        'Si no se guarda el id y se llama clearInterval, el temporizador sigue vivo tras desmontar o cerrar.',
        'Guarda el id y límpialo en el cleanup.', line);
    }, { max: 3 });

    scan(/@ts-(ignore|nocheck)/, (m, line) => {
      add('js-ts-ignore', 'medio', 'calidad', 'TypeScript silenciado',
        `@ts-${m[1]} apaga al compilador justo donde avisaba de un problema real.`,
        'Corrige el tipo; si no puedes, usa un cast puntual documentado.', line);
    });

    scan(/parseInt\s*\(\s*[^,)]+\)/, (m, line) => {
      add('js-parseint', 'bajo', 'errores', 'parseInt sin base',
        'Sin radix, "08" y otros casos dependen de la implementación y pueden dar resultados inesperados.',
        'Pasa siempre la base: parseInt(valor, 10).', line);
    }, { max: 3 });

    if (ext === 'ts' || ext === 'tsx') {
      scan(/:\s*any\b/, (m, line) => {
        add('ts-any', 'bajo', 'calidad', 'Tipo any',
          'any desactiva la comprobación de tipos: los errores que TypeScript detectaría pasan a tiempo de ejecución.',
          'Usa unknown con validación o define una interfaz concreta.', line);
      }, { max: 3 });
    }

    scan(/while\s*\(\s*true\s*\)/, (m, line) => {
      add('js-while-true', 'medio', 'errores', 'Bucle infinito explícito',
        'Solo es seguro si hay una salida clara (break/return) en todos los caminos.',
        'Condiciona el bucle o documenta la salida.', line);
    });

    scan(/(['"`])[^'"`]{0,400}\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b[^'"`]{0,400}\1[^;]{0,40}(\+|\$\{)/i, (m, line) => {
      if (file.isTest) return false;
      add('sql-concat', 'alto', 'seguridad', 'Consulta SQL construida con concatenación',
        'Si algún valor viene del usuario, es inyección SQL: puede leer, alterar o borrar toda la base.',
        'Usa consultas parametrizadas (placeholders) del driver.', line);
    }, { max: 3, source: lines });

    scan(/http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/, (m, line) => {
      add('url-insegura', 'bajo', 'seguridad', 'URL sin cifrar (http://)',
        'El tráfico viaja en claro y puede modificarse en el camino.',
        'Cambia a https://.', line);
    }, { max: 3, source: lines });

    scan(/(localhost|127\.0\.0\.1):\d+/, (m, line) => {
      add('url-local', 'bajo', 'portabilidad', 'Dirección local escrita en el código',
        'Al desplegar, localhost apunta al contenedor del propio servicio, no al de la base o la API.',
        'Muévela a configuración por entorno.', line);
    }, { max: 2, source: lines });
  }

  /* ------------------------------- Python ------------------------------- */

  if (family === 'python') {
    scan(/\b(eval|exec)\s*\(/, (m, line) => {
      add('py-eval', 'critico', 'seguridad', `Uso de ${m[1]}()`,
        `${m[1]} ejecuta código arbitrario; con datos externos es ejecución remota de código.`,
        'Usa ast.literal_eval para datos o un despachador de funciones permitidas.', line);
    });

    for (let i = 0; i < maskedLines.length; i++) {
      const line = maskedLines[i];
      if (!line) continue;

      if (/^\s*except\s*:/.test(line)) {
        add('py-except-bare', 'alto', 'errores', 'except desnudo',
          'Captura también KeyboardInterrupt y SystemExit, y oculta cualquier error, incluso los de programación.',
          'Captura la excepción concreta: except ValueError as e.', i + 1);
        continue;
      }

      if (!/^\s*except\b/.test(line)) continue;

      // Cuerpo del bloque (enmascarado y original) por indentación.
      const baseIndent = line.match(/^\s*/)[0].length;
      let body = '';
      let raw = '';
      for (let j = i + 1; j < Math.min(maskedLines.length, i + 8); j++) {
        const l = maskedLines[j];
        if (!l.trim()) { raw += (lines[j] || '') + '\n'; continue; }
        const ind = l.match(/^\s*/)[0].length;
        if (ind <= baseIndent) break;
        body += ' ' + l.trim();
        raw += (lines[j] || '') + '\n';
      }

      const trimmedBody = body.trim();
      const broad = /^except\s+(Exception|BaseException)\b/.test(line.trim());
      const justified = /#/.test(raw);

      if (justified) continue; // hay un comentario explicando por qué se ignora
      if (/^(continue|break|return)\b/.test(trimmedBody)) continue; // control de flujo explícito

      if (/^(pass|\.\.\.)$/.test(trimmedBody)) {
        if (broad) {
          add('py-except-pass', 'alto', 'errores', 'except Exception con pass: error tragado',
            'Se atrapa cualquier error y se descarta: el programa sigue con estado inconsistente y sin rastro del fallo.',
            'Registra con logging.exception(...) o re-lanza con raise.', i + 1);
        } else {
          add('py-except-pass', 'medio', 'errores', 'except con pass',
            'La excepción se ignora sin dejar rastro. Si es intencional, un comentario lo aclara; si no, oculta errores.',
            'Registra la excepción o añade un comentario explicando por qué se ignora.', i + 1);
        }
      } else if (broad && !/\braise\b|\blogging\b|\blogger\b|\blog\./.test(body)) {
        add('py-except-generico', 'medio', 'errores', 'except Exception demasiado amplio',
          'Atrapa errores de programación (typos, tipos) junto con los esperados.',
          'Captura solo las excepciones que sabes manejar.', i + 1);
      }
    }

    scan(/def\s+\w+\s*\([^)]*=\s*(\[\]|\{\}|set\(\))/, (m, line) => {
      add('py-mutable-default', 'alto', 'errores', 'Argumento por defecto mutable',
        'El valor por defecto se crea una sola vez y se comparte entre llamadas: los datos se acumulan de forma invisible.',
        'Usa None como defecto y créalo dentro de la función.', line);
    });

    scan(/shell\s*=\s*True/, (m, line) => {
      add('py-shell-true', 'critico', 'seguridad', 'subprocess con shell=True',
        'Pasa la orden por el intérprete de comandos: un valor externo puede encadenar comandos arbitrarios.',
        'Pasa una lista de argumentos y deja shell=False.', line);
    });

    scan(/os\.(system|popen)\s*\(/, (m, line) => {
      add('py-os-system', 'alto', 'seguridad', `Ejecución con os.${m[1]}`,
        'Construir comandos con texto externo permite inyección de comandos.',
        'Usa subprocess.run([...], check=True) con argumentos separados.', line);
    }, { max: 3 });

    scan(/pickle\.loads?\s*\(/, (m, line) => {
      add('py-pickle', 'alto', 'seguridad', 'Deserialización con pickle',
        'Un pickle malicioso ejecuta código al cargarse. No es un formato seguro para datos no confiables.',
        'Usa JSON o un formato con esquema validado.', line);
    }, { max: 2 });

    scan(/yaml\.load\s*\(/, (m, line) => {
      if (/Loader\s*=\s*yaml\.(Safe|CSafe)Loader/.test(maskedLines[line - 1] || '')) return false;
      add('py-yaml-load', 'alto', 'seguridad', 'yaml.load sin cargador seguro',
        'El cargador por defecto puede instanciar objetos arbitrarios a partir del documento.',
        'Usa yaml.safe_load().', line);
    }, { max: 2 });

    const sqlFinding = (line) => add('py-sql-injection', 'alto', 'seguridad', 'SQL construido con interpolación',
      'La consulta se arma pegando valores dentro del texto: si alguno viene del usuario, es inyección SQL.',
      'Pasa los valores como parámetros: cursor.execute(sql, (valor,)).', line);

    // execute("... %s" % valor) / .format(...) dentro de una llamada
    scan(/(execute|executemany)\s*\(/, (m, line) => {
      const original = lines[line - 1] || '';
      const interpolado = /(f['"][^'"]*\b(SELECT|INSERT|UPDATE|DELETE)\b)|\.format\(|['"]\s*%\s*\(?\w/i.test(original);
      if (!interpolado) return false;
      sqlFinding(line);
    }, { max: 3, source: lines });

    // f-string con SQL en cualquier parte (asignaciones, concatenaciones…)
    scan(/\bf['"][^'"]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^'"]*\{/i, (m, line) => {
      sqlFinding(line);
    }, { max: 3, source: lines });

    scan(/\bopen\s*\(/, (m, line) => {
      if (/^\s*with\b|\bwith\s+open/.test(maskedLines[line - 1] || '')) return false;
      const context = maskedLines.slice(line - 1, line + 1).join(' ');
      if (/with\s+open/.test(context)) return false;
      add('py-open-sin-with', 'medio', 'errores', 'open() sin context manager',
        'Si algo falla entre open y close, el archivo queda abierto: descriptor filtrado y datos sin volcar.',
        'Usa: with open(ruta) as f:', line);
    }, { max: 3 });

    if (!file.isTest) {
      scan(/^\s*print\s*\(/, (m, line) => {
        add('py-print', 'bajo', 'calidad', 'print en el código',
          'La salida por print no tiene niveles ni destino configurable; en producción se pierde o ensucia.',
          'Usa logging.', line);
      }, { max: 3 });
    }

    scan(/^\s*global\s+\w+/, (m, line) => {
      add('py-global', 'bajo', 'calidad', 'Variable global modificada',
        'El estado global hace que el resultado dependa de quién llamó antes: fallos que no se reproducen.',
        'Pasa el estado como parámetro o encapsúlalo en un objeto.', line);
    }, { max: 3 });

    scan(/^\s*assert\s+/, (m, line) => {
      add('py-assert', 'bajo', 'errores', 'assert para validar datos',
        'Con python -O los assert se eliminan: la validación desaparece justo en producción.',
        'Usa if + raise ValueError.', line);
    }, { max: 3 });

    scan(/from\s+[\w.]+\s+import\s+\*/, (m, line) => {
      add('py-import-star', 'medio', 'calidad', 'Import con asterisco',
        'Trae nombres sin control: puede pisar funciones locales y vuelve ilegible el origen de cada símbolo.',
        'Importa explícitamente lo que uses.', line);
    }, { max: 3 });

    scan(/verify\s*=\s*False/, (m, line) => {
      add('py-verify-false', 'alto', 'seguridad', 'Verificación TLS desactivada',
        'La conexión deja de comprobar el certificado: cualquiera en la red puede interceptarla.',
        'Quita verify=False; si el certificado es propio, pásalo en verify="/ruta/ca.pem".', line);
    }, { max: 2 });
  }

  /* --------------------------- Java / Go / C# / Rust / PHP --------------------------- */

  if (C_LIKE_EXTS.has(ext)) {
    scan(/\beval\s*\(/, (m, line) => {
      add('gen-eval', 'critico', 'seguridad', 'Uso de eval()',
        'Evaluar texto como código permite ejecución arbitraria si el contenido no está controlado.',
        'Sustituye por un despachador o un parser seguro.', line);
    });

    for (const block of catchBlocks()) {
      if (block.body.length === 0 && !hasJustification(block.raw)) {
        add('gen-empty-catch', 'alto', 'errores', 'Bloque catch vacío',
          'La excepción se descarta sin dejar rastro: el programa sigue con estado inválido.',
          'Registra el error o relánzalo.', block.line);
      }
    }

    scan(/(['"`])[^'"`]{0,300}\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b[^'"`]{0,300}\1[^;]{0,40}(\+|\$\{)/i, (m, line) => {
      if (file.isTest) return false;
      add('gen-sql-concat', 'alto', 'seguridad', 'Consulta SQL concatenada',
        'La concatenación de valores en SQL es la vía clásica de inyección.',
        'Usa PreparedStatement / consultas parametrizadas.', line);
    }, { max: 3, source: lines });

    scan(/System\.out\.print|fmt\.Print|Console\.WriteLine/, (m, line) => {
      add('gen-print', 'bajo', 'calidad', 'Salida por consola',
        'La impresión directa no permite niveles ni recolectores de logs.',
        'Usa el logger del framework.', line);
    }, { max: 2 });
  }

  /* --------------------------------- Shell --------------------------------- */

  if (family === 'shell') {
    scan(/\brm\s+-rf?\s+["']?\$\{?(\w+)/, (m, line) => {
      add('sh-rm-variable', 'alto', 'seguridad', 'rm -rf con variable sin comillas',
        'Si la variable está vacía o mal definida, el comando puede borrar el directorio actual o la raíz.',
        'Entrecomilla y valida: rm -rf -- "${dir:?}/"', line);
    }, { max: 3 });

    scan(/(curl|wget)[^|]*\|\s*(sudo\s+)?(ba)?sh/, (m, line) => {
      add('sh-curl-bash', 'alto', 'seguridad', 'Descargar y ejecutar en una sola línea',
        'Se ejecuta lo que devuelva la red, sin verificar contenido ni firma.',
        'Descarga, verifica checksum y luego ejecuta.', line);
    }, { max: 2 });

    if (!/^\s*set\s+-[eu]/m.test(masked) && file.codeLines > 25) {
      add('sh-sin-set-e', 'medio', 'errores', 'Script sin set -e',
        'Sin esa opción, el script ignora comandos fallidos y termina "con éxito" habiendo hecho la mitad del trabajo.',
        'Añade set -euo pipefail al inicio.', 1);
    }
  }

  /* ------------------------------- HTML / markup ------------------------------- */

  if (family === 'markup' && (ext === 'html' || ext === 'htm')) {
    scan(/<[^>]+\son\w+\s*=\s*["']/i, (m, line) => {
      add('html-inline-handler', 'medio', 'seguridad', 'Manejador de eventos inline',
        'Mezcla estructura y lógica y dificulta aplicar CSP; además complica escapar datos.',
        'Asocia eventos con addEventListener desde un archivo JS.', line);
    }, { max: 3, source: lines });

    scan(/target\s*=\s*["']_blank["']/i, (m, line) => {
      if (/rel\s*=\s*["'][^"']*noopener/i.test(lines[line - 1] || '')) return false;
      add('html-blank', 'bajo', 'seguridad', 'target="_blank" sin noopener',
        'La página abierta puede manipular window.opener y redirigir la original (tabnabbing).',
        'Añade rel="noopener noreferrer".', line);
    }, { max: 3, source: lines });
  }

  return findings;
}
