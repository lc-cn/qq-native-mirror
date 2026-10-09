# QQ native mirror

Default catalog: `catalog.json`. Five original full bundles are published for macOS arm64 and Linux arm64/x64 across `native-v1` and `native-v1-extra`. Each entry binds immutable manifest content by SHA-256, platform, architecture and clientVersion/appId/qua. The full dependency closure is required; wrapper.node alone is insufficient. Windows is not published.

The separate `macos-arm64-thin-v1` prerelease preserves all resource paths and retains original arm64 binary slices. QR login, Session readiness and read-only friend/group queries passed. No comprehensive media or signing-safety claim is made.

Compressed candidates are published in `catalog-gzip-v1.json` and the `gzip-v1` prerelease. All 324 release assets were verified by size and GitHub-provided SHA-256. Their manifests require SDK gzip support (`encoding` and `downloadSha256`). Both compressed payload and restored runtime byte hashes are required. macOS arm64 transfer size is 48.2 MB; Linux 3.2.32-52194 x64 is 62.1 MB and arm64 is 64.0 MB. Installed ordinary Node consumers passed complete local mirror download/restoration, native preparation and close on all three platforms. The opt-in catalog does not replace the default full catalog.

Catalog trust is repository/HTTPS trust, not proof of vendor signing authenticity. Account data, credentials and QR images are never included in this repository.
