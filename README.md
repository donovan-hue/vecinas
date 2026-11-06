# vecinas

**Analiza, visualiza y anticipa los errores del código de cualquier aplicación.**

Vecinas lee un proyecto (un repositorio de GitHub, una carpeta o un archivo pegado),
mide cómo está construido, dibuja el mapa de dependencias entre sus archivos y marca
los puntos donde es más probable que aparezca un fallo. **No ejecuta el código que
analiza**: lo trata como texto.

```
archivos 216 · líneas 16 222 · funciones 1 480
salud 76/100 · nota B · 499 hallazgos (0 críticos, 1 alto, 71 medios, 427 bajos)
```

---

## Arrancar

Requiere Node.js 20 o superior. No hay dependencias de ejecución: el proyecto usa
sólo módulos nativos de Node.

```bash
npm start           # http://localhost:3000
npm run dev         # con recarga automática
npm test            # 18 pruebas (motor + API)
```

También funciona como comando sobre una carpeta local:

```bash
node bin/vecinas.js .                 # informe legible en la terminal
node bin/vecinas.js ./mi-app --json   # informe completo en JSON
node bin/vecinas.js . --limite 40     # exit 1 si el riesgo global supera 40
```

Y como API:

```bash
curl -s localhost:3000/api/analyze \
  -H 'Content-Type: application/json' \
  -d '{"type":"github","repo":"expressjs/express"}'
```

---

## Las tres puertas de entrada

| Origen | Cómo | Detalle |
|---|---|---|
| **GitHub** | URL, `usuario/repo` o `usuario/repo.git` | Descarga un único zipball desde `codeload.github.com` (rápido, sin rate limit agresivo). Reconoce ramas: `.../tree/mi-rama`. |
| **Archivos** | Arrastrar carpeta/archivos o elegirlos | Se leen en el navegador y viajan al servidor sólo para el análisis. |
| **Pegar** | Un archivo suelto en el cuadro de texto | Útil para revisar un fragmento antes de integrarlo. |

Con `GITHUB_TOKEN` (o `GH_TOKEN`) en el entorno también se pueden analizar
repositorios privados.

---

## Qué detecta

El motor combina tres capas: métricas estructurales, grafo de dependencias y reglas
de riesgo con severidad, explicación y arreglo sugerido.

**Errores y fallos silenciosos**
- `catch` vacío o que no registra ni propaga · `except` desnudo o con `pass`
- promesas sin `.catch` · `JSON.parse` sin protección · `parseInt` sin base
- argumentos por defecto mutables en Python · comparaciones con `==`

**Seguridad**
- `eval`, `new Function`, `exec` · `innerHTML` / `dangerouslySetInnerHTML`
- secretos escritos en el código · SQL construido por concatenación o f-string
- `shell=True`, `os.system`, `pickle.load`, `yaml.load`, `verify=False`
- `rm -rf` con variable sin comillas, `curl | bash`, `target="_blank"` sin `noopener`

**Estructura y mantenibilidad**
- dependencias circulares · archivos que nadie importa · nodos con demasiadas entradas
- complejidad por función, anidamiento excesivo, funciones y archivos gigantes
- duplicación de bloques entre archivos · `TODO`/`FIXME` acumulados
- TypeScript silenciado (`@ts-ignore`), operaciones de disco síncronas, `debugger`

**Stack y arquitectura**
- runtimes y frameworks detectados por manifiestos (`package.json`, `pyproject.toml`,
  `go.mod`, `Cargo.toml`, `composer.json`, `Gemfile`), Docker, CI, Prisma…
- puntos de entrada (por nombre habitual o shebang) y áreas del proyecto

Cada hallazgo incluye **severidad**, **categoría**, **explicación del riesgo**,
**fragmento exacto** y **arreglo sugerido**.

---

## Cómo se calcula el riesgo

Para cada archivo, un puntaje de 0 a 100 que resume su exposición:

```
riesgo = complejidad por función (máx. 28)
       + hallazgos ponderados por severidad (máx. 28)
       + tamaño (máx. 12)
       + estar dentro de un ciclo (+12)
       + centralidad: cuántos archivos dependen de él (máx. 10)
       + ausencia de pruebas (hasta +6)
       + duplicación (máx. 10)
```

El riesgo global mezcla los archivos más riesgosos, el promedio del proyecto, la
densidad de hallazgos por archivo y los ciclos. Se convierte en una **nota A–E**
y en una lista de predicciones del tipo *«falla probable en errores silenciados»*.

Todo es heurístico y determinista: sirve para **priorizar la revisión**, no para
certificar que un programa funciona.

---

## Cómo está hecho

```
server.js              servidor HTTP (estático + API), sin frameworks
lib/analyzer.js        motor: métricas, grafo, ciclos, duplicación, riesgo, insights
lib/rules.js           reglas de riesgo por lenguaje, con severidad y arreglo
lib/lang.js            detección de lenguaje + enmascarado de strings/comentarios/regex
lib/github.js          descarga de repositorios (zipball) y metadatos
lib/zip.js             lector de ZIP propio (sin dependencias)
lib/http.js            cliente HTTPS con CA del sistema y redirecciones
lib/samples.js         proyecto de ejemplo con errores típicos
public/                interfaz: HTML, CSS y JS sin build
bin/vecinas.js         CLI para carpetas locales
test/                  pruebas del motor y de la API
```

Dos decisiones clave:

1. **Enmascarado antes de analizar.** Strings, comentarios y literales de expresión
   regular se sustituyen por espacios conservando los saltos de línea. Así una regla
   no se dispara con texto dentro de un string y los números de línea reportados
   siguen siendo exactos.
2. **Grafo real, no decorativo.** Cada `import` se resuelve a un archivo concreto
   (rutas relativas, extensiones omitidas, `index`, alias `@/`, módulos de Python con
   `src/`). Sobre ese grafo se buscan ciclos, huérfanos y nodos centrales.

La interfaz dibuja la red con una simulación de fuerzas propia sobre SVG, con estética
de red neuronal: cada archivo es una neurona (halo, núcleo y anillo), cada dependencia
una sinapsis curva y las señales viajan por ellas en bucle. Las neuronas más conectadas
también disparan solas, y al hacer clic en una la señal se propaga a sus vecinas. Todo
se puede pausar con el interruptor **Flujo** y respeta `prefers-reduced-motion`.

Además: colorear por riesgo o por lenguaje, filtrar hallazgos por severidad y abrir la
ficha de cada archivo.

---

## Límites

- Hasta **400 archivos** por análisis, **512 KB** por archivo y **6 000 líneas** por
  archivo (el resto se recorta y se informa).
- Se ignoran `node_modules`, `dist`, `build`, `vendor`, entornos virtuales, binarios,
  imágenes y lockfiles.
- Repositorios de hasta **60 MB** descargados.
- El análisis es estático: no ejecuta código ni instala dependencias, así que no ve
  lo que sólo ocurre en tiempo de ejecución (red, base de datos, variables de entorno).

---

## Privacidad

El análisis ocurre en el servidor que ejecutes. Los archivos viajan en la petición,
se procesan en memoria y no se guardan en disco ni se envían a ningún servicio externo.

---

## Pruebas

```bash
npm test
```

Cubren el filtrado de archivos, el enmascarado, la resolución de imports, la
detección de ciclos y duplicación, las reglas de JavaScript y Python, el parser de
URLs de GitHub, el recorte de archivos gigantes y los endpoints del servidor.

---

MIT.
