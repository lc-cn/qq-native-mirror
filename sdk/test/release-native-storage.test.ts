import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { validateNativeStorageReceipt, validateRelease } from '../scripts/local-first-publish.mjs';

const native = {
  files: [{ path: 'wrapper.node' }, { path: 'duplicate-wrapper.node' }],
  npmStorage: { format: 'gzip-objects-v1', objects: [{ sha256: 'fixture' }] },
};
const proof = {
  format: 'gzip-objects-v1',
  nativePaths: 2,
  objects: 1,
  allOriginalFilesVerified: true,
  warmCacheReused: true,
  networkFallbackAttempted: false,
  packageSha256: 'a'.repeat(64),
  nativeManifestSha256: 'b'.repeat(64),
  mainPackageSha256: 'c'.repeat(64),
};
const packageIdentity = {
  auxiliarySha256: proof.packageSha256,
  manifestSha256: proof.nativeManifestSha256,
  mainSha256: proof.mainPackageSha256,
};

test('object release requires its own complete restore, warm-cache and no-network evidence', () => {
  validateNativeStorageReceipt(native, { installedNativeStorage: proof }, packageIdentity);
  for (const change of [
    { format: 'plain-installed' },
    { nativePaths: 1 },
    { objects: 2 },
    { allOriginalFilesVerified: false },
    { warmCacheReused: false },
    { networkFallbackAttempted: true },
    { packageSha256: 'd'.repeat(64) },
    { nativeManifestSha256: 'd'.repeat(64) },
    { mainPackageSha256: 'd'.repeat(64) },
  ]) {
    assert.throws(
      () =>
        validateNativeStorageReceipt(
          native,
          { installedNativeStorage: { ...proof, ...change } },
          packageIdentity,
        ),
      /Complete object storage consumer receipt mismatch/,
    );
  }
  for (const key of Object.keys(proof)) {
    const incomplete = { ...proof } as Record<string, unknown>;
    delete incomplete[key];
    assert.throws(
      () =>
        validateNativeStorageReceipt(
          native,
          { installedNativeStorage: incomplete },
          packageIdentity,
        ),
      /Complete object storage consumer receipt mismatch/,
    );
  }
  assert.throws(() => validateNativeStorageReceipt(native, {}), /consumer receipt mismatch/);
  assert.throws(
    () => validateNativeStorageReceipt(native, { installedNativeStorage: proof }),
    /consumer receipt mismatch/,
  );
  assert.throws(
    () =>
      validateNativeStorageReceipt(native, {
        installedNativeStorage: { format: 'plain-installed' },
      }),
    /consumer receipt mismatch/,
  );
});

test('plain historical receipts stay compatible without allowing contradictory object proof', () => {
  validateNativeStorageReceipt({ files: [] }, {});
  validateNativeStorageReceipt(
    { files: [] },
    { installedNativeStorage: { format: 'plain-installed' } },
  );
  assert.throws(
    () => validateNativeStorageReceipt({ files: [] }, { installedNativeStorage: proof }),
    /cannot describe a plain native package/,
  );
  for (const npmStorage of [null, { format: 'unknown' }])
    assert.throws(
      () =>
        validateNativeStorageReceipt({ ...native, npmStorage }, { installedNativeStorage: proof }),
      /consumer receipt mismatch/,
    );
});

