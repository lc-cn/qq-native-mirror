import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  linuxVideoDockerArgs,
  assertLinuxVideoBudget,
  linuxVideoImage,
} from './linux-video-baseline.mjs';

test('build permits pinned downloads while all later stages share an offline read-only baseline', () => {
  const root = resolve(tmpdir(), 'repo with spaces');
  for (const arch of ['x64', 'arm64']) {
    const build = linuxVideoDockerArgs('build', arch, root, 1001, 1001);
    assert.ok(build.includes(linuxVideoImage));
    assert.ok(!build.includes('--network=none'));
    for (const stage of ['verify', 'relink', 'verify-relinked', 'dependencies']) {
      const args = linuxVideoDockerArgs(stage, arch, root, 1001, 1001);
      assert.ok(args.includes('--network=none'));
      assert.ok(args.includes(`type=bind,src=${root},dst=/workspace,readonly`));
      assert.ok(
        args.includes(`type=bind,src=${resolve(root, 'out/video')},dst=/workspace/out/video`),
      );
      assert.deepEqual(args.slice(-5), [
        'node',
        'ci/linux-video-baseline.mjs',
        '--inside',
        stage,
        arch,
      ]);
      assert.equal(
        args[args.indexOf('--platform') + 1],
        arch === 'arm64' ? 'linux/arm64' : 'linux/amd64',
      );
    }
  }
  assert.throws(() => linuxVideoDockerArgs('verify; rm', 'x64', '/tmp/repo', 1, 1), /Unknown/);
  assert.throws(() => linuxVideoDockerArgs('build', 'riscv64', '/tmp/repo', 1, 1), /architecture/);
  assert.throws(() => linuxVideoDockerArgs('build', 'x64', '/tmp/repo,escape', 1, 1), /bind path/);
});

test('symbol budget rejects newer libm or libstdc++ and missing evidence rather than relying on build host', () => {
  assert.deepEqual(
    assertLinuxVideoBudget('Name: GLIBC_2.29\nName: GLIBC_2.2.5\nName: GLIBCXX_3.4.26'),
    { glibc: '2.29', glibcxx: '3.4.26' },
  );
  for (const input of [
    'GLIBC_2.38 GLIBCXX_3.4.26',
    'GLIBC_2.35 GLIBCXX_3.4.26',
    'GLIBC_2.34.1 GLIBCXX_3.4.26',
    'GLIBC_2.29 GLIBCXX_3.4.27',
    '',
  ])
    assert.throws(() => assertLinuxVideoBudget(input));
});

test('invalid CLI inputs fail before workspace creation or external-tool acquisition', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'qq-video-baseline-refusal-'));
  const entry = fileURLToPath(new URL('./linux-video-baseline.mjs', import.meta.url));
  /** @type {Array<[string[], RegExp]>} */
  const cases = [
    [['build; execute', 'x64'], /Unknown Linux video stage/],
    [['build', 'riscv64'], /Unsupported Linux video architecture/],
    [['verify'], /Expected STAGE ARCH/],
  ];
  try {
    for (const [args, expected] of cases) {
      const result = spawnSync(process.execPath, [entry, ...args], {
        cwd: scratch,
        env: { ...process.env, PATH: '' },
        encoding: 'utf8',
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, expected);
      assert.deepEqual(readdirSync(scratch), []);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
