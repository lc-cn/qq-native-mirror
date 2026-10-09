import { readFile, writeFile, stat } from 'node:fs/promises';
import { encode, decode, getWavFileInfo, isWav } from 'silk-wasm';
import type { RecordCodec } from './media-record.ts';

const SAMPLE_RATE = 24000;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_SECONDS = 300;
async function boundedRead(file: string): Promise<Buffer> {
  const info = await stat(file);
  if (!info.isFile() || !info.size || info.size > MAX_INPUT_BYTES) throw new Error('Record input must be a nonempty file of at most 32 MiB');
  const data = await readFile(file);
  if (data.length > MAX_INPUT_BYTES) throw new Error('Record input exceeds 32 MiB');
  return data;
}
/** Tencent SILK_V3 framing, verified against pinned silk-wasm 3.7.1 encoder.
 * https://github.com/idranme/silk-wasm/blob/5971995be3ce05d4a1bf820fdf9d7ccdc942e945/binding/libSilkCodec/src/encoder.c
 * The verified codec always encodes one 20 ms frame per packet.
 */
export function validateSilkFrames(data: Uint8Array): number {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buffer.length > MAX_INPUT_BYTES || buffer.subarray(0, 10).toString() !== '\x02#!SILK_V3') throw new Error('Expected Tencent SILK_V3 container');
  let offset = 10, packets = 0;
  while (offset < buffer.length) {
    if (offset + 2 > buffer.length) throw new Error('Truncated SILK frame length');
    const size = buffer.readUInt16LE(offset);
    if (size === 0 || offset + 2 + size > buffer.length) throw new Error('Invalid SILK frame payload');
    offset += 2 + size;
    packets++;
    if (packets * 0.02 > MAX_SECONDS) throw new Error('Record duration exceeds 300 seconds');
  }
  if (!packets) throw new Error('SILK audio has no frames');
  return packets;
}
async function verifiedDuration(data: Uint8Array): Promise<number> {
  const frames = validateSilkFrames(data);
  const result = await decode(data, SAMPLE_RATE);
  // Cross-check actual decoded samples against the validated packet framing. Never trust frame
  // counts alone, which cannot establish packet decoding or frame duration.
  // silk-wasm decoder duration includes its lookahead packet count; use actual
  // emitted PCM samples, not the returned duration field.
  const seconds = result.data.byteLength / (2 * SAMPLE_RATE);
  if (!result.data.byteLength || result.data.byteLength % 2 || !Number.isFinite(result.duration) || Math.abs(seconds - frames * 0.02) > 0.000001) throw new Error('SILK decoded duration does not match verified 20 ms frames');
  return seconds;
}
export const builtinRecordCodec: RecordCodec = {
  async getDuration(filePath) {
    const data = await boundedRead(filePath);
    return verifiedDuration(data);
  },
  async convertToNTSilkTct(inputPath, outputPath) {
    const data = await boundedRead(inputPath);
    if (!data.length || data.length > MAX_INPUT_BYTES || !isWav(data)) throw new Error('Built-in record codec accepts local WAV or existing Tencent SILK only');
    const info = getWavFileInfo(data);
    if (info.fmt.formatCode !== 1 || info.fmt.bitsPerSample !== 16) throw new Error('Built-in record codec requires PCM16 WAV');
    const expectedFrameBytes = info.fmt.numberOfChannels * 2;
    if (info.fmt.bytesPerFrame !== expectedFrameBytes || info.fmt.bytesPerSec !== info.fmt.sampleRate * expectedFrameBytes) throw new Error('WAV PCM16 frame metadata is inconsistent');
    if (![8000, 12000, 16000, 24000, 32000, 44100, 48000].includes(info.fmt.sampleRate)) throw new Error('Unsupported WAV sample rate');
    const audioBytes = info.chunkInfo.find(chunk => chunk.chunkId === 'data')?.dataLength;
    if (audioBytes && audioBytes % expectedFrameBytes !== 0) throw new Error('WAV contains an incomplete PCM16 sample frame');
    if (!audioBytes || !Number.isFinite(info.fmt.bytesPerSec) || info.fmt.bytesPerSec <= 0 || audioBytes / info.fmt.bytesPerSec > MAX_SECONDS || info.fmt.numberOfChannels < 1 || info.fmt.numberOfChannels > 2) throw new Error('WAV requires one or two channels and at most 300 seconds');
    const result = await encode(data, 0);
    const seconds = await verifiedDuration(result.data);
    if (!Number.isFinite(result.duration) || Math.abs(seconds * 1000 - result.duration) > 0.001) throw new Error('Encoded SILK duration mismatch');
    await writeFile(outputPath, result.data, { flag: 'wx', mode: 0o600 });
  },
};
