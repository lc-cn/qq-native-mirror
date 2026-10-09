import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVideoElement } from '../src/media-send.ts';

test('video uses measured metadata and generated thumbnail with native cache contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qq-video-'));
  try {
    const file = join(directory, 'source.mp4');
    await writeFile(file, 'fixture-mp4');
    const ffprobe = join(directory, 'probe');
    const ffmpeg = join(directory, 'encode');
    await writeFile(ffprobe, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({streams:[{width:640,height:360}],format:{duration:'2.75',format_name:'mov,mp4'}}));`, { mode: 0o700 });
    await writeFile(ffmpeg, `#!${process.execPath}\nconst fs=require('node:fs');const p=process.argv.at(-1);const b=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(b);b.write('IHDR',12);b.writeUInt32BE(640,16);b.writeUInt32BE(360,20);fs.writeFileSync(p,b);`, { mode: 0o700 });
    let request: any;
    const destination = join(directory, 'cache', 'Ori', 'video.mp4');
    const result = await createVideoElement(file, { getRichMediaFilePathForGuild(value: any) { request = value; return destination; } }, { ffmpeg, ffprobe });
    assert.equal(request.elementType, 5);
    assert.equal(request.downloadType, 1);
    assert.equal(result.videoElement.fileTime, 2.75);
    assert.equal(result.videoElement.thumbWidth, 640);
    assert.equal(result.videoElement.thumbHeight, 360);
    assert.equal(result.videoElement.fileSize, '11');
    assert.ok(result.videoElement.thumbPath instanceof Map);
    assert.match(result.videoElement.thumbPath.get(0), /Thumb/);
    assert.equal(await readFile(file, 'utf8'), 'fixture-mp4');
    assert.equal(await readFile(destination, 'utf8'), 'fixture-mp4');
    assert.equal('fileFormat' in result.videoElement, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('video fails closed without tools or trustworthy metadata before native staging', async () => {
  await assert.rejects(createVideoElement('/no-file.mp4', {}), /configured/);
  await assert.rejects(createVideoElement('/no-file.mp4', {}, { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }), /absolute executable/);
  const directory = await mkdtemp(join(tmpdir(), 'qq-video-invalid-'));
  try {
    const file = join(directory, 'input.mp4');
    const tool = join(directory, 'tool');
    await writeFile(file, 'not-a-real-video');
    await writeFile(tool, `#!${process.execPath}\nconsole.log(JSON.stringify({streams:[{width:0,height:360}],format:{duration:'NaN',format_name:'mp4'}}));`, { mode: 0o700 });
    let staging = false;
    await assert.rejects(createVideoElement(file, { getRichMediaFilePathForGuild() { staging = true; } }, { ffmpeg: tool, ffprobe: tool }), /Invalid MP4/);
    assert.equal(staging, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
