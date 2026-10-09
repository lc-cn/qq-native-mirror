import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecordElement } from '../src/media-record.ts';
const silk = Buffer.concat([Buffer.from('\x02#!SILK_V3'), Buffer.from([1, 0, 7])]);

test('existing SILK is measured in seconds and copied to native cache without conversion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qq-ptt-'));
  try {
    const file = join(directory, 'voice.silk'); await writeFile(file, silk);
    const destination = join(directory, 'cache', 'voice.silk');
    let request: any;
    const result = await createRecordElement(file, { getRichMediaFilePathForGuild(value: any) { request = value; return destination; } }, { async getDuration(path) { assert.equal(path, file); return 0.12; } });
    assert.equal(result.elementType, 4);
    assert.equal(request.elementType, 4);
    assert.equal(result.pttElement.duration, 0.12);
    assert.equal(result.pttElement.filePath, destination);
    assert.equal(result.pttElement.fileSize, String(silk.length));
    assert.deepEqual(await readFile(destination), silk);
    assert.deepEqual(await readFile(file), silk);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('conversion validates outgoing SILK, measures it and cleans only its own temporary file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qq-ptt-convert-'));
  let converted: string | undefined;
  try {
    const file = join(directory, 'voice.wav'); await writeFile(file, 'RIFFfixture');
    const destination = join(directory, 'cache', 'converted.silk');
    const result = await createRecordElement(file, { getRichMediaFilePathForGuild() { return destination; } }, {
      async convertToNTSilkTct(source, output) { assert.equal(source, file); converted = output; await writeFile(output, silk); },
      async getDuration(path) { assert.equal(path, converted); return 1.25; },
    });
    assert.equal(result.pttElement.duration, 1.25);
    assert.deepEqual(await readFile(destination), silk);
    assert.equal(await readFile(file, 'utf8'), 'RIFFfixture');
    await assert.rejects(access(converted!));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('record rejects missing codec, raw PCM and bad duration before native staging', async () => {
  await assert.rejects(createRecordElement('/missing.silk', {}), /configured/);
  const directory = await mkdtemp(join(tmpdir(), 'qq-ptt-invalid-'));
  try {
    const file = join(directory, 'voice.pcm'); await writeFile(file, 'raw-pcm');
    let staging = false;
    const service = { getRichMediaFilePathForGuild() { staging = true; } };
    await assert.rejects(createRecordElement(file, service, { async getDuration() { return 1; } }), /WAV\/PCM/);
    await writeFile(file, silk);
    await assert.rejects(createRecordElement(file, service, { async getDuration() { return NaN; } }), /measured/);
    assert.equal(staging, false);
    await writeFile(file, 'RIFFfixture');
    await assert.rejects(createRecordElement(file, service, { async getDuration() { throw new Error('must not run'); }, async convertToNTSilkTct(_source, output) { await writeFile(output, 'not-silk'); } }), /did not produce/);
    assert.equal(staging, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
