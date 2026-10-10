/** Native cache allocation shared by image, record and video preparation.
 * Allocation does not send a message. Each caller validates the unknown path
 * and owns its file/codec lifetime; this port cannot acquire a Session.
 */
export interface MediaStagingPort {
  getRichMediaFilePathForGuild?: (request: {
    md5HexStr: string;
    fileName: string;
    elementType: number;
    elementSubType: number;
    thumbSize: number;
    needCreate: boolean;
    downloadType: number;
    file_uuid: string;
  }) => unknown;
}

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
