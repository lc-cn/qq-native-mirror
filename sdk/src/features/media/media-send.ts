import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';
import { promisify } from 'node:util';
import type { VideoCodec } from './video-codec-loader.ts';
import { videoThumbnail } from './video-thumbnail.ts';

export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
}
import type { NativeObject as Native } from '../../native/native-object.ts';
const execute = promisify(execFile);
async function md5(file: string): Promise<string> {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
/** Legacy video contract, pinned primary source:
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-onebot/api/file.ts#L90-L186
 * Only local MP4 input is currently accepted. No fallback metadata or thumbnail.
 * Native sendMsg performs upload; keep its staging files alive until completion.
 */
function alive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Video preparation aborted');
}
async function measured<T>(invoke: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  alive(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Video preparation timed out')), 30_000);
    abort = () => reject(new Error('Video preparation aborted'));
    signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        alive(signal);
        return invoke();
      }),
      stopped,
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
async function validateMp4Header(file: string, size: number): Promise<void> {
  const handle = await open(file, 'r');
  try {
    const data = Buffer.alloc(16);
    const { bytesRead } = await handle.read(data, 0, 16, 0);
    if (
      bytesRead !== 16 ||
      data.toString('ascii', 4, 8) !== 'ftyp' ||
      data.readUInt32BE(0) < 16 ||
      data.readUInt32BE(0) > size
    )
      throw new Error('Invalid MP4 container header');
  } finally {
    await handle.close();
  }
}
export async function createVideoElement(
  file: string,
  msgService: Native,
  tools?: MediaTools,
  codec?: VideoCodec,
  signal?: AbortSignal,
): Promise<Native> {
  alive(signal);
  if (!codec && !tools)
    throw new Error('Video requires configured videoCodecPath or ffmpeg and ffprobe tools');
  if (!codec) {
    for (const name of ['ffmpeg', 'ffprobe'] as const) {
      if (typeof tools![name] !== 'string' || !isAbsolute(tools![name]))
        throw new Error(`${name} requires an absolute executable path`);
      await access(tools![name], constants.X_OK);
    }
  }
  if (typeof file !== 'string' || !isAbsolute(file))
    throw new Error('Video requires an absolute local MP4 path');
  const info = await stat(file);
  if (!info.isFile() || !info.size || extname(file).toLowerCase() !== '.mp4')
    throw new Error('Video requires a nonempty local .mp4 file');
  let width: number,
    height: number,
    duration: number,
    thumbnail: Buffer | undefined,
    extension = 'png';
  if (codec) {
    await validateMp4Header(file, info.size);
    const metadata = await measured(() => codec.getVideoInfo(file), signal);
    alive(signal);
    if (!metadata || typeof metadata !== 'object') throw new Error('Invalid MP4 video metadata');
    ({ width, height, duration } = metadata);
    if (
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      !Number.isSafeInteger(height) ||
      height <= 0 ||
      typeof duration !== 'number' ||
      !Number.isFinite(duration) ||
      duration <= 0
    )
      throw new Error('Invalid MP4 video metadata');
    if (
      !Buffer.isBuffer(metadata.image) ||
      !metadata.image.length ||
      metadata.image.length > 32 * 1024 * 1024
    )
      throw new Error('Invalid video thumbnail buffer');
    thumbnail = Buffer.from(metadata.image);
    extension = videoThumbnail(thumbnail, metadata.format);
  } else {
    const { stdout } = await execute(
      tools!.ffprobe,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height:format=duration,format_name',
        '-of',
        'json',
        file,
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024, signal },
    );
    const probe = JSON.parse(stdout);
    width = probe.streams?.[0]?.width;
    height = probe.streams?.[0]?.height;
    duration = Number(probe.format?.duration);
    if (
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      !Number.isSafeInteger(height) ||
      height <= 0 ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      !String(probe.format?.format_name ?? '')
        .split(',')
        .includes('mp4')
    )
      throw new Error('Invalid MP4 video metadata');
  }
  alive(signal);
  if (typeof msgService.getRichMediaFilePathForGuild !== 'function')
    throw new Error('Native service is missing getRichMediaFilePathForGuild');
  const videoMd5 = await md5(file);
  alive(signal);
  const fileName = basename(file);
  const destination = await measured(
    () =>
      msgService.getRichMediaFilePathForGuild({
        md5HexStr: videoMd5,
        fileName,
        elementType: 5,
        elementSubType: 0,
        thumbSize: 0,
        needCreate: true,
        downloadType: 1,
        file_uuid: '',
      }),
    signal,
  );
  alive(signal);
  if (typeof destination !== 'string' || !isAbsolute(destination))
    throw new Error('Invalid native video staging path');
  // The verified native cache layout supplies Ori and Thumb sibling directories.
  if (!destination.includes(`${sep}Ori${sep}`))
    throw new Error('Unsupported native video cache layout');
  if (destination !== file) {
    await mkdir(dirname(destination), { recursive: true });
    alive(signal);
    await copyFile(file, destination);
  }
  alive(signal);
  const thumbPath = join(
    dirname(destination.replace(`${sep}Ori${sep}`, `${sep}Thumb${sep}`)),
    `${videoMd5}_0.${extension}`,
  );
  await mkdir(dirname(thumbPath), { recursive: true });
  alive(signal);
  if (thumbnail) await writeFile(thumbPath, thumbnail);
  else {
    const thumbnailTime = Math.min(1, duration / 2);
    await execute(
      tools!.ffmpeg,
      ['-i', destination, '-ss', String(thumbnailTime), '-vframes', '1', '-y', thumbPath],
      { timeout: 120_000, maxBuffer: 1024 * 1024, signal },
    );
    thumbnail = await readFile(thumbPath);
    videoThumbnail(thumbnail, 'png');
  }
  alive(signal);
  // Upstream native contract names these thumbWidth/thumbHeight but supplies
  // original video dimensions. The encoded thumbnail may be downsampled.
  return {
    elementType: 5,
    elementId: '',
    videoElement: {
      fileName,
      filePath: destination,
      videoMd5,
      thumbMd5: createHash('md5').update(thumbnail).digest('hex'),
      fileTime: duration,
      thumbPath: new Map([[0, thumbPath]]),
      thumbSize: thumbnail.length,
      thumbWidth: width,
      thumbHeight: height,
      fileSize: String(info.size),
    },
  };
}
