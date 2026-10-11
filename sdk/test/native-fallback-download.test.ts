import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { restoreNativeFallbacks } from '../scripts/download-npm-candidate.mjs';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fallback-download-')),
    input = join(root, 'input'),
    output = join(root, 'output');
  await mkdir(input);
  await mkdir(output);
  const row = (path: string) => {
    const b = Buffer.from(path);
    return {
      path,
      size: b.length,
      sha256: createHash('sha256').update(b).digest('hex'),
      integrity: 'sha512-' + createHash('sha512').update(b).digest('base64'),
    };
  };
  const nativeFallbacks = [],
    packages = [];
  for (const target of [
    'linux-x64',
    'linux-arm64',
    'darwin-x64',
    'darwin-arm64',
    'win32-x64',
    'win32-arm64',
  ]) {
    const name = `qq-native-client-${target}`,
      path = `full-native/${name}-0.0.2.tgz`,
      main = `tested-main/${target}/qq-native-client-0.0.2.tgz`;
    for (const p of [path, main]) {
      await mkdir(join(input, 'package', p.substring(0, p.lastIndexOf('/'))), { recursive: true });
      await writeFile(join(input, 'package', p), p);
    }
    nativeFallbacks.push({ name, version: '0.0.2', ...row(path) });
    packages.push({ name, testedMain: row(main) });
  }
  const archive = join(root, 'fallback.tar.gz');
  const pack = () =>
    execFileSync('tar', ['--format=ustar', '-czf', archive, '-C', input, 'package']);
  pack();
  return {
    root,
    input,
    output,
    archive,
    pack,
    manifest: { version: '0.0.2', nativeFallbacks, packages },
  };
}
test('restores twelve exact bound archives and resumes only identical files', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await restoreNativeFallbacks(f.archive, f.output, f.manifest), {
      members: 12,
    });
    assert.deepEqual(await restoreNativeFallbacks(f.archive, f.output, f.manifest), {
      members: 12,
    });
    const path = f.manifest.nativeFallbacks[0]!.path;
    assert.equal((await readFile(join(f.output, path))).toString(), path);
    await writeFile(join(f.output, path), 'changed');
    await assert.rejects(
      restoreNativeFallbacks(f.archive, f.output, f.manifest),
      /Existing native fallback differs/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('digest and archive closure failures restore no files', async () => {
  const f = await fixture();
  try {
    f.manifest.packages[5]!.testedMain.sha256 = '0'.repeat(64);
    await assert.rejects(restoreNativeFallbacks(f.archive, f.output, f.manifest), /bytes mismatch/);
    await assert.rejects(readFile(join(f.output, f.manifest.nativeFallbacks[0]!.path)), {
      code: 'ENOENT',
    });
    await writeFile(join(f.input, 'package/extra'), 'bad');
    f.pack();
    await assert.rejects(restoreNativeFallbacks(f.archive, f.output, f.manifest), /not closed/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('symlink parent cannot redirect restore', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows symlink permissions');
    return;
  }
  const f = await fixture();
  try {
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(f.output, 'full-native'));
    await assert.rejects(
      restoreNativeFallbacks(f.archive, f.output, f.manifest),
      /parent must be regular/,
    );
    await assert.rejects(readFile(join(outside, 'qq-native-client-linux-x64-0.0.2.tgz')), {
      code: 'ENOENT',
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
