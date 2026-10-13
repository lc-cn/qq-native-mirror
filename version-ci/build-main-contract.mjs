import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

/** Windows checkout filters may rewrite line endings. Expected public bytes
 * come from the exact source Git object; network/native bytes stay unchanged.
 */
/** @param {string} sourceCommit @param {string} [name] */
export function readSourceCatalog(sourceCommit, name = 'catalog.json') {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.ok(['catalog.json', 'catalog-linux-legacy-bridge-v1.json'].includes(name));
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceCommit,
  );
  return execFileSync('git', ['show', `${sourceCommit}:${name}`], { maxBuffer: 1024 * 1024 });
}

/** Candidate metadata must come from the same immutable Git tree as the workflow.
 * @param {string} sourceCommit @param {string} manifestUrl
 */
export function readSourceLegacyManifest(sourceCommit, manifestUrl) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  const prefix = 'https://raw.githubusercontent.com/lc-cn/qq-native-mirror/main/';
  assert.ok(manifestUrl.startsWith(prefix));
  const path = manifestUrl.slice(prefix.length);
  assert.match(
    path,
    /^packages\/3\.2\.31-51102-linux-(arm64|x64)-bridge-v1\/[a-f0-9]{64}\/manifest\.json$/,
  );
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceCommit,
  );
  return execFileSync('git', ['show', `${sourceCommit}:${path}`], { maxBuffer: 1024 * 1024 });
}

/** @param {{platform:string,arch:string,sourceCommit:string,environment:NodeJS.ProcessEnv}} identity */
export function validateCurrentBuildIdentity({ platform, arch, sourceCommit, environment }) {
  assert.ok(['darwin', 'linux', 'win32'].includes(platform));
  assert.ok(['x64', 'arm64'].includes(arch));
  assert.equal(environment.SDK_SOURCE_MODE, 'current-source');
  assert.equal(environment.GITHUB_REPOSITORY, 'lc-cn/qq-native-mirror');
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(sourceCommit, environment.GITHUB_SHA);
  assert.match(environment.GITHUB_RUN_ID ?? '', /^[1-9]\d*$/);
  assert.match(environment.GITHUB_RUN_ATTEMPT ?? '', /^[1-9]\d*$/);
}

/** @param {{name:string,version:string,filename:string,files:{path:string}[]}} packed @param {{name:string,version:string}} sdk @param {string} platform @param {string} arch */
export function validatePackedMainInventory(packed, sdk, platform, arch) {
  assert.equal(packed.name, 'qq-native-client');
  assert.equal(packed.name, sdk.name);
  assert.equal(packed.version, sdk.version);
  assert.equal(packed.filename, `${sdk.name}-${sdk.version}.tgz`);
  assert.ok(packed.files.length > 0);
  assert.ok(
    packed.files.every(
      (row) =>
        !/(^|\/)(\.local|test|scripts|node_modules)(\/|$)|\.(db|db-wal|db-shm)$/.test(row.path),
    ),
  );
  assert.ok(packed.files.some((row) => row.path === 'dist/index.js'));
  assert.ok(packed.files.some((row) => row.path === 'dist/worker.js'));
  if (platform !== 'win32')
    assert.ok(
      packed.files.some(
        (row) => row.path === `native/${platform}-${arch}/registration-bridge.node`,
      ),
    );
}
