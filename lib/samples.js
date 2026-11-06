/**
 * Proyecto de ejemplo ("Vecindario API") para probar el analizador sin red.
 * Está escrito a propósito con errores típicos: así se ve qué detecta Vecinas.
 */

export const SAMPLE_NAME = 'vecindario-api (ejemplo)';

const server = `const express = require('express');
const { login } = require('./src/auth');
const users = require('./src/routes/users');
const { formatoFecha } = require('./src/utils/format');

const app = express();
const API_KEY = "sk_live_9f8a7b6c5d4e3f2a1b";

app.use(express.json());

app.post('/login', async (req, res) => {
  try {
    const token = await login(req.body.email, req.body.password);
    res.json({ token });
  } catch (e) {
  }
});

app.get('/reporte', (req, res) => {
  const id = req.query.id;
  if (id == null) {
    return res.status(400).send('falta id');
  }
  const datos = users.buscar(id);
  res.send({ datos, fecha: formatoFecha(new Date()) });
});

app.get('/debug', (req, res) => {
  const expresion = req.query.exp;
  res.send(String(eval(expresion)));
});

app.use((req, res, next) => {
  console.log('peticion', req.method, req.url);
  next();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('escuchando en http://localhost:' + PORT);
});

module.exports = app;
`;

const auth = `const db = require('./db');
const { hash } = require('./crypto-utils');
const { registrar } = require('./routes/users');

async function login(email, password) {
  const usuario = db.buscarPorEmail(email);
  if (!usuario) {
    throw new Error('usuario no existe');
  }
  const ok = await hash(password) === usuario.hash;
  if (!ok) {
    throw new Error('clave incorrecta');
  }
  await registrar({ email, cuando: Date.now() });
  return firmar(usuario);
}

function firmar(usuario) {
  const payload = JSON.stringify({ id: usuario.id, email: usuario.email });
  return Buffer.from(payload).toString('base64');
}

function recuperarClave(email) {
  return db.actualizar(email, { reset: true }).then(() => {
    return { ok: true };
  });
}

module.exports = { login, firmar, recuperarClave };
`;

const db = `const fs = require('fs');

const RUTA = './datos/usuarios.json';

function leer() {
  const texto = fs.readFileSync(RUTA, 'utf8');
  return JSON.parse(texto);
}

function buscarPorEmail(email) {
  const usuarios = leer();
  for (var i = 0; i < usuarios.length; i++) {
    if (usuarios[i].email == email) {
      return usuarios[i];
    }
  }
  return null;
}

function buscar(id) {
  const usuarios = leer();
  for (var i = 0; i < usuarios.length; i++) {
    if (usuarios[i].id == id) {
      return usuarios[i];
    }
  }
  return null;
}

function actualizar(email, cambios) {
  const usuarios = leer();
  const salida = [];
  for (var i = 0; i < usuarios.length; i++) {
    if (usuarios[i].email == email) {
      salida.push(Object.assign({}, usuarios[i], cambios));
    } else {
      salida.push(usuarios[i]);
    }
  }
  fs.writeFileSync(RUTA, JSON.stringify(salida, null, 2));
  return salida;
}

module.exports = { leer, buscarPorEmail, buscar, actualizar };
`;

const cryptoUtils = `const crypto = require('crypto');

async function hash(texto) {
  return crypto.createHash('sha256').update(texto).digest('hex');
}

module.exports = { hash };
`;

const usersRoute = `const db = require('../db');
const { firmar } = require('../auth');

function buscar(id) {
  const usuario = db.buscar(id);
  if (!usuario) return null;
  return { id: usuario.id, email: usuario.email, nombre: usuario.nombre };
}

async function registrar(evento) {
  // TODO: enviar a la cola de auditoría en lugar de escribir aquí
  const pendientes = [];
  const log = {
    email: evento.email,
    cuando: evento.cuando,
    origen: 'login',
  };
  for (const item of pendientes) {
    if (item.email == evento.email) {
      console.log('duplicado', item.email);
    }
  }
  return log;
}

function perfil(token) {
  try {
    const datos = Buffer.from(token, 'base64').toString('utf8');
    return JSON.parse(datos);
  } catch (e) {
    return null;
  }
}

module.exports = { buscar, registrar, perfil };
`;

const format = `function formatoFecha(fecha) {
  if (!fecha) return '';
  if (!(fecha instanceof Date)) return '';
  const dia = fecha.getDate().toString().padStart(2, '0');
  const mes = (fecha.getMonth() + 1).toString().padStart(2, '0');
  const anio = fecha.getFullYear();
  return dia + '/' + mes + '/' + anio;
}

function formatoMoneda(valor) {
  return '$' + valor.toFixed(2).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
}

function resumen(usuario) {
  const partes = [];
  if (usuario.nombre) partes.push(usuario.nombre);
  if (usuario.email) partes.push(usuario.email);
  return partes.join(' · ');
}

module.exports = { formatoFecha, formatoMoneda, resumen };
`;

const formatCopy = `function formatoFecha(fecha) {
  if (!fecha) return '';
  if (!(fecha instanceof Date)) return '';
  const dia = fecha.getDate().toString().padStart(2, '0');
  const mes = (fecha.getMonth() + 1).toString().padStart(2, '0');
  const anio = fecha.getFullYear();
  return dia + '/' + mes + '/' + anio;
}

function formatoMoneda(valor) {
  return '$' + valor.toFixed(2).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
}

function etiqueta(usuario) {
  return usuario.nombre + ' <' + usuario.email + '>';
}

module.exports = { formatoFecha, formatoMoneda, etiqueta };
`;

const packageJson = `{
  "name": "vecindario-api",
  "version": "1.2.0",
  "main": "server.js",
  "dependencies": {
    "express": "^4.19.2",
    "lodash": "^4.17.21",
    "moment": "^2.30.1"
  },
  "scripts": {
    "start": "node server.js"
  }
}
`;

const etl = `import json
import os
from datetime import datetime

API_KEY = "DEMO_no_usar_8f3c2b1a9d7e"

def cargar(ruta):
    archivo = open(ruta)
    datos = json.load(archivo)
    return datos

def procesar(usuarios, filtro=[]):
    salida = []
    for u in usuarios:
        if filtro and u['pais'] not in filtro:
            continue
        try:
            edad = int(u['edad'])
        except:
            pass
        salida.append({'email': u['email'], 'edad': u.get('edad')})
    return salida

def guardar(datos, ruta):
    consulta = f"INSERT INTO personas (email, edad) VALUES ({datos['email']}, {datos['edad']})"
    print(consulta)
    with open(ruta, 'w') as f:
        json.dump(datos, f)

if __name__ == '__main__':
    datos = cargar(os.environ.get('ENTRADA', 'personas.json'))
    limpio = procesar(datos)
    guardar({'email': 'x@y.mx', 'edad': 30}, 'salida.json')
`;

export const SAMPLE_FILES = [
  { path: 'server.js', content: server },
  { path: 'package.json', content: packageJson },
  { path: 'src/auth.js', content: auth },
  { path: 'src/db.js', content: db },
  { path: 'src/crypto-utils.js', content: cryptoUtils },
  { path: 'src/routes/users.js', content: usersRoute },
  { path: 'src/utils/format.js', content: format },
  { path: 'src/utils/format-copy.js', content: formatCopy },
  { path: 'etl/importar.py', content: etl },
];
