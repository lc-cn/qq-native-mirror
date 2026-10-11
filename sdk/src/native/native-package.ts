import { restoreInstalledNativeStorage } from './native-installed-storage.ts';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import type { ClientOptions } from '../contracts/client.ts';
import type { NativeManifest, QQVersion } from '../contracts/native.ts';
import { resolveNativeCatalog } from './native-catalog.ts';
import { acquirePackageLock } from '../storage/native-package-lock.ts';
import { installVerifiedBundle } from './native-bundle-installer.ts';
import {
  assertNativeVersion,
  assertNodeRuntimeConstraint,
  nativeHashPattern,
  sameNativeContent,
  safeRelative,
  validateDownloadMirrors,
  validateNativeSourceOptions,
  validateRemoteInventory,
} from './native-manifest.ts';
import { verifyNativeDirectory } from './native-directory-verification.ts';

// Internal compatibility exports; input consumers import the pure manifest owner.
export { safeRelative, validateDownloadMirrors } from './native-manifest.ts';
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

interface PreparedNative {
  wrapperPath: string;
  version: QQVersion;
  videoCodecPath?: string;
}
function verifyNodeRuntime(manifest: NativeManifest): void {
  assertNodeRuntimeConstraint(manifest);
  if (manifest.nodeVersion === undefined && manifest.nodeConfigSha256 === undefined) return;
  if (
    manifest.nodeVersion !== process.version ||
    manifest.nodeConfigSha256!.toLowerCase() !== digest(Buffer.from(JSON.stringify(process.config)))
  )
    throw new Error(
      `Native internal-ABI adapter requires matching Node ${manifest.nodeVersion} and build configuration`,
    );
}
async function installedNative(
  options: ClientOptions,
  selected?: NativeManifest,
): Promise<PreparedNative | undefined> {
  const name = `qq-native-client-${process.platform}-${process.arch}`;
  let entry: string;
  try {
    entry = createRequire(import.meta.url).resolve(`${name}/manifest.json`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return;
    throw error;
  }
  const manifestBytes = await readFile(entry);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as NativeManifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    !Array.isArray(manifest.files)
  )
    throw new Error('Installed native package does not match device');
  assertNativeVersion(manifest.version);
  if (
    options.version &&
    (['clientVersion', 'appId', 'qua'] as const).some(
      (key) => options.version![key] !== manifest.version[key],
    )
  )
    return;
  if (selected && !sameNativeContent(manifest, selected)) return;
  verifyNodeRuntime(manifest);
  const base =
    manifest.npmStorage === undefined
      ? await realpath(dirname(entry))
      : await restoreInstalledNativeStorage(
          dirname(entry),
          manifestBytes,
          manifest,
          resolve(options.cacheDir ?? join(homedir(), '.cache/qq-native-client')),
          acquirePackageLock,
        );
  const codec = await verifyNativeDirectory(base, manifest, 'installed');
  return {
    wrapperPath: join(base, manifest.wrapper),
    version: manifest.version,
    ...(codec === undefined ? {} : { videoCodecPath: codec }),
  };
}
async function download(url: string, maxBytes: number): Promise<Buffer> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
  ) {
    throw new Error('Native mirrors require HTTPS (HTTP is allowed only for localhost)');
  }
  let response: Response | undefined;
  let current = parsed;
  for (let hops = 0; hops <= 5; hops++) {
    response = await fetch(current, { signal: AbortSignal.timeout(600_000), redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || hops === 5) throw new Error('Invalid native download redirect');
    const next = new URL(location, current);
    // Release assets redirect to GitHub's HTTPS object storage. Do not
    // broaden arbitrary mirror redirect behavior or forward credentials.
    if (
      current.hostname !== 'github.com' ||
      next.protocol !== 'https:' ||
      !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(
        next.hostname,
      ) ||
      next.username ||
      next.password
    )
      throw new Error('Untrusted native download redirect');
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
export async function prepareNative(options: ClientOptions): Promise<PreparedNative> {
  validateNativeSourceOptions(options);
  const mirrors = validateDownloadMirrors(options.downloadMirrors);
  if (options.wrapperPath) {
    const wrapperPath = options.wrapperPath;
    const adjacent = await readFile(join(dirname(wrapperPath), 'manifest.json'), 'utf8').catch(
      (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && options.version) return undefined;
        throw error;
      },
    );
    const local = adjacent === undefined ? undefined : (JSON.parse(adjacent) as NativeManifest);
    if (local !== undefined) verifyNodeRuntime(local);
    if (!options.version) {
      if (
        !local ||
        local.schemaVersion !== 1 ||
        local.platform !== process.platform ||
        local.arch !== process.arch ||
        (await realpath(join(dirname(wrapperPath), safeRelative(local.wrapper)))) !==
          (await realpath(wrapperPath))
      )
        throw new Error('Local manifest does not match wrapper or device');
      options = { ...options, version: local.version };
    }
    assertNativeVersion(options.version);
    let codec: string | undefined;
    // Legacy explicit wrappers remain usable without an inventory. Automatic codec
    // discovery requires a complete matching bundle and verified regular files.
    if (local?.videoCodec !== undefined) {
      const base = await realpath(dirname(wrapperPath));
      if (
        local.schemaVersion !== 1 ||
        local.platform !== process.platform ||
        local.arch !== process.arch ||
        !Array.isArray(local.files) ||
        (await realpath(join(base, safeRelative(local.wrapper)))) !== (await realpath(wrapperPath))
      )
        throw new Error('Local manifest does not match wrapper or device');
      assertNativeVersion(local.version);
      if (
        (['clientVersion', 'appId', 'qua'] as const).some(
          (key) => options.version![key] !== local.version[key],
        )
      )
        throw new Error('Local manifest version does not match requested version');
      codec = await verifyNativeDirectory(base, local, 'local');
    }
    return {
      wrapperPath: await realpath(wrapperPath),
      version: options.version,
      ...(codec === undefined ? {} : { videoCodecPath: codec }),
    };
  }
  const automaticLatest = !options.version && !options.manifestUrl && !options.catalogUrl;
  // A fixed version can resolve locally; the default must establish catalog latest first.
  if (options.version && !options.manifestUrl && !options.catalogUrl) {
    const installed = await installedNative(options);
    if (installed) return installed;
  }
  if (!options.manifestUrl) options = await resolveNativeCatalog(options);
  if (
    !options.manifestUrl ||
    !options.manifestSha256 ||
    !nativeHashPattern.test(options.manifestSha256)
  ) {
    throw new Error('Provide wrapperPath and version, or manifestUrl and trusted manifestSha256');
  }
  const body = await download(options.manifestUrl, 1024 * 1024);
  if (digest(body) !== options.manifestSha256.toLowerCase())
    throw new Error('Native manifest SHA-256 mismatch');
  const manifest = JSON.parse(body.toString('utf8')) as NativeManifest;
  if (!manifest || typeof manifest !== 'object') throw new Error('Invalid native manifest');
  if (manifest.npmStorage !== undefined)
    throw new Error('npmStorage is only supported for installed native packages');
  if (options.version) assertNativeVersion(options.version);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error('Unsupported native manifest schema, platform or architecture');
  }
  assertNativeVersion(manifest.version);
  verifyNodeRuntime(manifest);
  if (
    options.version &&
    (['clientVersion', 'appId', 'qua'] as const).some(
      (field) => options.version![field] !== manifest.version[field],
    )
  ) {
    throw new Error(
      'Requested QQ version configuration does not match the trusted native manifest',
    );
  }
  const codec = validateRemoteInventory(manifest);
  if (automaticLatest) {
    const installed = await installedNative({ ...options, version: manifest.version }, manifest);
    if (installed) return installed;
  }
  const target = await installVerifiedBundle({
    manifestBytes: body,
    manifest,
    manifestUrl: options.manifestUrl,
    cacheDir: options.cacheDir,
    mirrors,
    download,
  });
  return {
    wrapperPath: join(target, manifest.wrapper),
    version: manifest.version,
    ...(codec === undefined ? {} : { videoCodecPath: join(target, codec) }),
  };
}
