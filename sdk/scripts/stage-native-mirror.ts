import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeRelative } from '../src/native/native-package.ts';
import type { NativeManifest } from '../src/types.ts';
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const segment = (value: string) => {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) ||
    value.includes('..')
  )
    throw new Error('Invalid mirror identity');
  return value;
};
/** Copies only an explicit verified native inventory. Never scans account directories. */
export async function stageMirror(source: string, mirror: string) {
  const root = await realpath(source);
  const input = JSON.parse(
    await readFile(resolve(root, 'manifest.json'), 'utf8'),
  ) as NativeManifest;
  if (input.schemaVersion !== 1 || !Array.isArray(input.files) || !input.files.length)
    throw new Error('Invalid native inventory');
  if (
    !input.version ||
    ![input.version.clientVersion, input.version.appId, input.version.qua].every(
      (v) => typeof v === 'string' && v.length,
    )
  )
    throw new Error('Missing version configuration');
  const files = [...input.files].sort((a, b) => a.path.localeCompare(b.path));
  const names = new Set<string>();
  for (const file of files) {
    safeRelative(file.path);
    if (
      file.path === 'manifest.json' ||
      /(^|\/)(\.local|nt_db|global)(\/|$)|\.(db|db-wal|db-shm)$/i.test(file.path)
    )
      throw new Error('Account or reserved path in native inventory');
    if (names.has(file.path) || !/^[a-f0-9]{64}$/i.test(file.sha256))
      throw new Error('Duplicate path or invalid digest');
    names.add(file.path);
    const actual = await realpath(resolve(root, file.path));
    const inside = relative(root, actual);
    if (inside.startsWith('..') || inside.startsWith('/'))
      throw new Error('Native source escapes inventory root');
    if (hash(await readFile(actual)) !== file.sha256.toLowerCase())
      throw new Error(`Native hash mismatch: ${file.path}`);
  }
  if (!names.has(safeRelative(input.wrapper))) throw new Error('Wrapper missing from inventory');
  const manifest: NativeManifest = {
    ...input,
    files: files.map((f) => ({
      path: f.path,
      sha256: f.sha256.toLowerCase(),
      url: f.path.split('/').map(encodeURIComponent).join('/'),
    })),
  };
  const body = JSON.stringify(manifest, null, 2) + '\n';
  const manifestSha256 = hash(Buffer.from(body));
  const packagePath = [
    segment(input.version.clientVersion),
    segment(input.platform),
    segment(input.arch),
    manifestSha256,
  ].join('/');
  const destination = resolve(mirror, packagePath);
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination); // Immutable identity: never overwrite an existing package.
  const stored = new Map<string, string>();
  for (const file of manifest.files) {
    const output = resolve(destination, file.path);
    await mkdir(dirname(output), { recursive: true });
    const existing = stored.get(file.sha256);
    if (existing) await link(existing, output);
    else {
      await copyFile(resolve(root, file.path), output);
      stored.set(file.sha256, output);
    }
    if (hash(await readFile(output)) !== file.sha256)
      throw new Error(`Copied native hash mismatch: ${file.path}`);
  }
  // Manifest is written last; an interrupted copy cannot be consumed as a complete package.
  await writeFile(resolve(destination, 'manifest.json'), body, { flag: 'wx' });
  return { packagePath, manifestSha256, files: manifest.files.length, uniqueContents: stored.size };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4)
    throw new Error('Usage: node scripts/stage-native-mirror.ts SOURCE_NATIVE_DIR MIRROR_DIR');
  console.log(JSON.stringify(await stageMirror(process.argv[2]!, process.argv[3]!), null, 2));
}
