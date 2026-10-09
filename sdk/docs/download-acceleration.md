# Native mirror download acceleration

Pass `downloadMirrors: ['https://gh-proxy.com/']` to `createClient`. This prepends the proxy prefix to native file URLs, verifies each response against the manifest SHA-256, and falls back through the configured prefixes to the original URL on errors or mismatched contents. Catalog and manifest addresses remain unchanged. No accelerator is enabled by default.

Validation on 2026-10-09, macOS arm64:

- A 1 MiB range through gh-proxy.com matched the direct GitHub response byte for byte: 5.22 seconds versus the earlier direct request's 6.31 seconds. These are individual samples, not a controlled speed benchmark.
- The entire original wrapper.node (190,260,656 bytes) downloaded through gh-proxy.com in 153.46 seconds, averaging 1,239,836 bytes/second. Its SHA-256 matched the published manifest: `2e6f79b241c33e88f51cb947d9da6e10e31fc2038304eadf0f652a05642aab1a`.
- An installed npm tarball imported by package name selected the default catalog with this accelerator configured, completed preparation, exposed 104 native exports, and closed normally. Preparation took 11.11 seconds with completed content reused from cache, including the separately verified wrapper. This is not a cold full-bundle download time.
- No account login was attempted. These checks establish download integrity and native initialization, not login or business API acceptance for a new package.
- 124 regression tests passed, including accelerator success, HTTP failure, digest mismatch and origin fallback.

Private local receipts: `.local/research/proxy-wrapper-download.json`, `.local/research/proxy-preparation.json`, and `.local/research/accelerator-tests.log`.

A separate cold-cache installed consumer completed on 2026-10-09: brand-new cache, default catalog, gh-proxy.com configured, full original native bundle, preparation with 104 exports and normal close. Total elapsed time was 304,453 ms. No login occurred. The receipt is `.local/research/proxy-cold-preparation.json`. This establishes the full public default download path with acceleration enabled; it does not imply every file used the proxy because the installer can fall back to origin.
