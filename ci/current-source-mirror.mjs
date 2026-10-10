import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm, access, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { npm } from './npm.mjs';
import { readMainArtifact } from '../version-ci/main-artifact.mjs';
import { verifyMirrorConsumer } from '../sdk/scripts/mirror-consumer-contract.mjs';

const directory = await mkdtemp(join(tmpdir(), 'qq-current-main-installed-'));
const output = resolve('out/current-source-mirror.json');
const env = { ...process.env };
for (const name of Object.keys(env))
  if (/TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) || name === 'NODE_OPTIONS') delete env[name];
let stage = 'main-source';
try {
  const artifact = await readMainArtifact();
  assert.equal(artifact.source.mode, 'current-source');
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  stage = 'install-main-only';
  execFileSync(
    npm[0],
    [
      ...npm[1],
      'install',
      resolve(artifact.path),
      '--omit=optional',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      join(directory, 'npm-cache'),
    ],
    { cwd: directory, env, stdio: 'inherit', timeout: 240000 },
  );
  const installedRoot = join(directory, 'node_modules/qq-native-client');
  const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/qq-native-client'].integrity, artifact.row.integrity);
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const arch of ['x64', 'arm64']) {
      await assert.rejects(
        access(join(directory, 'node_modules', `qq-native-client-${platform}-${arch}`)),
        { code: 'ENOENT' },
      );
    }
  }
  stage = 'installed-contracts';
  const { createClient } = await import(pathToFileURL(join(installedRoot, 'dist/index.js')).href);
  const { selectNativePackage } = await import(
    pathToFileURL(join(installedRoot, 'dist/native/native-catalog.js')).href
  );
  const { prepareNative } = await import(
    pathToFileURL(join(installedRoot, 'dist/native/native-package.js')).href
  );
  const catalogBytes = await readFile('catalog.json');
  const selected = selectNativePackage(JSON.parse(catalogBytes), process.platform, process.arch);
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  // Same no-symlink policy reaches the actual worker and the codec child.
  stage = 'symlink-policy';
  await assert.rejects(symlink('unused', join(directory, 'unused')), { code: 'EPERM' });
  let verifier = await readFile('sdk/scripts/verify-video-native.mjs', 'utf8');
  assert.ok(verifier.includes("'../dist/"));
  verifier = verifier.replaceAll("'../dist/", "'./node_modules/qq-native-client/dist/");
  const verifierPath = join(directory, 'verify-video.mjs');
  await writeFile(verifierPath, verifier);
  stage = 'default-cold-warm-runtime';
  const receipt = await verifyMirrorConsumer({
    createClient,
    selected,
    catalogSha256: sha(catalogBytes),
    verifyCodec: async (options) => {
      const prepared = await prepareNative(options);
      assert.deepEqual(prepared.version, selected.version);
      assert.ok(prepared.videoCodecPath, 'Default bundle does not expose its codec');
      execFileSync(
        process.execPath,
        [
          verifierPath,
          prepared.videoCodecPath,
          resolve('sdk/test/video-fixtures'),
          resolve('out/current-source-video.json'),
        ],
        {
          env: { ...env, NODE_OPTIONS: process.env.NODE_OPTIONS },
          stdio: 'inherit',
          timeout: 120000,
        },
      );
      const video = JSON.parse(await readFile('out/current-source-video.json', 'utf8'));
      assert.ok(video.passed && video.noAccount && video.noQQ && video.inputs.length === 3);
      assert.equal(video.nativeSendAttempted, false);
    },
  });
  Object.assign(receipt, {
    success: true,
    installedMainOnly: true,
    symlinkCreationDenied: true,
    sourceCommit: artifact.source.commit,
    sourceRun: artifact.source.runId,
    runAttempt: artifact.source.runAttempt,
    main: artifact.row,
    published: false,
  });
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
} catch {
  await writeFile(
    output,
    JSON.stringify(
      {
        success: false,
        failureStage: stage,
        sourceCommit: process.env.GITHUB_SHA,
        sourceRun: process.env.GITHUB_RUN_ID,
        runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        loginAttempted: false,
        restoreAttempted: false,
        nativeSendAttempted: false,
        published: false,
      },
      null,
      2,
    ) + '\n',
  );
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
