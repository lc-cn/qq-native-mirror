import assert from 'node:assert/strict';

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
