import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';

/** Exact pinned NapCat codec contract; no FFmpeg CLI SILK encoder is assumed.
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/helper/ffmpeg/ffmpeg-addon.ts
 */
export interface RecordCodec {
  getDuration(filePath: string): Promise<number>;
  convertToNTSilkTct?(inputPath: string, outputPath: string): Promise<void>;
}
type Native = Record<string, any>;
async function isSilk(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(10);
    const { bytesRead } = await handle.read(header, 0, 10, 0);
    const prefix = header.subarray(0, bytesRead);
    return prefix.subarray(0, 9).toString() === '#!SILK_V3' || (prefix[0] === 2 && prefix.subarray(1, 10).toString() === '#!SILK_V3');
  } finally { await handle.close(); }
}
/** Build native PTT after codec verification. Does not load codecs or send messages.
 * Native element contract:
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-onebot/api/file.ts#L189-L234
 * The constant waveform is the upstream presentation default, not measured audio.
 */
export async function createRecordElement(file: string, msgService: Native, codec?: RecordCodec): Promise<Native> {
  if (!codec || typeof codec.getDuration !== 'function') throw new Error('Record requires a configured SILK-capable duration codec');
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('Record requires an absolute local file path');
  const sourceInfo = await stat(file);
  if (!sourceInfo.isFile() || sourceInfo.size === 0) throw new Error('Record requires a nonempty local file');
  let convertedDirectory: string | undefined;
  let silkFile = file;
  try {
    if (!(await isSilk(file))) {
      if (typeof codec.convertToNTSilkTct !== 'function') throw new Error('Record conversion requires convertToNTSilkTct; WAV/PCM cannot be sent directly');
      convertedDirectory = await mkdtemp(join(tmpdir(), 'qq-silk-'));
      silkFile = join(convertedDirectory, 'converted.silk');
      await codec.convertToNTSilkTct(file, silkFile);
      if (!(await isSilk(silkFile))) throw new Error('Codec did not produce SILK_V3 audio');
    }
    // Measure the actual outgoing SILK, never infer duration from byte count.
    const duration = await codec.getDuration(silkFile);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid measured SILK duration');
    const info = await stat(silkFile);
    if (!info.isFile() || info.size <= 10) throw new Error('SILK audio has no payload');
    const hash = createHash('md5');
    for await (const chunk of createReadStream(silkFile)) hash.update(chunk);
    const md5HexStr = hash.digest('hex');
    const fileName = basename(silkFile);
    if (typeof msgService.getRichMediaFilePathForGuild !== 'function') throw new Error('Native service is missing getRichMediaFilePathForGuild');
    const destination = await msgService.getRichMediaFilePathForGuild({ md5HexStr, fileName, elementType: 4, elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: '' });
    if (typeof destination !== 'string' || !isAbsolute(destination) || (convertedDirectory && destination.startsWith(convertedDirectory + sep))) throw new Error('Invalid native record staging path');
    if (destination !== silkFile) { await mkdir(dirname(destination), { recursive: true }); await copyFile(silkFile, destination); }
    return { elementType: 4, elementId: '', pttElement: {
      fileName, filePath: destination, md5HexStr, fileSize: String(info.size), duration,
      formatType: 1, voiceType: 1, voiceChangeType: 0, canConvert2Text: true,
      waveAmplitudes: [0, 18, 9, 23, 16, 17, 16, 15, 44, 17, 24, 20, 14, 15, 17],
      fileSubId: '', playState: 1, autoConvertText: 0, storeID: 0, otherBusinessInfo: { aiVoiceType: 0 },
    } };
  } finally { if (convertedDirectory) await rm(convertedDirectory, { recursive: true, force: true }); }
}