test('seven-package release checks each object receipt and the separately bound aggregate receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-object-release-contract-'));
  const targets = [
    'linux-x64',
    'linux-arm64',
    'darwin-x64',
    'darwin-arm64',
    'win32-x64',
    'win32-arm64',
  ];
  const names = targets.map((target) => 'qq-native-client-' + target);
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const installedNativeStorage = { ...proof, nativePaths: 3, objects: 3 };
  const consumer = (platform: string, arch: string, storage = installedNativeStorage) => ({
    platform,
    arch,
    node: 'v24.20.0',
    exports: 100,
    installedMainOnly: true,
    automaticPlatformSelection: true,
    prepared: true,
    closed: true,
    loginAttempted: false,
    installedNativeStorage: storage,
  });
  interface Row {
    name: string;
    version: string;
    tarball: string;
    size: number;
    sha256: string;
    integrity: string;
    manifestSha256?: string;
    receipt?: string;
    receiptSha256?: string;
    testedMain?: { path: string; sha256: string; size: number; integrity: string };
  }
  const packages: Row[] = [];
  const nativeFallbacks: {
    name: string;
    version: string;
    path: string;
    size: number;
    sha256: string;
    integrity: string;
    manifestSha256: string;
  }[] = [];
  const mainPath = 'evidence/aggregated-main.consumer.json';
  try {
    await mkdir(join(root, 'evidence'));
    await mkdir(join(root, 'full-native'));
    await mkdir(join(root, 'tested-main'));
    for (const name of [...names, 'qq-native-client']) {
      const staging = join(root, 'staging');
      await mkdir(join(staging, 'package/objects'), { recursive: true });
      const metadata: Record<string, unknown> = { name, version: '0.0.3' };
      let manifestBytes: Buffer | undefined;
      const target = name.slice('qq-native-client-'.length);
      if (name === 'qq-native-client') {
        metadata.optionalDependencies = Object.fromEntries(names.map((name) => [name, '0.0.3']));
      } else {
        const [platform, arch] = target.split('-');
        Object.assign(metadata, { os: [platform], cpu: [arch] });
        const payloads = new Map([
          ['wrapper.node', Buffer.from('never-executed-wrapper')],
          ['video/video-codec.node', Buffer.from('never-executed-codec')],
          ['video/SOURCE-PROVENANCE.json', Buffer.from('{}')],
        ]);
        const objects = [];
        for (const bytes of payloads.values()) {
          const compressed = gzipSync(bytes);
          const object = {
            path: `objects/${sha(bytes)}.gz`,
            sha256: sha(bytes),
            size: bytes.length,
            downloadSha256: sha(compressed),
            downloadSize: compressed.length,
          };
          objects.push(object);
          await writeFile(join(staging, 'package', object.path), compressed);
        }
        manifestBytes = Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            platform,
            arch,
            wrapper: 'wrapper.node',
            videoCodec: 'video/video-codec.node',
            files: [...payloads].map(([path, bytes]) => ({
              path,
              url: path,
              sha256: sha(bytes),
              size: bytes.length,
            })),
            npmStorage: { format: 'gzip-objects-v1', objects },
          }),
        );
        await writeFile(join(staging, 'package/manifest.json'), manifestBytes);
        await writeFile(join(staging, 'package/README.md'), 'Controlled archive fixture');
        const fullStaging = join(root, 'full-staging');
        const original = JSON.parse(manifestBytes.toString());
        delete original.npmStorage;
        for (const [path, bytes] of payloads) {
          await mkdir(join(fullStaging, 'package', ...path.split('/').slice(0, -1)), {
            recursive: true,
          });
          await writeFile(join(fullStaging, 'package', path), bytes);
        }
        const originalBytes = Buffer.from(JSON.stringify(original));
        await writeFile(join(fullStaging, 'package/manifest.json'), originalBytes);
        await writeFile(join(fullStaging, 'package/package.json'), JSON.stringify(metadata));
        await writeFile(join(fullStaging, 'package/README.md'), 'Original full fixture');
        const fallbackPath = `full-native/${name}-0.0.3.tgz`;
        execFileSync(
          'tar',
          ['--format=ustar', '-czf', join(root, fallbackPath), '-C', fullStaging, 'package'],
          { env: { ...process.env, COPYFILE_DISABLE: '1' } },
        );
        const fallbackBytes = await readFile(join(root, fallbackPath));
        nativeFallbacks.push({
          name,
          version: '0.0.3',
          path: fallbackPath,
          size: fallbackBytes.length,
          sha256: sha(fallbackBytes),
          integrity: 'sha512-' + createHash('sha512').update(fallbackBytes).digest('base64'),
          manifestSha256: sha(originalBytes),
        });
        await rm(fullStaging, { recursive: true });
      }
      await writeFile(join(staging, 'package/package.json'), JSON.stringify(metadata));
      const tarball = `${name}-0.0.3.tgz`;
      execFileSync(
        'tar',
        ['--format=ustar', '-czf', join(root, tarball), '-C', staging, 'package'],
        {
          env: { ...process.env, COPYFILE_DISABLE: '1' },
        },
      );
      const bytes = await readFile(join(root, tarball));
      const row: Row = {
        name,
        version: '0.0.3',
        tarball,
        size: bytes.length,
        sha256: sha(bytes),
        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
      };
      if (manifestBytes) {
        const [platform, arch] = target.split('-');
        const receiptBytes = Buffer.from(
          JSON.stringify(
            consumer(platform!, arch!, {
              ...installedNativeStorage,
              packageSha256: row.sha256,
              nativeManifestSha256: sha(manifestBytes),
            }),
          ),
        );
        row.manifestSha256 = sha(manifestBytes);
        row.receipt = `evidence/${target}.consumer.json`;
        row.receiptSha256 = sha(receiptBytes);
        await writeFile(join(root, row.receipt), receiptBytes);
      }
      packages.push(row);
      await rm(staging, { recursive: true });
    }
    const actualMain = await readFile(join(root, packages[6]!.tarball));
    for (const [index, target] of targets.entries()) {
      const row = packages[index]!;
      const path = `tested-main/${target}/${packages[6]!.tarball}`;
      await mkdir(join(root, 'tested-main', target));
      await writeFile(join(root, path), actualMain);
      row.testedMain = {
        path,
        size: actualMain.length,
        sha256: sha(actualMain),
        integrity: 'sha512-' + createHash('sha512').update(actualMain).digest('base64'),
      };
      const receipt = JSON.parse((await readFile(join(root, row.receipt!))).toString());
      receipt.installedNativeStorage.mainPackageSha256 = sha(actualMain);
      const bytes = Buffer.from(JSON.stringify(receipt));
      await writeFile(join(root, row.receipt!), bytes);
      row.receiptSha256 = sha(bytes);
    }
    const aggregateStorage = {
      ...installedNativeStorage,
      packageSha256: packages[0]!.sha256,
      nativeManifestSha256: packages[0]!.manifestSha256!,
      mainPackageSha256: packages[6]!.sha256,
    };
    const mainBytes = Buffer.from(JSON.stringify(consumer('linux', 'x64', aggregateStorage)));
    await writeFile(join(root, mainPath), mainBytes);
    const release = {
      schemaVersion: 2,
      repository: 'lc-cn/qq-native-mirror',
      commit: 'a'.repeat(40),
      runId: '123',
      runAttempt: 1,
      version: '0.0.3',
      packages,
      nativeFallbacks,
      aggregateReceipt: { path: mainPath, sha256: sha(mainBytes) },
    };
    const save = () => writeFile(join(root, 'release-manifest.json'), JSON.stringify(release));
    await save();
    // No real consumer ran; missing video materials continue to block publication.
    assert.equal((await validateRelease(root)).videoMaterialsPending, true);
    const fallback = nativeFallbacks[0]!;
    const fallbackOriginal = await readFile(join(root, fallback.path));
    await writeFile(join(root, fallback.path), Buffer.from('tampered'));
    const originalDeclaration = { ...fallback };
    fallback.size = 8;
    fallback.sha256 = sha(Buffer.from('tampered'));
    fallback.integrity = 'sha512-' + createHash('sha512').update('tampered').digest('base64');
    await save();
    await assert.rejects(validateRelease(root));
    await writeFile(join(root, fallback.path), fallbackOriginal);
    Object.assign(fallback, originalDeclaration);
    await save();
    await writeFile(join(root, 'full-native/extra.tgz'), 'extra');
    await assert.rejects(validateRelease(root));
    await rm(join(root, 'full-native/extra.tgz'));
    const removed = nativeFallbacks.pop()!;
    await save();
    await assert.rejects(validateRelease(root), /six complete native fallbacks/);
    nativeFallbacks.push(removed);
    await save();
    const tested = packages[0]!.testedMain!;
    const testedOriginal = await readFile(join(root, tested.path));
    const testedDeclaration = { ...tested };
    const changedMainDirectory = join(root, 'changed-main');
    await mkdir(join(changedMainDirectory, 'package'), { recursive: true });
    await writeFile(
      join(changedMainDirectory, 'package/package.json'),
      JSON.stringify({
        name: 'qq-native-client',
        version: '0.0.3',
        optionalDependencies: Object.fromEntries(names.map((name) => [name, '0.0.3'])),
      }),
    );
    await writeFile(
      join(changedMainDirectory, 'package/README.md'),
      'changed but valid main archive',
    );
    execFileSync(
      'tar',
      ['--format=ustar', '-czf', join(root, tested.path), '-C', changedMainDirectory, 'package'],
      { env: { ...process.env, COPYFILE_DISABLE: '1' } },
    );
    const changedMainBytes = await readFile(join(root, tested.path));
    tested.size = changedMainBytes.length;
    tested.sha256 = sha(changedMainBytes);
    tested.integrity = 'sha512-' + createHash('sha512').update(changedMainBytes).digest('base64');
    await save();
    await assert.rejects(validateRelease(root));
    await writeFile(join(root, tested.path), testedOriginal);
    Object.assign(tested, testedDeclaration);
    await save();
    const row = packages[1]!;
    const corrected = await readFile(join(root, row.receipt!));
    const plain = Buffer.from(
      JSON.stringify({ ...consumer('linux', 'arm64'), installedNativeStorage: undefined }),
    );
    await writeFile(join(root, row.receipt!), plain);
    row.receiptSha256 = sha(plain);
    await save();
    await assert.rejects(
      validateRelease(root),
      /Complete object storage consumer receipt mismatch/,
    );
    await writeFile(join(root, row.receipt!), corrected);
    row.receiptSha256 = sha(corrected);
    const incompleteMain = Buffer.from(
      JSON.stringify({
        ...consumer('linux', 'x64'),
        installedNativeStorage: { ...aggregateStorage, warmCacheReused: false },
      }),
    );
    await writeFile(join(root, mainPath), incompleteMain);
    release.aggregateReceipt.sha256 = sha(incompleteMain);
    await save();
    await assert.rejects(
      validateRelease(root),
      /Complete object storage consumer receipt mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
