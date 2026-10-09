import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinRecordCodec, validateSilkFrames } from '../src/builtin-record-codec.ts';
import { createRecordElement } from '../src/media-record.ts';

function wav(seconds = 1.24): Buffer {
  const rate = 24000, samples = Math.round(rate * seconds), data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8,4); data.write('WAVE',8); data.write('fmt ',12); data.writeUInt32LE(16,16); data.writeUInt16LE(1,20); data.writeUInt16LE(1,22); data.writeUInt32LE(rate,24); data.writeUInt32LE(rate*2,28); data.writeUInt16LE(2,32); data.writeUInt16LE(16,34); data.write('data',36); data.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++) data.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/rate)*8000),44+i*2);
  return data;
}
test('built-in WASM codec produces real Tencent SILK, measured seconds and native staging', async () => {
  const directory = await mkdtemp(join(tmpdir(),'qq-builtin-silk-'));
  try {
    const input = join(directory,'fixture.wav'), output = join(directory,'encoded.silk'); await writeFile(input,wav());
    await builtinRecordCodec.convertToNTSilkTct!(input,output);
    assert.equal(validateSilkFrames(await readFile(output)),62);
    assert.equal(await builtinRecordCodec.getDuration(output),1.24);
    const destination = join(directory,'cache','voice.silk');
    const result=await createRecordElement(input,{getRichMediaFilePathForGuild(){return destination;}},builtinRecordCodec);
    assert.equal(result.pttElement.duration,1.24);
    assert.equal(result.elementType,4);
    assert.deepEqual(await readFile(destination),await readFile(output));
    assert.deepEqual(await readFile(input),wav());
    await assert.rejects(builtinRecordCodec.convertToNTSilkTct!(input,output),/EEXIST/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('built-in codec rejects raw PCM, truncated containers and undecodable packets', async () => {
  assert.throws(()=>validateSilkFrames(Buffer.from('\x02#!SILK_V3\x01')),/length/);
  assert.throws(()=>validateSilkFrames(Buffer.from('\x02#!SILK_V3\x08\x00\x01')),/payload/);
  assert.throws(()=>validateSilkFrames(Buffer.from('#!SILK_V3')),/Tencent/);
  const directory=await mkdtemp(join(tmpdir(),'qq-builtin-invalid-'));
  try {
    const raw=join(directory,'raw.pcm'); await writeFile(raw,Buffer.alloc(128));
    await assert.rejects(builtinRecordCodec.convertToNTSilkTct!(raw,join(directory,'out.silk')),/accepts local WAV/);
    await writeFile(raw,Buffer.from('\x02#!SILK_V3\x01\x00\xff'));
    await assert.rejects(builtinRecordCodec.getDuration(raw));
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('built-in codec rejects non-PCM16 and inconsistent WAV metadata before encoding', async () => {
  const directory = await mkdtemp(join(tmpdir(),'qq-builtin-wav-format-'));
  try {
    const input=join(directory,'input.wav'), output=join(directory,'output.silk');
    for (const [offset,value,width,pattern] of [
      [20,3,2,/requires PCM16|accepts local WAV/], [34,8,2,/requires PCM16|accepts local WAV/],
      [32,4,2,/metadata is inconsistent|accepts local WAV/], [28,1,4,/metadata is inconsistent|accepts local WAV/],
    ] as const) {
      const data=wav();
      if(width===2) data.writeUInt16LE(value,offset); else data.writeUInt32LE(value,offset);
      await writeFile(input,data);
      await assert.rejects(builtinRecordCodec.convertToNTSilkTct!(input,output),pattern);
      await assert.rejects(readFile(output),/ENOENT/);
    }
  } finally { await rm(directory,{recursive:true,force:true}); }
});
