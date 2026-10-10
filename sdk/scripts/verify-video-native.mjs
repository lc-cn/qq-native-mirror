import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadVideoCodec } from '../dist/features/media/video-codec-loader.js';
import { createVideoElement } from '../dist/features/media/media-send.js';

// Local synthetic H264 media and our explicit codec only; no QQ wrapper/account/send.
const args = process.argv.slice(2);
if (args.length !== 3)
  throw Error(
    'Usage: node scripts/verify-video-native.mjs ADDON_PATH FIXTURE_DIRECTORY RECEIPT_PATH',
  );
const [addonPath, fixtureDirectory, receiptPath] = args.map((path) => resolve(path));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const receipt = {
  schemaVersion: 1,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  noAccount: true,
  noQQ: true,
  nativeSendAttempted: false,
  passed: false,
  inputs: [],
};
let stage = 'binary',
  scratch;
function bmp(image, width, height, pattern = 'blue') {
  assert.ok(Buffer.isBuffer(image));
  assert.equal(image.toString('ascii', 0, 2), 'BM');
  assert.equal(image.readUInt32LE(2), image.length);
  assert.equal(image.readUInt32LE(10), 54);
  assert.equal(image.readUInt32LE(14), 40);
  assert.equal(image.readInt32LE(18), width);
  assert.equal(image.readInt32LE(22), -height);
  assert.equal(image.readUInt16LE(26), 1);
  assert.equal(image.readUInt16LE(28), 24);
  assert.equal(image.readUInt32LE(30), 0);
  const stride = Math.ceil((width * 3) / 4) * 4;
  assert.equal(image.length, 54 + stride * height);
  assert.equal(image.readUInt32LE(34), stride * height);
  // FFmpeg YUV conversion may round blue slightly; verify every pixel's color.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = 54 + y * stride + x * 3;
      if (pattern === 'blue' || y < Math.floor(height / 3))
        assert.ok(
          image[offset] >= 200 && image[offset + 1] <= 40 && image[offset + 2] <= 40,
          'Expected top blue BGR pixel',
        );
      else if (y >= Math.ceil((height * 2) / 3))
        assert.ok(
          image[offset] <= 40 && image[offset + 1] <= 40 && image[offset + 2] >= 200,
          'Expected bottom red BGR pixel',
        );
    }
    for (let x = width * 3; x < stride; x++) assert.equal(image[54 + y * stride + x], 0);
  }
}
try {
  const binary = await readFile(addonPath);
  receipt.binary = { sha256: sha(binary), bytes: binary.length };
  const addon = createRequire(import.meta.url)(addonPath);
  assert.equal(typeof addon.getVideoInfo, 'function');
  receipt.exports = Object.keys(addon).sort();
  const codec = await loadVideoCodec(addonPath);
  scratch = await mkdtemp(join(tmpdir(), 'qq-owned-video-'));
  stage = 'decode';
  for (const [name, width, height, coverWidth, coverHeight, expectedSha, pattern] of [
    [
      'blue-64.mp4',
      64,
      64,
      64,
      64,
      'ced7b4e1cd47d948ecf407116095282e5b5ca4df76142b7a06826eecb92cb932',
    ],
    [
      'blue-1280.mp4',
      1280,
      720,
      640,
      360,
      '1c8920f2db13e3c1b28b708bc94d3889ed8bd10f15ee5d89881d99715188b468',
    ],
    [
      'blue-red-65.mp4',
      65,
      33,
      65,
      33,
      '53a0baad6f0853d39e53263c22c847bd78435fc263e6844450878b471d13cc57',
      'blue-red',
    ],
  ]) {
    const file = join(fixtureDirectory, name),
      original = await readFile(file),
      digest = sha(original);
    assert.equal(digest, expectedSha, 'Synthetic fixture source changed');
    const decoded = await codec.getVideoInfo(file);
    assert.equal(decoded.width, width);
    assert.equal(decoded.height, height);
    assert.equal(decoded.format, 'bmp24');
    assert.ok(Number.isFinite(decoded.duration) && Math.abs(decoded.duration - 0.4) <= 0.08);
    bmp(decoded.image, coverWidth, coverHeight, pattern);
    if (pattern === 'blue-red') assert.equal(decoded.image.length, 6522);
    const concurrent = await Promise.all([codec.getVideoInfo(file), codec.getVideoInfo(file)]);
    for (const value of concurrent) {
      assert.equal(value.width, width);
      assert.equal(value.height, height);
      assert.deepEqual(value.image, decoded.image);
      assert.equal(value.duration, decoded.duration);
    }
    const unicode = join(scratch, `蓝色视频-${width}.mp4`);
    await copyFile(file, unicode);
    const unicodeInfo = await codec.getVideoInfo(unicode);
    assert.deepEqual(unicodeInfo.image, decoded.image);
    stage = 'sdk-cache';
    let staging = 0;
    const destination = join(scratch, String(width), 'Ori', 'video.mp4');
    const element = await createVideoElement(
      unicode,
      {
        getRichMediaFilePathForGuild(request) {
          staging++;
          assert.equal(request.elementType, 5);
          assert.equal(request.downloadType, 1);
          return destination;
        },
      },
      undefined,
      codec,
    );
    assert.equal(staging, 1);
    assert.equal(element.elementType, 5);
    assert.equal(element.videoElement.thumbWidth, width);
    assert.equal(element.videoElement.thumbHeight, height);
    assert.ok(Math.abs(element.videoElement.fileTime - 0.4) <= 0.08);
    assert.equal(element.videoElement.fileSize, String(original.length));
    assert.ok(element.videoElement.thumbPath instanceof Map);
    assert.deepEqual(await readFile(element.videoElement.thumbPath.get(0)), decoded.image);
    assert.equal(sha(await readFile(file)), digest);
    assert.equal(sha(await readFile(unicode)), digest);
    assert.equal(sha(await readFile(destination)), digest);
    receipt.inputs.push({
      name,
      sha256: digest,
      bytes: original.length,
      width,
      height,
      duration: decoded.duration,
      thumbnailWidth: coverWidth,
      thumbnailHeight: coverHeight,
      thumbnailSha256: sha(decoded.image),
      thumbnailBytes: decoded.image.length,
      pattern: pattern ?? 'blue',
      rowStride: Math.ceil((coverWidth * 3) / 4) * 4,
    });
    stage = 'decode';
  }
  stage = 'rejections';
  const malformed = join(scratch, 'malformed.mp4');
  await writeFile(malformed, 'malformed local media fixture');
  for (const path of [malformed, join(scratch, 'missing.mp4'), 'https://example.invalid/video.mp4'])
    await assert.rejects(async () => codec.getVideoInfo(path));
  receipt.concurrentDecode = true;
  receipt.unicodeFilename = true;
  receipt.malformedMissingNetworkRejected = true;
  receipt.sourceUnchanged = true;
  receipt.sdkFakeCache = true;
  receipt.passed = true;
} catch {
  receipt.failureStage = stage;
  process.exitCode = 1;
} finally {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
}
