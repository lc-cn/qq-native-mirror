import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import type { NativeManifest } from '../src/contracts/native.ts';
import type * as BundleInstaller from '../src/native/native-bundle-installer.ts';
import type * as InstalledStorage from '../src/native/native-installed-storage.ts';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Faults = Partial<Record<'primary' | 'content' | 'staging' | 'release', { value: unknown }>>;
interface Hooks {
  configure(faults: Faults): void;
  counts(): { content: number; staging: number; release: number; write: number; locks: number };
  acquirePackageLock(): Promise<() => Promise<void>>;
}
// Execute the actual source on real temporary files, substituting only the
// failure-bearing filesystem methods and lock port. No native code is loaded.
async function fixture(kind: 'bundle' | 'installed', faults: Faults) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qq-install-cleanup-')));
  try {
    const shim = join(root, 'faults.mjs');
    await writeFile(
      shim,
      `import * as fs from 'node:fs/promises';
export const {mkdir,readFile,realpath,lstat,rename,link,copyFile}=fs;
let faults={}, count={content:0,staging:0,release:0,write:0,locks:0};
export function configure(value){faults=value;}
export function counts(){return {...count};}
export async function writeFile(path,...args){count.write++;if(faults.primary)throw faults.primary.value;return fs.writeFile(path,...args);}
export async function rm(path,...args){
 const normalized=String(path).split(String.fromCharCode(92)).join('/');
 const stage=normalized.includes('/.content-')?'content':/\\/\\.(download|npm)-/.test(normalized)?'staging':undefined;
 if(stage){count[stage]++;if(faults[stage])throw faults[stage].value;}
 return fs.rm(path,...args);
}
export async function acquirePackageLock(){count.locks++;return async()=>{count.release++;if(faults.release)throw faults.release.value;};}
`,
    );
    const hooks: Hooks = await import(pathToFileURL(shim).href);
    hooks.configure(faults);
    const name = kind === 'bundle' ? 'native-bundle-installer.ts' : 'native-installed-storage.ts';
    let source = await readFile(join(sourceRoot, 'native', name), 'utf8');
    source = source.replace("'node:fs/promises'", JSON.stringify(pathToFileURL(shim).href));
    source = source.replace(
      "'../storage/native-package-lock.ts'",
      JSON.stringify(pathToFileURL(shim).href),
    );
    source = source.replace(
      "'../contracts/native.ts'",
      JSON.stringify(pathToFileURL(join(sourceRoot, 'contracts/native.ts')).href),
    );
    await mkdir(join(root, 'native'));
    await mkdir(join(root, 'runtime'));
    await writeFile(
      join(root, 'runtime/cleanup.ts'),
      await readFile(join(sourceRoot, 'runtime/cleanup.ts')),
    );
    const copied = join(root, 'native', name);
    await writeFile(copied, source);
    const raw = Buffer.from('controlled inventory bytes'),
      compressed = gzipSync(raw);
    const pkg = join(root, 'package'),
      cache = join(root, 'cache');
    await mkdir(join(pkg, 'objects'), { recursive: true });
    const object = {
      path: `objects/${sha(raw)}.gz`,
      sha256: sha(raw),
      downloadSha256: sha(compressed),
      size: raw.length,
      downloadSize: compressed.length,
    };
    await writeFile(join(pkg, object.path), compressed);
    const manifest: NativeManifest = {
      schemaVersion: 1,
      id: 'controlled',
      platform: process.platform,
      arch: process.arch,
      wrapper: 'wrapper.node',
      version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' },
      files: [{ path: 'wrapper.node', url: 'wrapper.node', sha256: sha(raw), size: raw.length }],
      ...(kind === 'installed'
        ? { npmStorage: { format: 'gzip-objects-v1' as const, objects: [object] } }
        : {}),
    };
    const body = Buffer.from(JSON.stringify(manifest));
    let calls = 0;
    const run = async () => {
      if (kind === 'bundle') {
        const module: typeof BundleInstaller = await import(pathToFileURL(copied).href);
        return module.installVerifiedBundle({
          manifestBytes: body,
          manifest,
          manifestUrl: 'https://fixture.invalid/manifest.json',
          cacheDir: cache,
          mirrors: [],
          download: async () => {
            calls++;
            return raw;
          },
        });
      }
      const module: typeof InstalledStorage = await import(pathToFileURL(copied).href);
      return module.restoreInstalledNativeStorage(
        pkg,
        body,
        manifest,
        cache,
        hooks.acquirePackageLock,
      );
    };
    return { root, run, hooks, calls: () => calls, raw };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
function retained(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(retained) : [error];
}
for (const kind of ['bundle', 'installed'] as const) {
  test(`${kind} preserves primary, staging and lock failures without retry`, async () => {
    const primary = Object.freeze({ failure: 'write' }),
      staging = new Error('stage'),
      release = Object.freeze({ failure: 'release' });
    const f = await fixture(kind, {
      primary: { value: primary },
      staging: { value: staging },
      release: { value: release },
    });
    try {
      await assert.rejects(f.run(), (error: unknown) => {
        const values = retained(error);
        assert.equal(values.length, 3);
        assert.equal(values[0], primary);
        assert.equal(values[1], staging);
        assert.equal(values[2], release);
        return true;
      });
      assert.deepEqual(f.hooks.counts(), {
        content: kind === 'bundle' ? 1 : 0,
        staging: 1,
        release: 1,
        write: 1,
        locks: 1,
      });
      assert.equal(f.calls(), kind === 'bundle' ? 1 : 0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  test(`${kind} preserves undefined primary and solitary cleanup identity`, async () => {
    for (const faults of [{ primary: { value: undefined } }, { release: { value: undefined } }]) {
      const f = await fixture(kind, faults);
      try {
        let rejected = false;
        await f.run().then(
          () => assert.fail('must reject'),
          (error: unknown) => {
            rejected = true;
            assert.equal(error, undefined);
          },
        );
        assert.equal(rejected, true);
        assert.equal(f.hooks.counts().release, 1);
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    }
  });
  test(`${kind} release failure leaves published target intact`, async () => {
    const release = new Error('release');
    const f = await fixture(kind, { release: { value: release } });
    try {
      await assert.rejects(f.run(), (error: unknown) => error === release);
      const entries = await readdir(join(f.root, 'cache'));
      const target = entries.find((name) =>
        kind === 'bundle' ? /^[a-f0-9]{64}$/.test(name) : name.startsWith('npm-'),
      );
      assert.ok(target);
      assert.deepEqual(await readFile(join(f.root, 'cache', target, 'wrapper.node')), f.raw);
      assert.equal(f.hooks.counts().staging, 1);
      assert.equal(f.hooks.counts().release, 1);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}
test('bundle retains content cleanup, staging cleanup and release alongside primary', async () => {
  const errors = [
    new Error('write'),
    new Error('content'),
    new Error('stage'),
    new Error('release'),
  ];
  const f = await fixture('bundle', {
    primary: { value: errors[0] },
    content: { value: errors[1] },
    staging: { value: errors[2] },
    release: { value: errors[3] },
  });
  try {
    await assert.rejects(f.run(), (error: unknown) => {
      const values = retained(error);
      assert.equal(values.length, errors.length);
      errors.forEach((error, index) => assert.equal(values[index], error));
      return true;
    });
    assert.deepEqual(f.hooks.counts(), { content: 1, staging: 1, release: 1, write: 1, locks: 1 });
    assert.equal(f.calls(), 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const kind of ['bundle', 'installed'] as const) {
  test(`${kind} concurrent same-target installation keeps one successful acquisition`, async () => {
    const f = await fixture(kind, {});
    try {
      const targets = await Promise.all([f.run(), f.run()]);
      assert.equal(targets[0], targets[1]);
      assert.deepEqual(await readFile(join(targets[0], 'wrapper.node')), f.raw);
      assert.equal(f.hooks.counts().locks, 1);
      assert.equal(f.hooks.counts().release, 1);
      assert.equal(f.calls(), kind === 'bundle' ? 1 : 0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}
