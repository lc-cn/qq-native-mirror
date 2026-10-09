# QQ native mirror

Default catalog: `catalog.json`. The default index keeps all five original full bundles for macOS arm64 and Linux arm64/x64 across `native-v1` and `native-v1-extra`, and adds the verified compressed macOS x64 and Windows x64/arm64 entries. It covers all six device combinations; no original full entry or asset is replaced. Each entry binds immutable manifest content by SHA-256, platform, architecture and clientVersion/appId/qua. The full dependency closure is required; wrapper.node alone is insufficient.

The separate `macos-arm64-thin-v1` prerelease preserves all resource paths and retains original arm64 binary slices. QR login, Session readiness and read-only friend/group queries passed. No comprehensive media or signing-safety claim is made.

Compressed candidates are published in `catalog-gzip-v1.json` and the `gzip-v1` prerelease. The original 324 release assets and 44 added assets were verified by size and GitHub-provided SHA-256. Their manifests require SDK gzip support (`encoding` and `downloadSha256`). Both compressed payload and restored runtime byte hashes are required. macOS arm64 transfer size is 48.2 MB; Linux 3.2.32-52194 x64 is 62.1 MB and arm64 is 64.0 MB. Installed ordinary Node consumers passed complete local mirror download/restoration, native preparation and close on all three platforms. The opt-in catalog now also includes macOS x64 and Windows x64/arm64, extracted from the byte-verified six-platform npm CI candidate. All six compressed public mirror paths passed cold preparation, independent file hashes and zero payload downloads on second preparation in [run 37889421789](https://github.com/lc-cn/qq-native-mirror/actions/runs/37889421789), with no account login. The opt-in gzip catalog retains compressed entries for all six devices. Default selection for the original three devices keeps the full bundles.

Catalog trust is repository/HTTPS trust, not proof of vendor signing authenticity. Account data, credentials and QR images are never included in this repository.

## npm platform package CI

`native-npm.yml` uses six native GitHub runners: Windows/Linux/macOS × x64/arm64. The SDK snapshot is in `sdk/`; `ci/sources.json` pins source manifests by SHA-256. Jobs download verified vendor native binaries, extract macOS architecture slices, compile the registration bridge, build platform tarballs, then install and initialize a fresh ordinary-Node consumer without login. Tencent's closed-source kernels are extracted/packaged, not recompiled from source.

Missing sources fail explicitly and do not produce empty platform packages. The publish job requires all six jobs to pass and aggregates all six built bridges into the main SDK. Publishing is manual (`publish: true`) and requires npm Trusted Publisher configuration for this repository and `native-npm.yml`; build-only jobs do not need npm credentials.

CI run [37880903538](https://github.com/lc-cn/qq-native-mirror/actions/runs/37880903538) passed installed-consumer preparation and close on all six native runners. Windows requires official Node 24.20.0 and validates its runtime configuration; its adapter reads the genuine environment stopping flag. This is native initialization evidence, with no account login or signing-authenticity claim.

Before the main npm first publication, ordinary Windows users were found to be affected by symlink-based account/cache locks. `native-first-main.yml` reuses the six original auxiliary tarballs byte for byte, compiles the corrected main, and runs installed-package and native-cache consumers on all six platforms with symlink creation denied. It archives 25 bound evidence files and never publishes npm. Existing published auxiliary versions must not be rebuilt or replaced.

`npm-public-consumer.yml` separately verifies all seven official npm package integrities and fresh main-only installation on six platforms after local first publication. Trusted publishing remains a separate maintainer configuration step.
