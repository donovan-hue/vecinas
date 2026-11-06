/**
 * Lector de ZIP mínimo (sin dependencias): recorre el directorio central y
 * descomprime con zlib.inflateRawSync. Suficiente para los zipballs de GitHub.
 */
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

export function isZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 22 && buffer.readUInt32LE(0) === 0x04034b50;
}

export function readZip(buffer, { maxFileSize = 512 * 1024, maxFiles = 4000 } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new Error('Se esperaba un Buffer');

  // 1. Localizar el End Of Central Directory (puede haber hasta 64 KB de comentario).
  let eocd = -1;
  const scanFrom = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= scanFrom; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('ZIP inválido: no se encontró el directorio central');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const files = [];
  let skipped = 0;

  for (let e = 0; e < entryCount; e++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CEN_SIG) break;

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    if (!name || name.endsWith('/')) continue;
    if (files.length >= maxFiles) { skipped++; continue; }
    if (uncompressedSize > maxFileSize) { skipped++; continue; }
    if (localOffset + 30 > buffer.length) { skipped++; continue; }
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) { skipped++; continue; }

    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) { skipped++; continue; }

    const raw = buffer.subarray(dataStart, dataEnd);
    let content;
    try {
      if (method === 0) {
        content = raw;
      } else if (method === 8) {
        content = zlib.inflateRawSync(raw, { maxOutputLength: maxFileSize });
      } else {
        skipped++;
        continue; // métodos poco comunes (bzip2, lzma…): los ignoramos
      }
    } catch {
      skipped++;
      continue;
    }

    if (looksBinary(content)) { skipped++; continue; }
    files.push({ path: name, content: content.toString('utf8') });
  }

  return { files, skipped };
}

/** Quita el prefijo común que añade GitHub (`repo-commit/`). */
export function stripCommonPrefix(files) {
  if (!files.length) return files;
  const first = files[0].path.split('/')[0];
  const allShare = files.every((f) => f.path.startsWith(first + '/'));
  if (!allShare) return files;
  return files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) }));
}

function looksBinary(buf) {
  const limit = Math.min(buf.length, 8000);
  let suspicious = 0;
  for (let i = 0; i < limit; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) suspicious++;
  }
  return limit > 0 && suspicious / limit > 0.1;
}
