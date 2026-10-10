import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCurrentBuildIdentity,
  validatePackedMainInventory,
} from './build-main-contract.mjs';

const sourceCommit = 'a'.repeat(40);
const environment = {
  SDK_SOURCE_MODE: 'current-source',
  GITHUB_REPOSITORY: 'lc-cn/qq-native-mirror',
  GITHUB_SHA: sourceCommit,
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
};
const sdk = { name: 'qq-native-client', version: '0.0.2' };
for (const platform of ['linux', 'darwin', 'win32']) {
  for (const arch of ['x64', 'arm64']) {
    test(`current main ${platform}/${arch} requires the exact source run and host bridge`, () => {
      validateCurrentBuildIdentity({ platform, arch, sourceCommit, environment });
      const packed = {
        ...sdk,
        filename: 'qq-native-client-0.0.2.tgz',
        files: [
          { path: 'dist/index.js' },
          { path: 'dist/worker.js' },
          ...(platform === 'win32'
            ? []
            : [{ path: `native/${platform}-${arch}/registration-bridge.node` }]),
        ],
      };
      validatePackedMainInventory(packed, sdk, platform, arch);
      for (const name of Object.keys(environment))
        assert.throws(() =>
          validateCurrentBuildIdentity({
            platform,
            arch,
            sourceCommit,
            environment: { ...environment, [name]: 'wrong' },
          }),
        );
      assert.throws(() =>
        validatePackedMainInventory(
          { ...packed, files: [...packed.files, { path: 'test/account.db' }] },
          sdk,
          platform,
          arch,
        ),
      );
      assert.throws(() =>
        validatePackedMainInventory({ ...packed, filename: '../wrong.tgz' }, sdk, platform, arch),
      );
      assert.throws(() =>
        validatePackedMainInventory(
          { ...packed, files: [{ path: 'dist/index.js' }] },
          sdk,
          platform,
          arch,
        ),
      );
      if (platform !== 'win32')
        assert.throws(() =>
          validatePackedMainInventory(
            { ...packed, files: packed.files.slice(0, 2) },
            sdk,
            platform,
            arch,
          ),
        );
    });
  }
}
