# Source-built standalone video codec

The SDK's video codec interface now has an owned, thin standard Node-API implementation in `native/video/video-codec.cc`. It reads the first actual video frame through FFmpeg, reports original dimensions and measured duration, and creates a top-down padded BGR24 BMP cover with a maximum edge of 640 pixels. The interface is `getVideoInfo(filePath)` returning `{width,height,duration,format:'bmp24',image:Buffer}`. There is no QQ wrapper, Electron, UI, downloaded codec binary, external CLI or network transfer in this implementation.

FFmpeg source is pinned to official release 9.0.2, commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`, archive SHA-256 `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`. The producer verifies the official release signature against fingerprint `FCF986EA15E6E293A5644F10B4322F04D67658D8` before the six builds use the same archive. Node headers and the Windows import library are verified against the chosen official Node version's SHA-256 records.

Each target builds its own static FFmpeg libraries and addon. Configuration disables CLI programs, network protocols, external library autodetection, hardware acceleration, assembly, GPL/nonfree/version3 components, encoders, muxers, devices and filters. It keeps the MOV/MP4 demuxer, local file protocol, internal permitted decoders and swscale. It does not establish every decoder/container variant: unsupported inputs fail rather than return made-up metadata. The native interrupt deadline is checked between work and I/O; it cannot preempt CPU work inside a decoder. The SDK's timeout/close behavior still applies.

The glue is MIT. The linked FFmpeg components are LGPL-2.1-or-later; their exact license and third-party notices accompany runtime candidates, including the Independent JPEG Group acknowledgement for applicable internal decoder sources. Relink materials include addon object/source, exact static libraries, build configuration, Node headers/import library and scripts. A fresh relink is executed and its resulting addon must pass the same media consumer checks. Permanent runtime distribution must provide corresponding source and relink materials at the same download location; temporary CI artifacts are candidate evidence, not the final distribution plan.

The manual `video-codec-native.yml` workflow covers native Linux, macOS and Windows x64/arm64 runners with Node 24.20.0. It has no publication step and does not initialize a QQ account. It checks real decoded pixels, dimensions, measured duration, downsampling, concurrent calls, Unicode filenames, invalid/missing/network inputs, source preservation and the compiled SDK's fake cache contract. Synthetic fixtures include 64×64 blue, 1280×720 blue and 65×33 top-blue/bottom-red clips; the odd-width clip checks BMP padding and vertical orientation. Inputs and produced binaries are bound by SHA-256 receipts.

Local macOS arm64 / Node 24.19.0 built the owned addon from the pinned archive and passed all three fixtures, including a separate fresh relink. The runtime addon was 13,254,096 bytes (approximately 6.6 MB gzip in this local measurement). It depends on system macOS libraries/frameworks, not QQ or external FFmpeg libraries. These results do not prove QQ video upload/peer receipt, account signing authenticity, all native codecs or the remaining platforms.

Source `d43a20a76aface337240bd71db403cea496f4f17` now attaches the source-built runtime to codec-bearing auxiliary candidates and sets `manifest.videoCodec`. The installer returns the verified absolute codec path from installed packages, trusted mirrors/caches and complete adjacent local manifests. Explicit `videoCodecPath` takes precedence and remains selected on reconnect. Without that override, explicitly configured `mediaTools` retain their executable route ahead of a bundled default. The current public npm 0.0.1 still has no codec; no new npm release has occurred. Existing explicit `mediaTools`, supplied codecs and old manifests continue to work. Six-platform installed-candidate CI is a separate gate from the earlier standalone producer CI below.

## Six-platform source-build evidence

[CI 37953717980](https://github.com/lc-cn/qq-native-mirror/actions/runs/37953717980), source `055c113eb347405e3782f35214091000fd7426f9`, completed successfully on all six native runners with Node 24.20.0. Each ran all three synthetic clips against both the original addon and a fresh relink: twelve real native consumer receipts. Source-signature verification, decoded pixels, metadata, orientation, padding, SDK cache preparation and dependency inventories passed. The downloaded artifacts' binary hashes match the full CI log receipts; addon source, pinned FFmpeg archive, Node headers/import library, generated configuration, component notices and original/relinked outputs were independently checked. Windows checkout uses CRLF; its exact compiled-source hash is retained separately and its normalized bytes match repository source.

| Target | Addon bytes | Runtime dependencies observed |
| --- | ---: | --- |
| Linux x64 | 17,704,104 | glibc, libm, libstdc++, libgcc and loader |
| Linux arm64 | 15,499,928 | glibc, libm, libstdc++, libgcc and loader |
| macOS x64 | 14,826,672 | libSystem, libc++, CoreFoundation/CoreVideo/CoreMedia |
| macOS arm64 | 13,167,872 | libSystem, libc++, CoreFoundation/CoreVideo/CoreMedia |
| Windows x64 | 12,058,112 | node.exe, bcrypt.dll, KERNEL32.dll |
| Windows arm64 | 11,209,728 | node.exe, bcrypt.dll, KERNEL32.dll |

Linux runners were Ubuntu 24.04, macOS runners were macOS 15, and Windows runners were Windows Server 2022 x64 / Windows 11 arm64. This establishes those actual environments, not every OS distribution/minimum version. Neither QQ nor external FFmpeg shared libraries appear in the inventories. The public [bound evidence summary](evidence/video-source-ci-37953717980.json) retains binary/source hashes and decoded-output hashes; private detailed receipts are `video-source-ci-third-verified.json`, `video-source-ci-third-independent-verified.json` and `video-source-ci-third-artifacts-verified.json` under `.local/research`.

The earlier runs are preserved as failed overall runs: the first failed Windows source extraction with a drive-letter tar path; the second passed all twelve decoding receipts but failed Windows dependency inspection. Relative archive names and a PowerShell dependency step fixed those issues. The successful third run includes the complete gates. There was no account restore/login, QQ video send, npm publication or automatic codec selection in any of these producer runs. Permanent distribution and default auxiliary-package integration remain pending.

## Build and verify from this source tree

Producer machines need a native C++ toolchain and make; Windows uses MSYS2 make with the selected MSVC environment. GPG is needed for release-signature verification. These are build dependencies, not installed-client runtime dependencies.

```sh
node scripts/prepare-video-source.mjs out/video --verify-signature
node scripts/build-video-native.mjs out/video
npm exec tsc
node scripts/verify-video-native.mjs out/video/runtime/video-codec.node test/video-fixtures out/video/runtime/consumer.json
node scripts/relink-video-native.mjs out/video/relink out/video/relink out/video/relinked/video-codec.node
node scripts/verify-video-native.mjs out/video/relinked/video-codec.node test/video-fixtures out/video/relink/consumer.json
```

`out/video/runtime/video-codec.node` can be passed as an absolute `videoCodecPath` to `createClient`. The codec measures a local MP4 and makes its cover; it does not transcode video or establish whether QQ accepts an upload. The relink helper accepts another compatible FFmpeg library directory, without a proprietary signing key. Matching decoded output after a fresh link is functional relink evidence; it is not a claim of byte-identical compiler output or a verified modified-library rebuild.
