import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Compiled SDK with fake JS codecs and cache service; never loads QQ/native codec or sends. */
export async function verifyVideoConsumerContract(packagePath) {
  const load = name => import(pathToFileURL(join(packagePath, 'dist', name)).href);
  const { loadVideoCodec } = await load('video-codec-loader.js');
  const { createVideoElement } = await load('media-send.js');
  const { createNativeServices } = await load('native-services.js');
  const root = await mkdtemp(join(tmpdir(), 'qq-video-codec-consumer-'));
  try {
    const file = join(root, 'source.mp4'), bytes = Buffer.alloc(24);
    bytes.writeUInt32BE(24, 0); bytes.write('ftyp', 4); bytes.write('isom', 8);
    await writeFile(file, bytes);
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
    const metadata = { width: 1, height: 1, duration: 2.75, format: 'png', image };
    for (const [name, source] of [
      ['named.mjs', `export const getVideoInfo=async()=>({width:1,height:1,duration:2.75,format:'png',image:Buffer.from('${image.toString('base64')}','base64')});`],
      ['default.mjs', `export default {getVideoInfo:async()=>({width:1,height:1,duration:2.75,format:'png',image:Buffer.from('${image.toString('base64')}','base64')})};`],
    ]) {
      const path = join(root, name); await writeFile(path, source);
      const codec = await loadVideoCodec(path); assert.equal(typeof codec.getVideoInfo, 'function');
      // Module filenames and cache directories use separate paths.
      const cache = join(root, `cache-${name}`, 'Ori', 'video.mp4'); let staged = 0;
      const element = await createVideoElement(file, { getRichMediaFilePathForGuild(request) { staged++; assert.equal(request.elementType, 5); assert.equal(request.downloadType, 1); return cache; } }, { ffmpeg: '/not-invoked/ffmpeg', ffprobe: '/not-invoked/ffprobe' }, codec);
      assert.equal(staged, 1); assert.equal(element.elementType, 5);
      assert.equal(element.videoElement.fileTime, 2.75); assert.equal(element.videoElement.thumbWidth, 1); assert.equal(element.videoElement.thumbHeight, 1);
      assert.ok(element.videoElement.thumbPath instanceof Map);
      assert.deepEqual(await readFile(element.videoElement.thumbPath.get(0)), image);
      assert.deepEqual(await readFile(cache), bytes); assert.deepEqual(await readFile(file), bytes);
    }
    const scaledCache = join(root, 'cache-scaled', 'Ori', 'video.mp4');
    const scaled = await createVideoElement(file, { getRichMediaFilePathForGuild() { return scaledCache; } }, undefined,
      { getVideoInfo: async () => ({ ...metadata, width: 1280, height: 720 }) });
    assert.equal(scaled.videoElement.thumbWidth, 1280); assert.equal(scaled.videoElement.thumbHeight, 720);
    assert.deepEqual(await readFile(scaled.videoElement.thumbPath.get(0)), image);
    assert.equal('videoWidth' in scaled.videoElement, false); assert.equal('videoHeight' in scaled.videoElement, false);
    await assert.rejects(loadVideoCodec('relative-codec.mjs'), /absolute/i);
    const invalid = join(root, 'invalid.mjs'); await writeFile(invalid, 'export default {};');
    await assert.rejects(loadVideoCodec(invalid), /getVideoInfo|codec/i);
    for (const change of [{ width: 0 }, { duration: NaN }, { duration: 0 }, { format: 'mp4' }, { image: Buffer.from('invalid') }, { image: 'not a buffer' }]) {
      let staged = 0;
      await assert.rejects(createVideoElement(file, { getRichMediaFilePathForGuild() { staged++; throw Error('Invalid codec must not stage'); } }, undefined, { getVideoInfo: async () => ({ ...metadata, ...change }) }));
      assert.equal(staged, 0); assert.deepEqual(await readFile(file), bytes);
    }
    let staged = 0;
    await assert.rejects(createVideoElement(file, { getRichMediaFilePathForGuild() { staged++; } }, { ffmpeg: '/not-invoked', ffprobe: '/not-invoked' }, { getVideoInfo: async () => { throw Error('Synthetic codec failure'); } }), /Synthetic codec failure/);
    assert.equal(staged, 0);
    const controller = new AbortController(); let started;
    const began = new Promise(resolve => { started = resolve; });
    const pending = createVideoElement(file, { getRichMediaFilePathForGuild() { staged++; } }, undefined, { getVideoInfo: async () => { started(); return new Promise(() => {}); } }, controller.signal);
    const checked = assert.rejects(pending, /abort|closed/i);
    await began; controller.abort(); let timer;
    try { await Promise.race([checked, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Codec abort did not settle')), 1000); })]); }
    finally { clearTimeout(timer); }
    assert.equal(staged, 0);
    let codecStarted, cacheCalls = 0, sendCalls = 0;
    const codecBegan = new Promise(resolve => { codecStarted = resolve; });
    const services = createNativeServices({
      getMsgService: () => ({ addKernelMsgListener() {}, getRichMediaFilePathForGuild() { cacheCalls++; }, sendMsg() { sendCalls++; }, generateMsgUniqueId() { throw Error('Must not generate ID during pending codec'); } }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }), getGroupService: () => ({ addKernelGroupListener() {} }),
    }, '7.0.2-53644', () => {}, undefined, undefined, undefined, undefined, undefined,
      { getVideoInfo: async () => { codecStarted(); return new Promise(() => {}); } });
    const waiting = services.invokeOperation('sendGroupMessage', { groupId: '123', message: [{ type: 'video', file }] });
    const stopped = assert.rejects(waiting, /abort|closed/i);
    try {
      await codecBegan; services.close();
      let deadline;
      try { await Promise.race([stopped, new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('Session codec close did not settle')), 1000); })]); }
      finally { clearTimeout(deadline); }
      assert.equal(cacheCalls, 0); assert.equal(sendCalls, 0);
    } finally { services.close(); }
    return { videoCodecContract: true, nativeVideoSendAttempted: false };
  } finally { await rm(root, { recursive: true, force: true }); }
}
