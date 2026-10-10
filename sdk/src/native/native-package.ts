import {restoreInstalledNativeStorage} from './native-installed-storage.ts';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { constants as fsConstants } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile, realpath, lstat, link, copyFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import type { ClientOptions, NativeManifest, QQVersion } from '../types.ts';
import { resolveNativeCatalog } from './native-catalog.ts';
import {publishProcessLock,readProcessLock,removeOwnedProcessLock} from '../storage/process-lock.ts';

const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const installations = new Map<string, Promise<void>>();
const hashPattern = /^[a-f0-9]{64}$/i;
interface PreparedNative { wrapperPath: string; version: QQVersion; videoCodecPath?: string }
function declaredVideoCodec(manifest: NativeManifest, names: Set<string>): string | undefined {
  if (manifest.videoCodec === undefined) return;
  const path = safeRelative(manifest.videoCodec);
  if (!names.has(path)) throw new Error('Video codec is missing from native manifest files');
  return path;
}
function verifyNodeRuntime(manifest: NativeManifest): void {
  if (manifest.nodeVersion === undefined && manifest.nodeConfigSha256 === undefined) return;
  if (typeof manifest.nodeVersion !== 'string' || !/^v\d+\.\d+\.\d+$/.test(manifest.nodeVersion) || typeof manifest.nodeConfigSha256 !== 'string' || !hashPattern.test(manifest.nodeConfigSha256)) throw new Error('Invalid native Node runtime constraint');
  if (manifest.nodeVersion !== process.version || manifest.nodeConfigSha256.toLowerCase() !== digest(Buffer.from(JSON.stringify(process.config)))) throw new Error(`Native internal-ABI adapter requires matching Node ${manifest.nodeVersion} and build configuration`);
}
async function installedNative(options: ClientOptions): Promise<PreparedNative | undefined> {
  const name = `qq-native-client-${process.platform}-${process.arch}`;
  let entry: string;
  try { entry = createRequire(import.meta.url).resolve(`${name}/manifest.json`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return; throw error; }
  const manifestBytes=await readFile(entry);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as NativeManifest;
  if (manifest.schemaVersion !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch || !Array.isArray(manifest.files)) throw new Error('Installed native package does not match device');
  version(manifest.version);
  if (options.version && (['clientVersion','appId','qua'] as const).some(key => options.version![key] !== manifest.version[key])) return;
  verifyNodeRuntime(manifest);
  const base = manifest.npmStorage===undefined?await realpath(dirname(entry)):await restoreInstalledNativeStorage(dirname(entry),manifestBytes,manifest,resolve(options.cacheDir??join(homedir(),'.cache/qq-native-client')),acquirePackageLock);
  const names = new Set<string>();
  for (const file of manifest.files) {
    const relative = safeRelative(file.path);
    if (names.has(relative) || !hashPattern.test(file.sha256)) throw new Error('Invalid installed native manifest');
    names.add(relative);
    const path = join(base, relative);
    const actual = await realpath(path);
    if (!actual.startsWith(base + sep) || !(await lstat(path)).isFile() || digest(await readFile(path)) !== file.sha256.toLowerCase()) throw new Error(`Installed native file failed verification: ${relative}`);
  }
  if (!names.has(safeRelative(manifest.wrapper))) throw new Error('Installed native wrapper is missing');
  const codec = declaredVideoCodec(manifest, names);
  return {wrapperPath:join(base,manifest.wrapper),version:manifest.version,...(codec === undefined ? {} : {videoCodecPath:join(base,codec)})};
}
function version(value: unknown): asserts value is QQVersion {
  const v = value as QQVersion | undefined;
  if (!v || ![v.clientVersion, v.appId, v.qua].every(x => typeof x === 'string' && x.length > 0)) {
    throw new Error('A native package requires clientVersion, appId and qua');
  }
}
export function safeRelative(path: string): string {
  if (typeof path !== 'string' || !path || path.includes('\0') || /^[a-zA-Z]:/.test(path) || isAbsolute(path) || path.includes('\\') || path.split('/').some(x => x === '..' || x === '.' || !x)) {
    throw new Error(`Unsafe native package path: ${path}`);
  }
  return path;
}
async function download(url: string, maxBytes: number): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) {
    throw new Error('Native mirrors require HTTPS (HTTP is allowed only for localhost)');
  }
  let response: Response | undefined;
  let current = parsed;
  for (let hops = 0; hops <= 5; hops++) {
    response = await fetch(current, { signal: AbortSignal.timeout(600_000), redirect: 'manual' });
    if (![301,302,303,307,308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || hops === 5) throw new Error('Invalid native download redirect');
    const next = new URL(location,current);
    // Release assets redirect to GitHub's HTTPS object storage. Do not
    // broaden arbitrary mirror redirect behavior or forward credentials.
    if (current.hostname !== 'github.com' || next.protocol !== 'https:' || !['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(next.hostname) || next.username || next.password) throw new Error('Untrusted native download redirect');
    current = next;
  }
  if (!response) throw new Error('Native download failed');
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Native package download exceeds size limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
// Bounded synchronous owner-file publication is shared with the account lock.
async function acquirePackageLock(target: string): Promise<() => Promise<void>> {
  const lock = `${target}.lock`;
  const owner = `${process.pid}-${randomUUID()}`;
  const started = Date.now();
  for (;;) {
    try {
      publishProcessLock(lock,owner);
      return async () => {removeOwnedProcessLock(lock,owner);};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const existing = readProcessLock(lock);
    if(existing === undefined) continue;
    if (existing && !/^\d+-[a-zA-Z0-9-]+$/.test(existing)) throw new Error(`Invalid native package lock owner: ${lock}`);
    const pid = Number(existing.split('-')[0]);
    let dead = false;
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); }
      catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    }
    if (dead) {
      // A token-specific claim prevents two waiters from unlinking a replacement lock.
      const claim = `${lock}.reap-${existing}`;
      try {
        await mkdir(claim);
        try {removeOwnedProcessLock(lock,existing);}
        finally { await rm(claim, { recursive: true, force: true }); }
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (Date.now() - started > 180_000) throw new Error(`Timed out waiting for native package lock: ${lock}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
export function validateDownloadMirrors(value: unknown): string[] {
  const mirrors=value??[];
  if (!Array.isArray(mirrors)||mirrors.length>8) throw new Error('downloadMirrors must contain at most eight HTTPS prefixes');
  for (const mirror of mirrors) {
    if(typeof mirror!=='string')throw new Error('Invalid download mirror');
    const url=new URL(mirror);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!mirror.endsWith('/'))throw new Error('Download mirrors require HTTPS prefixes ending in / without credentials, query or fragment');
  }
  return mirrors;
}
export async function prepareNative(options: ClientOptions): Promise<PreparedNative> {
  const mirrors=validateDownloadMirrors(options.downloadMirrors);
  if (options.wrapperPath && options.manifestUrl) throw new Error('Choose wrapperPath or manifestUrl');
  if (options.wrapperPath) {
    const wrapperPath = options.wrapperPath;
    const adjacent = await readFile(join(dirname(wrapperPath), 'manifest.json'), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && options.version) return undefined;
      throw error;
    });
    const local = adjacent === undefined ? undefined : JSON.parse(adjacent) as NativeManifest;
    if (local !== undefined) verifyNodeRuntime(local);
    if (!options.version) {
      if (!local || local.schemaVersion !== 1 || local.platform !== process.platform || local.arch !== process.arch || await realpath(join(dirname(wrapperPath),safeRelative(local.wrapper))) !== await realpath(wrapperPath)) throw new Error('Local manifest does not match wrapper or device');
      options = {...options,version:local.version};
    }
    version(options.version);
    let codec: string | undefined;
    // Legacy explicit wrappers remain usable without an inventory. Automatic codec
    // discovery requires a complete matching bundle and verified regular files.
    if (local?.videoCodec !== undefined) {
      const base = await realpath(dirname(wrapperPath));
      if (local.schemaVersion !== 1 || local.platform !== process.platform || local.arch !== process.arch || !Array.isArray(local.files) || await realpath(join(base,safeRelative(local.wrapper))) !== await realpath(wrapperPath)) throw new Error('Local manifest does not match wrapper or device');
      version(local.version);
      if ((['clientVersion','appId','qua'] as const).some(key => options.version![key] !== local.version[key])) throw new Error('Local manifest version does not match requested version');
      const names = new Set<string>();
      for (const file of local.files) {
        if (!file || typeof file !== 'object' || typeof file.sha256 !== 'string') throw new Error('Invalid local native manifest');
        const relative = safeRelative(file.path);
        if (names.has(relative) || !hashPattern.test(file.sha256)) throw new Error('Invalid local native manifest');
        names.add(relative);
        const path = join(base,relative);
        if (!(await realpath(path)).startsWith(base + sep) || !(await lstat(path)).isFile() || digest(await readFile(path)) !== file.sha256.toLowerCase()) throw new Error(`Local native file failed verification: ${relative}`);
      }
      if (!names.has(safeRelative(local.wrapper))) throw new Error('Local native wrapper is missing');
      codec = join(base, declaredVideoCodec(local, names)!);
    }
    return { wrapperPath: await realpath(wrapperPath), version: options.version, ...(codec === undefined ? {} : {videoCodecPath:codec}) };
  }
  if (!options.manifestUrl && !options.catalogUrl) {
    const installed = await installedNative(options);
    if (installed) return installed;
  }
  if (!options.manifestUrl) options = await resolveNativeCatalog(options);
  if (!options.manifestUrl || !options.manifestSha256 || !hashPattern.test(options.manifestSha256)) {
    throw new Error('Provide wrapperPath and version, or manifestUrl and trusted manifestSha256');
  }
  const body = await download(options.manifestUrl, 1024 * 1024);
  if (digest(body) !== options.manifestSha256.toLowerCase()) throw new Error('Native manifest SHA-256 mismatch');
  const manifest = JSON.parse(body.toString('utf8')) as NativeManifest;
  if (!manifest || typeof manifest !== 'object') throw new Error('Invalid native manifest');
  if(manifest.npmStorage!==undefined)throw new Error('npmStorage is only supported for installed native packages');
  if (options.version) version(options.version);
  if (manifest.schemaVersion !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch || !Array.isArray(manifest.files)) {
    throw new Error('Unsupported native manifest schema, platform or architecture');
  }
  version(manifest.version);
  verifyNodeRuntime(manifest);
  if (options.version && (['clientVersion', 'appId', 'qua'] as const).some(field => options.version![field] !== manifest.version[field])) {
    throw new Error('Requested QQ version configuration does not match the trusted native manifest');
  }
  safeRelative(manifest.wrapper);
  const names = new Set<string>();
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || typeof file.url !== 'string' || typeof file.sha256 !== 'string') throw new Error('Invalid native manifest file');
    safeRelative(file.path);
    if (names.has(file.path) || !hashPattern.test(file.sha256)) throw new Error('Duplicate file or invalid SHA-256 in manifest');
    if (file.encoding !== undefined && file.encoding !== 'gzip') throw new Error('Unsupported native content encoding');
    if (file.encoding === 'gzip' && (typeof file.downloadSha256 !== 'string' || !hashPattern.test(file.downloadSha256))) throw new Error('Compressed native content requires downloadSha256');
    if (file.encoding === undefined && file.downloadSha256 !== undefined) throw new Error('downloadSha256 requires content encoding');
    names.add(file.path);
  }
  for (const name of names) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (names.has(parts.slice(0, i).join('/'))) throw new Error('Conflicting native package file paths');
    }
  }
  if (!names.has(manifest.wrapper)) throw new Error('Wrapper is missing from manifest files');
  const codec = declaredVideoCodec(manifest, names);
  const requestedBase = resolve(options.cacheDir ?? join(homedir(), '.cache/qq-native-client'));
  await mkdir(requestedBase, { recursive: true });
  const base = await realpath(requestedBase);
  const target = join(base, digest(body));
  async function validate(): Promise<boolean> {
    try {
      for (const file of manifest.files) {
        const path = join(target, file.path);
        if (!(await realpath(path)).startsWith(target + sep) || !(await lstat(path)).isFile() || digest(await readFile(path)) !== file.sha256.toLowerCase()) return false;
      }
      return true;
    } catch { return false; }
  }
  const previous = installations.get(target) ?? Promise.resolve();
  const installation = previous.catch(() => {}).then(async () => {
    if (await validate()) return;
    const release = await acquirePackageLock(target);
    try {
      if (!await validate()) {
        await mkdir(base, { recursive: true });
        const temporary = join(base, `.download-${randomUUID()}`);
        try {
          let next = 0;
          let failed = false;
          const contentGroups = new Map<string, NativeManifest['files']>();
          for (const file of manifest.files) {
            const key=file.sha256.toLowerCase();
            const group=contentGroups.get(key)??[];group.push(file);contentGroups.set(key,group);
          }
          const groups=[...contentGroups.values()];
          const contentCache=join(base,'.contents');
          await mkdir(contentCache,{recursive:true});
          if (!(await lstat(contentCache)).isDirectory() || await realpath(contentCache)!==contentCache) throw new Error('Native content cache must stay inside cache root');
          // Bound memory/network use while avoiding one round trip per small
          // framework resource. Await every worker before cleaning staging.
          const results = await Promise.allSettled(Array.from({length:Math.min(4,groups.length)},async()=>{
            while (!failed && next < groups.length) {
              const group=groups[next++]!;
              const file = group[0]!;
              try {
                const contentPath=join(contentCache,file.sha256.toLowerCase());
                let data: Buffer | undefined = await readFile(contentPath).catch(()=>undefined);
                const cached=!!data && digest(data)===file.sha256.toLowerCase();
                if (!cached) {
                  const original=new URL(file.url,options.manifestUrl).href;
                  let lastError:unknown;
                  for (const url of [...mirrors.map(prefix=>prefix+original),original]) {
                    try {
                      let candidate=await download(url,512*1024*1024);
                      if(file.encoding==='gzip'){
                        if(digest(candidate)!==file.downloadSha256!.toLowerCase())throw new Error(`Compressed native SHA-256 mismatch: ${file.path}`);
                        candidate=gunzipSync(candidate,{maxOutputLength:512*1024*1024});
                      }
                      if(digest(candidate)!==file.sha256.toLowerCase())throw new Error(`Native file SHA-256 mismatch: ${file.path}`);
                      data=candidate;break;
                    } catch(error){lastError=error;}
                  }
                  if(!data||digest(data)!==file.sha256.toLowerCase())throw lastError;
                }
                if (!data || digest(data) !== file.sha256.toLowerCase()) throw new Error(`Native file SHA-256 mismatch: ${file.path}`);
                if (!cached) {
                  const contentTemporary=join(contentCache,`.content-${randomUUID()}`);
                  try {await writeFile(contentTemporary,data,{mode:0o600});await rename(contentTemporary,contentPath);}
                  finally {await rm(contentTemporary,{force:true});}
                }
                const destination = join(temporary, file.path);
                await mkdir(dirname(destination), { recursive: true });
                // Reflinks preserve independent mutable files; unsupported
                // filesystems fall back to ordinary copies, never cache hardlinks.
                await copyFile(contentPath,destination,fsConstants.COPYFILE_FICLONE);
                if(digest(await readFile(destination))!==file.sha256.toLowerCase())throw new Error(`Copied native SHA-256 mismatch: ${file.path}`);
                for (const duplicate of group.slice(1)) {
                  const duplicatePath=join(temporary,duplicate.path);
                  await mkdir(dirname(duplicatePath),{recursive:true});
                  await link(destination,duplicatePath);
                }
              } catch(error) {failed=true;throw error;}
            }
          }));
          const failure = results.find(result=>result.status==='rejected');
          if (failure?.status==='rejected') throw failure.reason;
          // Another client may have completed the same immutable package meanwhile.
          if (await validate()) await rm(temporary, { recursive: true });
          else {
            await rm(target, { recursive: true, force: true });
            await rename(temporary, target);
          }
        } finally { await rm(temporary, { recursive: true, force: true }); }
      }
    } finally { await release(); }
  });
  installations.set(target, installation);
  try { await installation; }
  finally { if (installations.get(target) === installation) installations.delete(target); }
  return { wrapperPath: join(target, manifest.wrapper), version: manifest.version, ...(codec === undefined ? {} : {videoCodecPath:join(target,codec)}) };
}
