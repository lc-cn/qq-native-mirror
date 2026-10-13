import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

/** @typedef {{clientVersion:string,appId:string,qua:string}} QQVersion */
/** @typedef {{platform:string,arch:string,version:QQVersion,manifestUrl:string,manifestSha256:string}} Selected */
/** @param {Buffer} bytes */
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hash = /^[a-f0-9]{64}$/;
const legacy = '3.2.31-51102';
const latest = '3.2.32-52194';
/** @param {unknown} value @param {string} label @returns {Record<string, unknown>} */
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`Invalid ${label}`);
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {unknown} value @returns {asserts value is string} */
function https(value) {
  if (typeof value !== 'string' || !value) throw Error('Invalid source URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw Error('Invalid source URL');
}
/** @param {unknown} value @returns {QQVersion} */
function version(value) {
  const row = object(value, 'version');
  if (
    typeof row.clientVersion !== 'string' ||
    !/^\d+(?:\.\d+)*(?:-\d+)?$/.test(row.clientVersion) ||
    typeof row.appId !== 'string' ||
    !row.appId ||
    typeof row.qua !== 'string' ||
    !row.qua
  )
    throw Error('Invalid version');
  return /** @type {QQVersion} */ (row);
}
/** @param {unknown} value @returns {asserts value is string} */
function path(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\0') ||
    value.includes('\\') ||
    /^[a-zA-Z]:/.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw Error('Invalid manifest path');
}
/** @param {Buffer} bytes @param {Selected} selected */
function manifest(bytes, selected) {
  if (sha(bytes) !== selected.manifestSha256) throw Error('Manifest digest mismatch');
  const value = object(/** @type {unknown} */ (JSON.parse(bytes.toString('utf8'))), 'manifest');
  if (
    value.schemaVersion !== 1 ||
    value.platform !== selected.platform ||
    value.arch !== selected.arch ||
    typeof value.id !== 'string' ||
    !value.id
  )
    throw Error('Manifest device mismatch');
  const actual = version(value.version);
  if (
    /** @type {const} */ (['clientVersion', 'appId', 'qua']).some(
      (key) => actual[key] !== selected.version[key],
    )
  )
    throw Error('Manifest version mismatch');
  path(value.wrapper);
  if (!Array.isArray(value.files) || value.files.length === 0)
    throw Error('Invalid manifest files');
  const names = new Set(/** @type {string[]} */ ([]));
  for (const input of /** @type {unknown[]} */ (value.files)) {
    const row = object(input, 'manifest file');
    path(row.path);
    https(row.url);
    if (names.has(row.path) || typeof row.sha256 !== 'string' || !hash.test(row.sha256))
      throw Error('Duplicate path or invalid digest');
    if (
      row.size !== undefined &&
      (typeof row.size !== 'number' || !Number.isSafeInteger(row.size) || row.size < 0)
    )
      throw Error('Invalid file size');
    if (row.encoding !== undefined && row.encoding !== 'gzip') throw Error('Invalid file encoding');
    if (
      row.downloadSha256 !== undefined &&
      (typeof row.downloadSha256 !== 'string' || !hash.test(row.downloadSha256))
    )
      throw Error('Invalid download digest');
    if (row.encoding === 'gzip' && row.downloadSha256 === undefined)
      throw Error('Missing download digest');
    names.add(row.path);
  }
  for (const name of names) {
    const parts = name.split('/');
    for (let index = 1; index < parts.length; index++)
      if (names.has(parts.slice(0, index).join('/'))) throw Error('Conflicting manifest paths');
  }
  if (!names.has(value.wrapper) || !names.has('registration-bridge.node'))
    throw Error('Manifest lacks wrapper or registration bridge');
}
/** Public mode retains actual SDK default acquisition. The legacy candidate serves
 * only pinned manifest bytes; all native URLs and bytes remain the public source.
 * @param {{catalogFile:unknown,manifestFile?:unknown,mode:unknown,platform:unknown,arch:unknown,targetVersion:unknown}} input
 * @returns {Promise<{selected:Selected,options:{version?:QQVersion,manifestUrl?:string,manifestSha256?:string},mode:string,automaticLatest:boolean,close:()=>Promise<void>}>}
 */
export async function openMirrorSelection({
  catalogFile,
  manifestFile,
  mode,
  platform,
  arch,
  targetVersion,
}) {
  if (typeof catalogFile !== 'string' || !catalogFile) throw Error('Invalid catalog file');
  if (mode !== 'public-default' && mode !== 'legacy-bridge-candidate')
    throw Error('Invalid mirror selection mode');
  if (typeof platform !== 'string' || !platform || typeof arch !== 'string' || !arch)
    throw Error('Invalid device');
  if (targetVersion !== legacy && targetVersion !== latest)
    throw Error('Unsupported target version');
  if (mode === 'legacy-bridge-candidate' && targetVersion !== legacy)
    throw Error('Candidate requires legacy version');
  const catalog = object(
    /** @type {unknown} */ (JSON.parse(await readFile(catalogFile, 'utf8'))),
    'catalog',
  );
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.packages) || !catalog.packages.length)
    throw Error('Invalid catalog');
  /** @type {Selected[]} */
  const matches = [];
  for (const input of /** @type {unknown[]} */ (catalog.packages)) {
    const row = object(input, 'catalog package');
    if (
      typeof row.platform !== 'string' ||
      !row.platform ||
      typeof row.arch !== 'string' ||
      !row.arch
    )
      throw Error('Invalid catalog device');
    const parsedVersion = version(row.version);
    https(row.manifestUrl);
    if (typeof row.manifestSha256 !== 'string' || !hash.test(row.manifestSha256))
      throw Error('Invalid catalog digest');
    if (
      row.platform === platform &&
      row.arch === arch &&
      parsedVersion.clientVersion === targetVersion
    )
      matches.push(/** @type {Selected} */ (row));
  }
  if (matches.length !== 1) throw Error('Target catalog selection is missing or ambiguous');
  const selected = matches[0];
  if (mode === 'public-default') {
    if (manifestFile !== undefined) throw Error('Public mode cannot override manifest');
    return {
      selected,
      options: targetVersion === legacy ? { version: { ...selected.version } } : {},
      mode,
      automaticLatest: targetVersion === latest,
      close: async () => {},
    };
  }
  if (typeof manifestFile !== 'string' || !manifestFile)
    throw Error('Candidate requires manifest file');
  const bytes = await readFile(manifestFile);
  manifest(bytes, selected);
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/manifest.json') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length });
    response.end(bytes);
  });
  await new Promise(
    /** @param {(value?:void)=>void} resolve @param {(error:unknown)=>void} reject */ (
      resolve,
      reject,
    ) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    },
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing candidate server address');
  /** @type {Promise<void>|undefined} */
  let closing;
  const close = () =>
    (closing ??= new Promise(
      /** @param {(value?:void)=>void} resolve @param {(error:unknown)=>void} reject */ (
        resolve,
        reject,
      ) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      },
    ));
  return {
    selected,
    options: {
      manifestUrl: `http://127.0.0.1:${address.port}/manifest.json`,
      manifestSha256: selected.manifestSha256,
    },
    mode,
    automaticLatest: false,
    close,
  };
}
