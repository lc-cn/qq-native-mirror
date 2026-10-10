import { createRequire } from 'node:module';
import { extname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpath, stat } from 'node:fs/promises';

import type { VideoCodec } from '../../runtime/media-contracts.ts';
export type { VideoCodec, VideoInfo } from '../../runtime/media-contracts.ts';
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
