import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRecordCodec } from '../src/features/media/record-codec-loader.ts';
test('explicit local codec modules support named/default exports and reject invalid interfaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qq-codec-'));
  try {
    await assert.rejects(loadRecordCodec('codec.mjs'), /absolute/);
    const named = join(root, 'named.mjs');
    await writeFile(named, 'export async function getDuration(file){return file.length;}');
    assert.equal(await (await loadRecordCodec(named)).getDuration('abc'), 3);
    const defaults = join(root, 'default.mjs');
    await writeFile(
      defaults,
      'export default {base:2,async getDuration(){return this.base;},async convertToNTSilkTct(){}};',
    );
    assert.equal(await (await loadRecordCodec(defaults)).getDuration('abc'), 2);
    const invalid = join(root, 'invalid.mjs');
    await writeFile(invalid, 'export default {getDuration:1};');
    await assert.rejects(loadRecordCodec(invalid), /getDuration/);
    const malformed = join(root, 'malformed.mjs');
    await writeFile(
      malformed,
      'export async function getDuration(){}; export const convertToNTSilkTct=1;',
    );
    await assert.rejects(loadRecordCodec(malformed), /convertToNTSilkTct/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
