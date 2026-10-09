import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateRelease, publishValidated } from '../scripts/local-first-publish.mjs';

const digest = (bytes: Buffer, algorithm = 'sha256', encoding: 'hex' | 'base64' = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
test('schema 2 binds aggregate receipt bytes while schema 1 remains compatible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-receipt-contract-'));
  const targets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'];
  const names = targets.map(target => `qq-native-client-${target}`);
  const packages: any[] = [];
  const receipt = (platform: string, arch: string) => Buffer.from(JSON.stringify({ platform, arch, node: 'v24.20.0', exports: 100, installedMainOnly: true, automaticPlatformSelection: true, prepared: true, closed: true, loginAttempted: false }));
  try {
    await mkdir(join(root, 'evidence'));
    for (const name of [...names, 'qq-native-client']) {
      const staging = join(root, 'staging'); await mkdir(join(staging, 'package'), { recursive: true });
      const metadata: any = { name, version: '0.0.1' };
      let nativeBytes: Buffer | undefined;
      const target = name.slice('qq-native-client-'.length);
      if (name === 'qq-native-client') metadata.optionalDependencies = Object.fromEntries(names.map(name => [name, '0.0.1']));
      else {
        const [platform, arch] = target.split('-'); Object.assign(metadata, { os: [platform], cpu: [arch] });
        nativeBytes = Buffer.from(JSON.stringify({ platform, arch }));
        await writeFile(join(staging, 'package/manifest.json'), nativeBytes);
      }
      await writeFile(join(staging, 'package/package.json'), JSON.stringify(metadata));
      const tarball = `${name}-0.0.1.tgz`;
      execFileSync('tar', ['--format=ustar', '-czf', join(root, tarball), '-C', staging, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
      const bytes = await readFile(join(root, tarball));
      const row: any = { name, version: '0.0.1', tarball, size: bytes.length, sha256: digest(bytes), integrity: `sha512-${digest(bytes, 'sha512', 'base64')}` };
      if (nativeBytes) {
        const [platform, arch] = target.split('-'), receiptBytes = receipt(platform, arch);
        row.manifestSha256 = digest(nativeBytes); row.receipt = `evidence/${target}.consumer.json`; row.receiptSha256 = digest(receiptBytes);
        await writeFile(join(root, row.receipt), receiptBytes);
      }
      packages.push(row); await rm(staging, { recursive: true });
    }
    const path = 'evidence/aggregated-main.consumer.json', original = receipt('linux', 'x64');
    await writeFile(join(root, path), original);
    const manifest: any = { schemaVersion: 1, repository: 'lc-cn/qq-native-mirror', commit: 'a'.repeat(40), runId: '123', runAttempt: 1, version: '0.0.1', packages };
    const save = () => writeFile(join(root, 'release-manifest.json'), JSON.stringify(manifest));
    await save(); assert.equal((await validateRelease(root)).videoMaterialsPending, false);
    await writeFile(join(root, path), Buffer.concat([original, Buffer.from(' ')])); await validateRelease(root);
    await writeFile(join(root, path), original);
    manifest.schemaVersion = 2; manifest.aggregateReceipt = { path, sha256: digest(original) }; await save(); await validateRelease(root);
    delete manifest.aggregateReceipt; await save(); await assert.rejects(validateRelease(root), /Aggregate receipt binding/);
    manifest.aggregateReceipt = { path: '../unsafe.json', sha256: digest(original) }; await save(); await assert.rejects(validateRelease(root), /Aggregate receipt binding/);
    manifest.aggregateReceipt = { path, sha256: digest(original) }; await save();
    await writeFile(join(root, path), Buffer.concat([original, Buffer.from(' ')]));
    await assert.rejects(validateRelease(root), /Aggregate receipt digest mismatch/);
    await writeFile(join(root, path), original);
    // A checksum-bound candidate may be inspected, but its new static component
    // cannot enter registry lookup/publication before permanent materials exist.
    const row = packages[0], staging = join(root, 'staging');
    await mkdir(staging);
    execFileSync('tar', ['-xzf', row.tarball, '-C', staging], { cwd: root });
    const candidate = Buffer.from(JSON.stringify({ platform: 'linux', arch: 'x64', videoCodec: 'video/video-codec.node' }));
    await writeFile(join(staging, 'package/manifest.json'), candidate);
    execFileSync('tar', ['--format=ustar', '-czf', row.tarball, '-C', staging, 'package'], { cwd: root, env: { ...process.env, COPYFILE_DISABLE: '1' } });
    await rm(staging, { recursive: true });
    const bytes = await readFile(join(root, row.tarball));
    Object.assign(row, { size: bytes.length, sha256: digest(bytes), integrity: `sha512-${digest(bytes, 'sha512', 'base64')}`, manifestSha256: digest(candidate) });
    await save();
    const pending = await validateRelease(root); assert.equal(pending.videoMaterialsPending, true);
    let commands = 0;
    assert.throws(() => publishValidated(pending, () => { commands++; throw new Error('Unexpected command'); }), /permanent corresponding-source\/relink/);
    assert.equal(commands, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
