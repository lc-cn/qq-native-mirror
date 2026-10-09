# Local video preparation

`createClient({ dataDir, videoCodecPath: '/absolute/video-codec.node' })` loads an explicitly supplied codec in the ordinary Node worker. JS named exports and a default object are supported; standard `.node` addons use Node's CommonJS loader. This option also works in the CLI JSON configuration. The module is executable consumer-supplied code and must match the running OS, architecture and Node ABI. The SDK does not fetch it or install external tools.

The codec interface is:

```ts
interface VideoCodec {
  getVideoInfo(filePath: string): Promise<{
    width: number;
    height: number;
    duration: number; // seconds
    format: 'jpg' | 'jpeg' | 'png' | 'bmp' | 'bmp24'; // thumbnail format
    image: Buffer;
  }>;
}
```

Outgoing video input remains an absolute, nonempty local `.mp4` path. The codec route checks the initial `ftyp` box before decoding. Dimensions must be positive safe integers and duration a positive finite number. Thumbnail data must be a nonempty Buffer of at most 32 MiB; its declared format, image header and positive encoded dimensions are checked. This is header validation, not a second image decode. The bytes are copied before awaiting native staging.

A codec may downsample its cover. The encoded thumbnail dimensions need not equal the video's measured dimensions. The fixed upstream legacy native converter populates the confusingly named `thumbWidth` and `thumbHeight` with the original video dimensions; this SDK preserves that contract without inventing fields. JPEG, PNG and BMP use matching cache filename extensions, and thumbnail MD5/size come from the actual copied bytes. The original video is preserved.

An explicit codec takes precedence over `mediaTools`. Codec exceptions, invalid metadata and missing modules fail without an executable fallback or fabricated cover. Without `videoCodecPath`, explicitly configured absolute `ffmpeg` and `ffprobe` paths remain supported. Decoder and native staging waits have a 30-second deadline; Session close stops waiting and prevents subsequent staging/send. Already dispatched native decoder work cannot be cancelled; its late result is ignored. Local file operations already in progress may finish during cancellation.

## Evidence and remaining work

The independent [FFmpeg Node addon](https://github.com/NapNeko/ffmpegAddon/tree/0894e271dc587b6306ae13b67e2f238cdb3666bd) exposes `getVideoInfo`. Its source separates original video dimensions from a potentially downsampled JPEG cover. The [fixed NapCat converter](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-onebot/api/file.ts#L159-L185) supplies the legacy native video element contract.

A pinned Darwin arm64 addon from NapCat's separate FFmpeg assets was verified against its Git blob. The original lacked a macOS code signature; a research copy with a local ad-hoc signature loaded in ordinary Node 24.19.0 and measured the fixed 64×64 H264 synthetic clip as 0.4 seconds, yielding a 678-byte JPEG. Original and derived hashes are recorded separately in private evidence. No QQ wrapper, account or network send was used for this probe.

This demonstrates offline processing on macOS arm64. It does not prove the selected upstream source built that binary, authentic QQ signing, video upload/peer receipt with this revision, or native video codec support on all six targets. The addon is not bundled in the six QQ native auxiliary packages. Default codec distribution requires reproducible platform builds and dependency/license verification; the initial six-platform SDK checks use synthetic JS codecs. A separate owned source-built codec producer is now available; see [native source build](video-native-source.md) for its independent platform evidence and distribution gates.
