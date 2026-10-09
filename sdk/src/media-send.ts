import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';
import { promisify } from 'node:util';

export interface MediaTools { ffmpeg: string; ffprobe: string }
type Native = Record<string, any>;
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
export async function createVideoElement(file: string, msgService: Native, tools?: MediaTools): Promise<Native> {
  if (!tools) throw new Error('Video requires configured ffmpeg and ffprobe tools');
  for (const name of ['ffmpeg', 'ffprobe'] as const) {
    if (typeof tools[name] !== 'string' || !isAbsolute(tools[name])) throw new Error(`${name} requires an absolute executable path`);
    await access(tools[name], constants.X_OK);
  }
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('Video requires an absolute local MP4 path');
  const info = await stat(file);
  if (!info.isFile() || !info.size || extname(file).toLowerCase() !== '.mp4') throw new Error('Video requires a nonempty local .mp4 file');
  const { stdout } = await execute(tools.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration,format_name', '-of', 'json', file], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const probe = JSON.parse(stdout);
  const width = probe.streams?.[0]?.width;
  const height = probe.streams?.[0]?.height;
  const duration = Number(probe.format?.duration);
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0 || !Number.isFinite(duration) || duration <= 0 || !String(probe.format?.format_name ?? '').split(',').includes('mp4')) throw new Error('Invalid MP4 video metadata');
  if (typeof msgService.getRichMediaFilePathForGuild !== 'function') throw new Error('Native service is missing getRichMediaFilePathForGuild');
  const videoMd5 = await md5(file);
  const fileName = basename(file);
  const destination = await msgService.getRichMediaFilePathForGuild({ md5HexStr: videoMd5, fileName, elementType: 5, elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: '' });
  if (typeof destination !== 'string' || !isAbsolute(destination)) throw new Error('Invalid native video staging path');
  // The verified native cache layout supplies Ori and Thumb sibling directories.
  if (!destination.includes(`${sep}Ori${sep}`)) throw new Error('Unsupported native video cache layout');
  if (destination !== file) { await mkdir(dirname(destination), { recursive: true }); await copyFile(file, destination); }
  const thumbPath = join(dirname(destination.replace(`${sep}Ori${sep}`, `${sep}Thumb${sep}`)), `${videoMd5}_0.png`);
  await mkdir(dirname(thumbPath), { recursive: true });
  const thumbnailTime = Math.min(1, duration / 2);
  await execute(tools.ffmpeg, ['-i', destination, '-ss', String(thumbnailTime), '-vframes', '1', '-y', thumbPath], { timeout: 120_000, maxBuffer: 1024 * 1024 });
  const thumbnail = await readFile(thumbPath);
  if (thumbnail.length < 24 || thumbnail.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || thumbnail.toString('ascii', 12, 16) !== 'IHDR' || thumbnail.readUInt32BE(16) !== width || thumbnail.readUInt32BE(20) !== height) throw new Error('Invalid generated video thumbnail');
  return { elementType: 5, elementId: '', videoElement: { fileName, filePath: destination, videoMd5, thumbMd5: createHash('md5').update(thumbnail).digest('hex'), fileTime: duration, thumbPath: new Map([[0, thumbPath]]), thumbSize: thumbnail.length, thumbWidth: width, thumbHeight: height, fileSize: String(info.size) } };
}
