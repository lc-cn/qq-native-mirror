import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const linuxVideoImage =
  'node:24.20.0-bullseye@sha256:25f3016fcdae6b5d65bd9bcb4064b7e4198ec8d49493fa40d73f9b463d04fb15';
const stages = new Set(['build', 'verify', 'relink', 'verify-relinked', 'dependencies']);

/** @param {string} stage @param {string} arch */
function validate(stage, arch) {
  assert.ok(stages.has(stage), 'Unknown Linux video stage');
  assert.ok(arch === 'x64' || arch === 'arm64', 'Unsupported Linux video architecture');
}

/** Build and relink use the same immutable multiarchitecture userspace.
 * @param {string} stage @param {string} arch @param {string} root
 * @param {number} uid @param {number} gid */
export function linuxVideoDockerArgs(stage, arch, root, uid, gid) {
  validate(stage, arch);
  assert.ok(Number.isSafeInteger(uid) && uid >= 0 && Number.isSafeInteger(gid) && gid >= 0);
  root = resolve(root);
  // Docker --mount has a comma-separated grammar even though exec uses argv.
  assert.ok(!/[\0,\r\n]/.test(root), 'Unsupported Docker bind path');
  return [
    'run',
    '--rm',
    '--platform',
    arch === 'arm64' ? 'linux/arm64' : 'linux/amd64',
    ...(stage === 'build' ? [] : ['--network=none']),
    '--user',
    `${uid}:${gid}`,
    '--mount',
    `type=bind,src=${root},dst=/workspace,readonly`,
    '--mount',
    `type=bind,src=${resolve(root, 'out/video')},dst=/workspace/out/video`,
    '--workdir',
    '/workspace',
    linuxVideoImage,
    'node',
    'ci/linux-video-baseline.mjs',
    '--inside',
    stage,
    arch,
  ];
}

/** Static symbol budget; no addon execution is needed to reject a newer ABI.
 * @param {string} output */
export function assertLinuxVideoBudget(output) {
  const versions = [...output.matchAll(/\b(GLIBCXX|GLIBC)_([0-9]+(?:\.[0-9]+)+)\b/g)];
  assert.ok(
    versions.some((row) => row[1] === 'GLIBC'),
    'Missing ELF glibc requirements',
  );
  const maximum = (/** @type {string} */ family) => {
    const values = [...new Set(versions.filter((row) => row[1] === family).map((row) => row[2]))];
    values.sort((a, b) => {
      const left = a.split('.').map(Number),
        right = b.split('.').map(Number);
      for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const difference = (left[i] ?? 0) - (right[i] ?? 0);
        if (difference) return difference;
      }
      return 0;
    });
    return values.at(-1);
  };
  const glibc = maximum('GLIBC'),
    glibcxx = maximum('GLIBCXX');
  const within = (/** @type {string|undefined} */ value, /** @type {number[]} */ limit) => {
    if (!value) return false;
    const parts = value.split('.').map(Number);
    for (let i = 0; i < Math.max(parts.length, limit.length); i++) {
      const delta = (parts[i] ?? 0) - (limit[i] ?? 0);
      if (delta) return delta < 0;
    }
    return true;
  };
  assert.ok(within(glibc, [2, 34]), 'Linux video exceeds GLIBC_2.34 budget');
  assert.ok(within(glibcxx, [3, 4, 26]), 'Linux video exceeds GLIBCXX_3.4.26 budget');
  return { glibc, glibcxx };
}

/** @param {string} command @param {string[]} args */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed with ${result.signal ?? result.status}`);
}

/** @param {string} file @param {string} arch */
async function budget(file, arch) {
  const bytes = await readFile(file);
  assert.equal(
    bytes.subarray(0, 6).toString('hex'),
    '7f454c460201',
    'Expected little-endian ELF64',
  );
  assert.equal(bytes.readUInt16LE(18), arch === 'arm64' ? 183 : 62, 'Wrong ELF target');
  const output = execFileSync('readelf', ['--version-info', '--wide', file], { encoding: 'utf8' });
  console.log(JSON.stringify({ file, ...assertLinuxVideoBudget(output) }));
}

/** @param {string} stage @param {string} arch */
async function inside(stage, arch) {
  validate(stage, arch);
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, arch);
  assert.equal(process.version, 'v24.20.0');
  assert.equal(
    execFileSync('getconf', ['GNU_LIBC_VERSION'], { encoding: 'utf8' }).trim(),
    'glibc 2.31',
    'Wrong Linux video build baseline',
  );
  const node = process.execPath,
    base = 'out/video';
  if (stage === 'build') {
    run(node, ['sdk/scripts/prepare-video-source.mjs', base]);
    run(node, ['sdk/scripts/build-video-native.mjs', base]);
    await budget(`${base}/runtime/video-codec.node`, arch);
  } else if (stage === 'relink') {
    run(node, [
      'sdk/scripts/relink-video-native.mjs',
      `${base}/relink`,
      `${base}/relink`,
      `${base}/relinked/video-codec.node`,
    ]);
    await budget(`${base}/relinked/video-codec.node`, arch);
  } else if (stage === 'verify' || stage === 'verify-relinked') {
    const binary =
      stage === 'verify' ? `${base}/runtime/video-codec.node` : `${base}/relinked/video-codec.node`;
    await budget(binary, arch);
    run(node, [
      'sdk/scripts/verify-video-native.mjs',
      binary,
      'sdk/test/video-fixtures',
      stage === 'verify' ? `${base}/runtime/consumer.json` : `${base}/relink/consumer.json`,
    ]);
  } else {
    const dependencies = execFileSync('ldd', [`${base}/runtime/video-codec.node`], {
      encoding: 'utf8',
    });
    await writeFile(`${base}/runtime/dependencies.txt`, dependencies);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] === '--inside') {
    assert.equal(args.length, 3, 'Expected --inside STAGE ARCH');
    await inside(args[1], args[2]);
  } else {
    assert.equal(args.length, 2, 'Expected STAGE ARCH');
    validate(args[0], args[1]);
    assert.equal(process.platform, 'linux', 'Docker baseline entry requires a Linux runner');
    await mkdir('out/video', { recursive: true });
    run(
      'docker',
      linuxVideoDockerArgs(
        args[0],
        args[1],
        process.cwd(),
        process.getuid?.() ?? -1,
        process.getgid?.() ?? -1,
      ),
    );
  }
}
