import { readFile, lstat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { TextDecoder } from 'node:util';
const utf8 = new TextDecoder('utf-8', { fatal: true });
const check = (ok, message) => { if (!ok) throw Error(message); };
const zero = bytes => bytes.every(value => value === 0);
function text(bytes) { const end = bytes.indexOf(0); if (end >= 0) { check(zero(bytes.subarray(end)), 'Invalid tar string padding'); bytes = bytes.subarray(0, end); } return utf8.decode(bytes); }
function number(bytes) {
 if (bytes[0] & 128) { check(!(bytes[0] & 64), 'Negative tar numeric field'); let value = BigInt(bytes[0] & 127); for (const byte of bytes.subarray(1)) value = value * 256n + BigInt(byte); check(value <= BigInt(Number.MAX_SAFE_INTEGER), 'Tar numeric field overflow'); return Number(value); }
 const value = utf8.decode(bytes).replace(/\0.*$/, '').trim(); check(!value || /^[0-7]+$/.test(value), 'Invalid tar octal field'); const result = value ? parseInt(value, 8) : 0; check(Number.isSafeInteger(result), 'Tar numeric field overflow'); return result;
}
function safe(path, directory = false) {
 if (directory && path.endsWith('/')) path = path.slice(0, -1);
 check(typeof path === 'string' && path && !/[\\\0:\r\n\t]/.test(path) && !path.startsWith('/') && !path.split('/').some(part => !part || part === '.' || part === '..'), 'Unsafe tar path');
 return path;
}
function pax(bytes) {
 const values = {}; let offset = 0;
 while (offset < bytes.length) {
  const space = bytes.indexOf(32, offset); check(space > offset, 'Invalid PAX record length');
  const digits = bytes.subarray(offset, space).toString('ascii'); check(/^[1-9]\d*$/.test(digits), 'Invalid PAX record length');
  const length = Number(digits); check(Number.isSafeInteger(length) && length > space - offset + 2 && offset + length <= bytes.length && bytes[offset + length - 1] === 10, 'Truncated PAX record');
  const value = utf8.decode(bytes.subarray(space + 1, offset + length - 1)), equal = value.indexOf('='); check(equal > 0, 'Invalid PAX key');
  const key = value.slice(0, equal); check(!(key in values), 'Duplicate PAX key');
  check(key !== 'linkpath' && !key.startsWith('GNU.sparse') && !key.startsWith('SCHILY.'), 'Unsupported PAX extension');
  values[key] = value.slice(equal + 1); offset += length;
 }
 return values;
}
/** Inflate once and expose verified regular members without filesystem extraction. */
export async function readNativeTarFiles(tarPath, { maxArchiveBytes = 1024 ** 3, maxFileBytes = 512 * 1024 ** 2, maxMembers = 10000 } = {}) {
 for (const value of [maxArchiveBytes, maxFileBytes, maxMembers]) check(Number.isSafeInteger(value) && value > 0, 'Invalid tar resource bound');
 const stat = await lstat(tarPath); check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maxArchiveBytes, 'Tar archive must be a bounded regular file');
 const compressed = await readFile(tarPath); check(compressed.length <= maxArchiveBytes, 'Tar archive grew beyond bound');
 const archive = gunzipSync(compressed, { maxOutputLength: maxArchiveBytes }); check(archive.length % 512 === 0, 'Truncated tar block');
 const files = new Map(), names = new Set(); let offset = 0, count = 0, total = 0, pending = {}, longName, ended = false;
 while (offset < archive.length) {
  const header = archive.subarray(offset, offset + 512);
  if (zero(header)) { check(offset + 1024 <= archive.length && zero(archive.subarray(offset + 512)), 'Invalid tar end marker/trailing bytes'); check(Object.keys(pending).length === 0 && longName === undefined, 'Orphan tar extension'); ended = true; break; }
  check(++count <= maxMembers, 'Tar member limit exceeded');
  const expected = number(header.subarray(148, 156)); let actual = 0; for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : header[i]; check(expected === actual, 'Tar header checksum mismatch');
  const magic = text(header.subarray(257, 263)); check(magic === '' || magic === 'ustar' || magic === 'ustar ', 'Unsupported tar header format');
  const prefix = magic ? text(header.subarray(345, 500)) : '', name = text(header.subarray(0, 100)); let path = prefix ? `${prefix}/${name}` : name;
  const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]); let size = number(header.subarray(124, 136));
  if (!['x','g','L'].includes(type) && pending.size !== undefined) { check(/^\d+$/.test(pending.size), 'Invalid PAX size'); size = Number(pending.size); check(Number.isSafeInteger(size), 'PAX size overflow'); }
  check(size <= maxFileBytes, 'Tar file bound exceeded'); const start = offset + 512, end = start + size, paddedEnd = start + Math.ceil(size / 512) * 512;
  check(end <= archive.length && paddedEnd <= archive.length && zero(archive.subarray(end, paddedEnd)), 'Truncated tar member/padding'); const body = archive.subarray(start, end); offset = paddedEnd;
  if (type === 'x' || type === 'g') { safe(path); const values = pax(body); if (type === 'g') check(values.path === undefined && values.size === undefined, 'Global PAX path/size is unsupported'); else { check(!Object.keys(pending).length, 'Duplicate pending PAX header'); if (values.path !== undefined) safe(values.path); pending = values; } continue; }
  if (type === 'L') { if(path!=='././@LongLink')safe(path); check(longName === undefined, 'Duplicate GNU longname'); longName = text(body); safe(longName); continue; }
  check(type === '0' || type === '5', 'Tar links/devices/unknown entries rejected');
  if (pending.path !== undefined) path = pending.path; else if (longName !== undefined) path = longName;
  pending = {}; longName = undefined; path = safe(path, type === '5');
  check((path.startsWith('package/') || (path === 'package' && type === '5')) && !names.has(path), 'Nonpackage/duplicate tar path'); names.add(path);
  for (const parent of path.split('/').slice(0, -1).map((_, index) => path.split('/').slice(0, index + 1).join('/'))) check(!files.has(parent), 'Tar file/directory collision');
  if (type === '5') check(size === 0, 'Nonempty tar directory');
  else { check(![...names].some(other => other.startsWith(path + '/')), 'Tar file/directory collision'); total += size; check(total <= maxArchiveBytes, 'Tar total file bound exceeded'); files.set(path, body); }
 }
 check(ended, 'Missing tar end marker'); return files;
}
