import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDedupInstalledReceipts,
  inspectConsumerSdkFiles,
  inspectDedupCandidate,
} from './verify-dedup-consumer.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readNativeTarFiles } from '../sdk/scripts/native-tar-files.mjs';
const fixtures = [
  'ced7b4e1cd47d948ecf407116095282e5b5ca4df76142b7a06826eecb92cb932',
  '1c8920f2db13e3c1b28b708bc94d3889ed8bd10f15ee5d89881d99715188b468',
  '53a0baad6f0853d39e53263c22c847bd78435fc263e6844450878b471d13cc57',
];

test('candidate inspection acquires its independent trust root once and rejects explicit null', async () => {
  const root = await mkdtemp(join(tmpdir(), 'consumer-null-pin-'));
  try {
    await writeFile(
      join(root, 'dedup-build.json'),
      JSON.stringify({
        schemaVersion: 1,
        experimental: true,
        device: 'linux-x64',
        source: {},
        accountAcceptanceEstablished: false,
        signingAuthenticityEstablished: false,
        published: false,
        defaultsChanged: false,
      }),
    );
    await writeFile(join(root, 'source-native-manifest.json'), '{}');
    await writeFile(join(root, 'source-release-manifest.json'), '{}');
    let reads = 0;
    await assert.rejects(
      inspectDedupCandidate(root, {
        get sourceReleaseSha256() {
          reads++;
          return null;
        },
      }),
      /Independent source release SHA-256 required/,
    );
    assert.equal(reads, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
function windowsArm() {
  const build = { device: 'win32-arm64' };
  const manifest = {
    nodeVersion: 'v24.20.0',
    videoCodec: 'video/video-codec.node',
    files: [{ path: 'video/video-codec.node', sha256: 'a'.repeat(64), size: 19 }],
  };
  const video = {
    passed: true,
    noAccount: true,
    noQQ: true,
    nativeSendAttempted: false,
    platform: 'win32',
    arch: 'arm64',
    node: 'v24.20.0',
    binary: { sha256: 'a'.repeat(64), bytes: 19 },
    sdkFakeCache: true,
    inputs: fixtures.map((sha256) => ({ sha256 })),
  };
  const receipt = {
    platform: 'win32',
    arch: 'arm64',
    node: 'v24.20.0',
    exports: 98,
    installedMainOnly: true,
    automaticPlatformSelection: true,
    prepared: true,
    closed: true,
    loginAttempted: false,
    accountUsed: false,
    nativeMessageBatchQueryAttempted: false,
    installedCliEntrypointContract: true,
    posixNpmBinEntrypointChecked: false,
    pendingReadCloseContract: true,
    reentrantReadCloseContract: true,
    historyInputCaptureContract: true,
    loginWaitIdentityContract: true,
    watchReconnectPolicyContract: true,
    nativeHistoryQueryAttempted: false,
    sessionStrategyContract: true,
    nativeSessionStrategyLoginAttempted: false,
    attachmentDownloadContract: true,
    nativeAttachmentDownloadAttempted: false,
    forwardResourceContract: true,
    forwardResourceTypedElementsContract: true,
    forwardResourceDeclarationsContract: true,
    nativeForwardResourceAttempted: false,
    receivedForwardContract: true,
    nativeReceivedForwardObserved: false,
    mergedForwardClientContract: true,
    mergedForwardServiceContract: true,
    nativeMergedForwardAttempted: false,
    messageBatchQueryContract: true,
    messageBatchCliContract: true,
    installedNativeStorage: {
      format: 'gzip-objects-v1',
      nativePaths: 27,
      objects: 26,
      allOriginalFilesVerified: true,
      warmCacheReused: true,
      networkFallbackAttempted: false,
    },
    tarballRequests: ['qq-native-client', 'qq-native-client-win32-arm64', 'silk-wasm'],
  };
  return { build, manifest, receipt, video };
}
test('Windows ARM64 acceptance requires exact ABI, platform inventory, genuine codec and no account scope', () => {
  const valid = windowsArm();
  validateDedupInstalledReceipts(valid.build, valid.manifest, valid.receipt, valid.video);
  for (const mutate of [
    (x) => {
      x.receipt.node = 'v24.19.0';
      x.video.node = 'v24.19.0';
    },
    (x) => (x.receipt.arch = 'x64'),
    (x) => (x.receipt.exports = 104),
    (x) => (x.receipt.installedNativeStorage.nativePaths = 32),
    (x) => (x.receipt.installedNativeStorage.objects = 27),
    (x) => (x.receipt.accountUsed = true),
    (x) => (x.receipt.loginAttempted = true),
    (x) => (x.receipt.nativeMessageBatchQueryAttempted = true),
    (x) => delete x.receipt.installedCliEntrypointContract,
    (x) => (x.receipt.posixNpmBinEntrypointChecked = true),
    (x) => delete x.receipt.pendingReadCloseContract,
    (x) => (x.receipt.reentrantReadCloseContract = false),
    (x) => delete x.receipt.historyInputCaptureContract,
    (x) => (x.receipt.loginWaitIdentityContract = false),
    (x) => (x.receipt.watchReconnectPolicyContract = false),
    (x) => (x.receipt.nativeHistoryQueryAttempted = true),
    (x) => delete x.receipt.sessionStrategyContract,
    (x) => (x.receipt.nativeSessionStrategyLoginAttempted = true),
    (x) => delete x.receipt.attachmentDownloadContract,
    (x) => (x.receipt.nativeAttachmentDownloadAttempted = true),
    (x) => delete x.receipt.forwardResourceContract,
    (x) => delete x.receipt.forwardResourceTypedElementsContract,
    (x) => (x.receipt.forwardResourceDeclarationsContract = false),
    (x) => (x.receipt.nativeForwardResourceAttempted = true),
    (x) => delete x.receipt.receivedForwardContract,
    (x) => (x.receipt.nativeReceivedForwardObserved = true),
    (x) => delete x.receipt.mergedForwardClientContract,
    (x) => (x.receipt.mergedForwardServiceContract = false),
    (x) => (x.receipt.nativeMergedForwardAttempted = true),
    (x) => (x.receipt.installedNativeStorage.networkFallbackAttempted = true),
    (x) => (x.receipt.closed = false),
    (x) => (x.video.noAccount = false),
    (x) => (x.video.binary.sha256 = 'b'.repeat(64)),
    (x) => (x.video.inputs[2] = x.video.inputs[0]),
    (x) => x.receipt.tarballRequests.push('qq-native-client-win32-x64'),
  ]) {
    const x = windowsArm();
    mutate(x);
    assert.throws(() => validateDedupInstalledReceipts(x.build, x.manifest, x.receipt, x.video));
  }
});
test('Linux acceptance uses its own complete inventory rather than macOS counts', () => {
  const x = windowsArm();
  x.build.device = 'linux-x64';
  delete x.manifest.nodeVersion;
  x.receipt.platform = x.video.platform = 'linux';
  x.receipt.posixNpmBinEntrypointChecked = true;
  x.receipt.arch = x.video.arch = 'x64';
  x.receipt.installedNativeStorage.nativePaths = 19;
  x.receipt.installedNativeStorage.objects = 19;
  x.receipt.tarballRequests = ['qq-native-client', 'qq-native-client-linux-x64', 'silk-wasm'];
  validateDedupInstalledReceipts(x.build, x.manifest, x.receipt, x.video);
  x.receipt.installedNativeStorage.nativePaths = 1168;
  x.receipt.installedNativeStorage.objects = 321;
  assert.throws(() => validateDedupInstalledReceipts(x.build, x.manifest, x.receipt, x.video));
});

async function mainArchiveFiles({
  path = 'dist/native/native-installed-storage.js',
  metadata = { name: 'qq-native-client', version: '0.0.2' },
  loader = Buffer.from('export const fixture = 1;'),
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dedup-main-path-'));
  try {
    const members = new Map([['package/package.json', Buffer.from(JSON.stringify(metadata))]]);
    if (path) members.set(`package/${path}`, loader);
    const chunks = [];
    for (const [name, bytes] of members) {
      const header = Buffer.alloc(512);
      header.write(name, 0, 100, 'utf8');
      for (const [offset, width, value] of [
        [100, 8, 0o644],
        [108, 8, 0],
        [116, 8, 0],
        [124, 12, bytes.length],
        [136, 12, 0],
      ])
        header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii');
      header.fill(32, 148, 156);
      header[156] = 48;
      header.write('ustar\0', 257, 6, 'ascii');
      header.write('00', 263, 2, 'ascii');
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
      chunks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
    }
    const archive = join(root, 'main.tgz');
    await writeFile(archive, gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)])));
    return await readNativeTarFiles(archive);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('consumer SDK archive binds only the current canonical storage loader bytes', async () => {
  const loader = Buffer.from('export const fixture = 1;');
  const files = await mainArchiveFiles({ loader });
  const result = inspectConsumerSdkFiles(files);
  assert.equal(result.storageLoaderSha256, createHash('sha256').update(loader).digest('hex'));
  const changed = inspectConsumerSdkFiles(
    await mainArchiveFiles({ loader: Buffer.from('export const fixture = 2;') }),
  );
  assert.notEqual(changed.storageLoaderSha256, result.storageLoaderSha256);
});
test('consumer SDK archive refuses missing and obsolete-only loader paths', async () => {
  for (const path of ['', 'dist/native-installed-storage.js']) {
    const files = await mainArchiveFiles({ path });
    assert.throws(() => inspectConsumerSdkFiles(files), /storage loader/);
  }
});
test('consumer SDK archive refuses unrelated package identity and changed metadata', async () => {
  for (const metadata of [
    { name: 'foreign-package', version: '0.0.2' },
    { name: 'qq-native-client', version: '0.0.1' },
  ]) {
    const files = await mainArchiveFiles({ metadata });
    assert.throws(() => inspectConsumerSdkFiles(files), /consumer SDK/);
  }
});

test('explicit source inventory counts retain exact exports, ABI and account boundaries', () => {
  const x = windowsArm();
  const sourceContract = { paths: 30, objects: 29, exports: 98 };
  x.receipt.installedNativeStorage.nativePaths = 30;
  x.receipt.installedNativeStorage.objects = 29;
  assert.throws(() => validateDedupInstalledReceipts(x.build, x.manifest, x.receipt, x.video));
  validateDedupInstalledReceipts(x.build, x.manifest, x.receipt, x.video, sourceContract);
  x.receipt.exports = 99;
  assert.throws(() =>
    validateDedupInstalledReceipts(x.build, x.manifest, x.receipt, x.video, sourceContract),
  );
  x.receipt.exports = 98;
  x.receipt.accountUsed = true;
  assert.throws(() =>
    validateDedupInstalledReceipts(x.build, x.manifest, x.receipt, x.video, sourceContract),
  );
});

test('consumer SDK version is bound to its selected source rather than accepting any main', async () => {
  const files = await mainArchiveFiles({
    metadata: { name: 'qq-native-client', version: '1.2.3-next.1' },
  });
  assert.throws(() => inspectConsumerSdkFiles(files), /Wrong consumer SDK/);
  inspectConsumerSdkFiles(files, '1.2.3-next.1');
  assert.throws(() => inspectConsumerSdkFiles(files, '1.2.3-next.2'), /Wrong consumer SDK/);
});
