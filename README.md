# QQ native mirror

Default catalog: `catalog.json`. Five original full bundles are published for macOS arm64 and Linux arm64/x64 across `native-v1` and `native-v1-extra`. Each entry binds immutable manifest content by SHA-256, platform, architecture and clientVersion/appId/qua. The full dependency closure is required; wrapper.node alone is insufficient. Windows is not published.

The separate `macos-arm64-thin-v1` prerelease preserves all resource paths and retains original arm64 binary slices. QR login, Session readiness and read-only friend/group queries passed. No comprehensive media or signing-safety claim is made.

Compressed candidates are published in `catalog-gzip-v1.json` and the `gzip-v1` prerelease. All 324 release assets were verified by size and GitHub-provided SHA-256. Their manifests require SDK gzip support (`encoding` and `downloadSha256`). Both compressed payload and restored runtime byte hashes are required. macOS arm64 transfer size is 48.2 MB; Linux 3.2.32-52194 x64 is 62.1 MB and arm64 is 64.0 MB. Installed ordinary Node consumers passed complete local mirror download/restoration, native preparation and close on all three platforms. The opt-in catalog does not replace the default full catalog.

Catalog trust is repository/HTTPS trust, not proof of vendor signing authenticity. Account data, credentials and QR images are never included in this repository.

## npm platform package CI

`native-npm.yml` uses six native GitHub runners: Windows/Linux/macOS × x64/arm64. The SDK snapshot is in `sdk/`; `ci/sources.json` pins source manifests by SHA-256. Jobs download verified vendor native binaries, extract macOS architecture slices, compile the registration bridge, build platform tarballs, then install and initialize a fresh ordinary-Node consumer without login. Tencent's closed-source kernels are extracted/packaged, not recompiled from source.

Missing sources fail explicitly and do not produce empty platform packages. The publish job requires all six jobs to pass and aggregates all six built bridges into the main SDK. Publishing is manual (`publish: true`) and requires npm Trusted Publisher configuration for this repository and `native-npm.yml`; build-only jobs do not need npm credentials. Windows source and loader validation are still being completed.

Measured CI run 37874921576 passed native installed-consumer preparation and close on Linux x64/arm64 and macOS x64/arm64. Windows source validation now uses hash-pinned official 9.9.33 installers. `windows-native.yml` separately tests a Node24.20 internal-ABI stopping-state adapter on native Windows x64 and ARM64. Its result is still pending. This adapter reads the genuine environment stop flag and must be pinned to the exact Node version and build configuration before runtime distribution.
