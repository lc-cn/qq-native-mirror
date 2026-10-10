/** Ports supplied by bundled codecs, consumer modules or command-line tools.
 * Contract ownership is independent of module loading and media preparation.
 */
export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
}

/** Exact pinned NapCat codec contract; no FFmpeg CLI SILK encoder is assumed.
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/helper/ffmpeg/ffmpeg-addon.ts
 */
export interface RecordCodec {
  getDuration(filePath: string): Promise<number>;
  convertToNTSilkTct?(inputPath: string, outputPath: string): Promise<void>;
}

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
