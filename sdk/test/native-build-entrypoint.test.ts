import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

for (const platform of ['win32', 'freebsd']) {
  test(`native build entrypoint handles ${platform} before compiler or output acquisition`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'qq-native-build-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'scripts'));
    const entry = join(root, 'scripts', 'build-native.ts');
    await copyFile(new URL('../scripts/build-native.ts', import.meta.url), entry);

    // Execute the actual entrypoint in an isolated package root. The override
    // proves branch behavior only; it is not a real Windows build receipt.
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        'Object.defineProperty(process, "platform", {value: process.argv[1]}); await import(process.argv[2]);',
        platform,
        pathToFileURL(entry).href,
      ],
      {
        cwd: root,
        env: { ...process.env, PATH: '', QQ_CC: join(root, 'absent-compiler') },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(result.error, undefined);
    if (platform === 'win32') {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /adapter is supplied by the verified native bundle/);
      assert.equal(result.stderr, '');
    } else {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /received freebsd/);
    }
    assert.deepEqual(await readdir(root), ['scripts']);
    assert.deepEqual(await readdir(join(root, 'scripts')), ['build-native.ts']);
  });
}
