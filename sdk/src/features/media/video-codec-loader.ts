import { createRequire } from 'node:module';
import { extname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpath, stat } from 'node:fs/promises';

export interface VideoInfo {
  width: number;
  height: number;
  /** Measured video duration in seconds. */
  duration: number;
  /** Thumbnail format, not the video container format. */
  format: 'jpg' | 'jpeg' | 'png' | 'bmp' | 'bmp24';
  image: Buffer;
}
export interface VideoCodec {
  getVideoInfo(filePath: string): Promise<VideoInfo>;
}
/** Only load an explicitly supplied local module. Standard Node addons use the
 * CommonJS loader; JS modules may provide named or default exports. */
export async function loadVideoCodec(modulePath: string): Promise<VideoCodec> {
  if (typeof modulePath !== 'string' || !isAbsolute(modulePath))
    throw new Error('videoCodecPath must be an absolute local module path');
  const file = await realpath(modulePath);
  if (!(await stat(file)).isFile()) throw new Error('videoCodecPath must identify a module file');
  const imported =
    extname(file) === '.node'
      ? createRequire(import.meta.url)(file)
      : await import(pathToFileURL(file).href);
  const codec = typeof imported?.getVideoInfo === 'function' ? imported : imported?.default;
  if (!codec || typeof codec.getVideoInfo !== 'function')
    throw new Error('Video codec must export getVideoInfo(filePath)');
  return codec;
}
