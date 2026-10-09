# Native bundle reduction evidence

The current six-platform default catalog retains the full registered runtime inventory plus the owned codec; original complete bundles and the SHA-named previous catalog remain available for explicit fallback. The macOS arm64 candidate retains all 1156 manifest paths. It deduplicates identical file contents and retains the vendor's original arm64 slice from universal Mach-O binaries. No native instructions are patched or signatures reauthored.

| Package | Unique contents | Unique content bytes | Runtime paths |
| --- | ---: | ---: | ---: |
| Original macOS bundle | 309 | 245,273,162 | 1156 |
| arm64 slice candidate | 309 | 115,511,882 | 1156 |

Thinning eleven unique native binaries saves 129,761,280 bytes, approximately 53% of unique content. The original export also materialized duplicate framework aliases, adding 25,083,687 bytes to its logical file total. The installer now downloads identical SHA-256 contents once and hardlinks the remaining paths, reducing macOS payload requests from 1156 to 309 without deleting any runtime paths.

On 2026-10-09 the candidate passed verification through an installed npm tarball under ordinary Node 24.19.0 on macOS arm64: every manifest path and SHA-256 matched, createClient prepared successfully, 104 native exports loaded, and close completed. The verifier used a fresh temporary account directory and never called login or restore. This proves integrity and initialization; QR login and read-only friend/group operations have since passed as described below; media operations remain unverified for the thinned candidate. The full-path thinned candidate is published as a separate GitHub prerelease, and is not default-selected.

Reproduce after building or installing the SDK:

```sh
node scripts/verify-native-bundle.ts /absolute/bundle /absolute/receipt.json
# To exercise a particular installed npm package:
node scripts/verify-native-bundle.ts /absolute/bundle /absolute/receipt.json /absolute/node_modules/qq-native-client/dist/index.js
```

Generate separate candidates with `scripts/deduplicate-native-bundle.py` and `scripts/thin-macos-native.py`. Keep the original bundle for fallback. Do not infer resource files are removable from successful initialization; reducing file count requires operation-specific evidence.

The SDK's accelerated default catalog path has also prepared successfully through an installed npm consumer with completed content cached, including a full wrapper separately downloaded through gh-proxy.com and hash-verified. Cold direct GitHub download verification terminated with TimeoutError after the ten-minute deadline. A fresh empty-cache accelerated verification passed in 304 seconds, including actual initialization and close. See [download acceleration evidence](download-acceleration.md).

A restrictive macOS sandbox can crash both original and candidate wrappers: vendor initialization calls DASessionCreate and then releases its result without checking for null. Matched unrestricted execution passes both bundles. The reproduced crash is CFRelease(NULL), not evidence that thinning caused failure or that a vendor signing check rejected the bundle. No hardware values or signature results are fabricated.

Local receipts: `.local/research/macos-thin-installed-verification.json`, `macos-thin-all-size.json`, `macos-baseline-unsandboxed.json`, `macos-dedup-unsandboxed.json`, and `macos-trap-diagnosis.json`.

## Authorized QR and read-only acceptance

On 2026-10-09 an installed npm consumer ran one explicitly authorized QR login using the 115,511,882-byte unique-content candidate, a new private account directory, ordinary Node 24.19.0 and macOS arm64. The user confirmed phone login success. The SDK independently observed authenticated and Session ready, returned 3 friends and 13 groups, then closed normally with no error. No messages, account mutations, restoration or automatic retry were performed. Receipt: `.local/thin-qr-readonly-v1/receipt.json`. This extends candidate evidence to QR authentication and these read-only operations, without proving media behavior or vendor signing authenticity.

## Byte-preserving gzip transport

A separate gzip transport candidate reduces unique download content from 115,511,882 to 48,186,949 bytes (58.3% less than the thinned package, 80.4% less than the original unique content). All 1156 runtime paths and their original SHA-256 values remain unchanged. This changes transport storage and transfer size, not native instructions or runtime file contents. Runtime disk requirements are still those of the uncompressed package.

Schema-1 file entries optionally accept `encoding: "gzip"` and a mandatory `downloadSha256`. The installer verifies compressed bytes first, decompresses with a bounded 512 MiB output limit, then verifies the existing `sha256` before caching or publication. Uncompressed manifests remain compatible. The server must serve stored gzip bytes without an HTTP Content-Encoding transformation, so the downloaded compressed checksum remains meaningful.

Generate a separate compressed mirror directory with `node scripts/compress-native-bundle.ts SOURCE_BUNDLE NEW_MIRROR_DIR`. Run `node scripts/verify-mirror-delivery.ts MIRROR_DIR --prepare` to download, restore, validate and initialize without login. Default delivery verification does not load native code. Local complete delivery passed 310 requests (manifest plus 309 contents); repeat installation required only one manifest request. Native preparation evidence is recorded separately. All 127 regressions pass, including transport hash mismatch, restored-byte mismatch and decoded-content cache reuse.

This compressed candidate is not published or default-selected. It preserves the runtime bytes of the separately QR-verified thinned candidate; no new account login is inferred from the transport test. Removing framework resource files still requires independent operation evidence.

## Framework resource removal candidate

`scripts/prune-macos-resources.py` creates a separate candidate that omits framework `Resources` entries except Info.plist. Source files and default catalog remain untouched. Binary dependencies, framework aliases, metadata and code-signature records are retained. This is an experimentally validated subset, not a general claim that all UI resources are unnecessary.

The resulting package contains 46 paths and 21 unique contents, compared with 1156 paths and 309 contents before pruning. Unique runtime bytes are 115,037,000; gzip transfer bytes are 47,811,872. Most savings concern paths and requests rather than byte size.

On 2026-10-09 it passed full integrity checks and preparation with 104 native exports through an installed npm consumer. A subsequent separately authorized QR attempt used a fresh private account directory: the user confirmed phone success; SDK authenticated, reached Session ready, returned 3 friends and 13 groups, and closed normally without errors. No messages, mutations, restore or retry were performed. Candidate media functionality and signing authenticity remain unproven. Receipts: `.local/research/macos-pruned-prepare.json`, `.local/pruned-qr-readonly-v1/receipt.json`.

The resource-pruned candidate is local-only. The earlier full-path thinned candidate is available at https://github.com/lc-cn/qq-native-mirror/releases/tag/macos-arm64-thin-v1 with 310 assets (309 contents plus manifest). Asset names, sizes and all 310 GitHub-provided SHA-256 digests matched local files. Full original bundles remain selected by the default catalog.

## Linux gzip preparation

Both 3.2.32-52194 Linux bundles were generated as separate byte-preserving gzip mirror candidates on 2026-10-09. x64: 7 paths/7 contents, 172,094,832 runtime bytes to 62,122,352 transfer bytes. arm64: 8 paths/8 contents, 181,287,704 runtime bytes to 63,996,855 transfer bytes. Source file hashes were checked during generation. These candidates are local-only; actual Linux compressed-mirror consumer delivery and runtime acceptance remain outstanding. This does not introduce a new account login.

The separately approved resource-pruned media batch restored the prior account, completed send/recall native callbacks for image, voice and video, and completed a text-attachment send. Attachment recall timed out; its outcome is unknown and no retry occurred. The client closed normally. The user confirmed two recall notices and that file.txt remained visible; individual image/voice/video arrival is not established. This extends operation evidence but leaves file recall and comprehensive media acceptance incomplete.

Peer confirmation therefore establishes an actual attachment recall failure for this batch, rather than merely an absent completion callback. The difference between three native recall completions and two observed notices remains unresolved; no automatic account action is taken to investigate it.

Linux x64 compressed-mirror delivery has now passed in an isolated ordinary Node 24.20.0 installed npm consumer: all 7 gzip contents downloaded and restored, 98 native exports, environment preparation and closed state, with one-second built-in audio codec conversion. No account directory was mounted or login attempted. Receipt: `.local/research/linux-x64-gzip-consumer.log`. Linux arm64 also passed installed npm compressed-mirror download/restoration, 98 exports, preparation, one-second audio codec and normal close with no account mounted or login. Receipt: `.local/research/linux-arm64-gzip-consumer.json`.

A later separately approved single-file diagnostic on the pruned candidate produced native recall result -7003 after a successful send, with normal close and no retry. This proves native rejection in that attempt; it does not prove the rejection was caused by resource pruning or signing behavior.

## Published gzip mirror candidates

The optional gzip catalog is published at https://raw.githubusercontent.com/lc-cn/qq-native-mirror/main/catalog-gzip-v1.json and references the `gzip-v1` prerelease. All 324 asset names, sizes and GitHub SHA-256 digests matched local compressed bytes (174,306,156 total transfer bytes). Metadata commit: b589c72. The three entries cover macOS arm64 with full resource paths, Linux x64 and Linux arm64. The public gzip catalog cold-cache installed npm consumer passed on macOS arm64 in 130,062 ms: complete download/restoration, 104 exports, preparation and normal close without login. Receipt: `.local/research/gzip-public-consumer.json`. Public Linux download remains unverified; Linux local-mirror consumers passed.

Use `catalogUrl` to opt in, together with optional `downloadMirrors: ['https://gh-proxy.com/']`. Requires the current SDK's gzip manifest support. The default catalog and full original release assets remain unchanged. The 46-path resource-pruned candidate remains local and is not selected by this published catalog.

## Six-platform npm distribution target

The required matrix is Windows (`win32`), Linux (`linux`), and macOS (`darwin`), each on `x64` and `arm64`: six auxiliary packages plus the main SDK. The previously generated three auxiliary packages cover only available native materials, not the complete support target. On 2026-10-09 the original universal macOS closure was independently extracted into an x64 candidate, retaining all 1156 paths; its Mach-O slices are statically verified as x86_64, without account or runtime claims.

GitHub Actions workflow `native-npm.yml` in `lc-cn/qq-native-mirror` uses actual six-architecture hosted runners. It downloads hash-pinned kernels, builds registration adapters, packages the artifacts, then installs and initializes ordinary Node consumers. QQ kernels themselves are closed-source vendor binaries and are not recompiled. Missing sources fail explicitly; no empty placeholder packages are published. Publishing requires all six consumers to pass and npm Trusted Publisher configuration. Initial deployed run: https://github.com/lc-cn/qq-native-mirror/actions/runs/37874741923 . Runtime results remain pending until the run completes.

Run 37874921576 completed with actual installed consumer initialization/close passes on Linux x64, Linux arm64, macOS arm64 **and macOS x64**. Each job built its adapter and platform npm tarball on the corresponding architecture runner. Windows jobs failed at the missing-source gate in that revision; the publish job was skipped. The subsequent Windows-specific run 37875373609 extracts the official x64/arm64 installer sources and attempts a bridge that reads Node's real stopping state. Its runtime outcome is pending; no Windows support claim follows from the four passed jobs.

## Private 47-path npm candidate (2026-10-09)

A separate macOS arm64 auxiliary was constructed from the original `0.0.2` CI package (successful source `b4b2e4eab5e44f99126e2efc68d6701ac7658833`, run `37925080425`). The earlier local pruning manifest's 46 vendor paths exactly match this actual npm package by path, SHA-256 and size. The existing CI-built registration bridge is the 47th runtime path, at 50,888 bytes with SHA-256 `f2d1ce7d463431d659525f3b3b1781f38da42f931f66183e9c6edb99e250673d`. No native bytes were modified. Framework aliases remain explicit regular-file paths. This equivalence is limited to these two specified macOS arm64 sources; other devices and versions require separate verification.

The private auxiliary has 47 native paths and 50 packaged files, including its manifest, package metadata and README. Its tarball SHA-256 is `c75606b297f18bb558196e81a7592d5eaf4e866034aea22ebe6afb307afcfd0c`. Compressed size is 52,656,013 bytes versus 53,236,249 bytes for the original full auxiliary: 580,236 bytes saved. Path count falls from 1157 to 47, but this does not imply a comparable byte reduction. Earlier standalone gzip transfer sizes describe a different archive layout and must not be compared as equivalent npm tarballs.

A fresh offline consumer installed the original main `0.0.2` tarball, this private auxiliary and the local codec dependency. One ordinary Node `v24.19.0` preparation used the public `createClient` export with default device selection and a new empty account directory, without wrapper/bridge/version overrides. It exposed 104 exports, entered `idle` with no account and closed normally. No login, restore, QR, query or send method was called. The parent JavaScript `fetch` override prevented that process's fetch-based mirror fallback; it is not evidence of a global native/child-process network prohibition.

Independent inspection subsequently verified all 88 installed main-package files against the original main tarball, all 50 installed auxiliary files against the private tarball, and all 47 native files against the original full CI tarball. The raw probe log matches its receipt. This inspection did not repeat native initialization. Private evidence: `.local/research/pruned-002-static-audit.json`, `pruned-002-prepare-verified.json`, `verify-pruned-002-prepare.py` and `.local/acceptance/sdk-002-pruned-prepare-v1/prepare-receipt.json`.

The candidate is unpublished and has not replaced the default full auxiliary or catalog. Preparation is established for this installed candidate; new account/business/media acceptance and signing authenticity are not. The separately prepared broader `0.0.2` account batch still uses the original full CI auxiliary and remains unexecuted pending its own authorization.

## Reproducible resource-pruned CI candidate (2026-10-09)

The mirror now contains `tools/profiles/darwin-arm64-resources-v1.json`, `tools/prune-native-npm.mjs` and the manual-only `pruned-native-candidate.yml` workflow. The profile pins the exact original successful six-platform source run, commit, attempt, release manifest, two source tarballs and all 47 retained file hashes/sizes. Another vendor version/device is rejected rather than receiving this pruning policy automatically. The helper verifies source archives before extraction, writes only a fresh candidate directory, preserves the original main tarball, records Node/npm versions and refuses changed bytes or stale build-run receipts. Seven focused contracts plus the two existing source-archive helper contracts pass locally. The workflow has read permissions and uploads experimental artifacts; it has no npm/GitHub release publication step or account operation.

[CI 37931128712](https://github.com/lc-cn/qq-native-mirror/actions/runs/37931128712), builder commit `41106ca052a13d40eeaf195814caf8f2400dc02a`, passed on the actual macOS arm64 hosted runner. It used the original `0.0.2` runtime source from `b4b2e4eab5e44f99126e2efc68d6701ac7658833` / `37925080425`, rather than rebuilding the main SDK from the later tooling commit. The installed consumer requested only the main SDK from an isolated local registry, automatically installed the matching experimental auxiliary and codec, initialized with 104 exports and closed normally. Compiled query/CLI fixture contracts also passed; they do not constitute real account business reads. `loginAttempted:false` and all native friend/group/member/history-query attempt flags remain false.

The resulting tarball is 52,655,978 bytes, SHA-256 `ed5c9dade1c2ce0acfbc5c8f9e1d0aac04692de06264c2dea98ced53e5a19401`. Two independent local packs (Node 24.19.0/npm 11.17.0) and the actual CI pack (Node 24.20.0/npm 11.19.0) are byte-identical. This establishes reproducibility across those observed inputs/environments, without promising every future npm release will produce identical archives. This tracked profile changes candidate metadata compared with the earlier private prepare candidate, explaining its different tarball hash; all retained vendor/bridge bytes remain identical.

The actual CI artifact was downloaded and inspected independently: exactly 50 auxiliary files, all 47 native paths/hashes/sizes, unchanged original main bytes, source manifest/profile identity, builder/source provenance, and raw build/consumer receipt hashes bound by `pruning-acceptance.json`. All logged receipt objects match downloaded files. No native initialization or account operation was repeated during this inspection. Evidence: `.local/research/pruned-ci-profile-local-verified.json`, `pruned-ci-profile-verified.json`, `verify-pruned-ci-profile.py`, `pruned-ci-profile-full.log` and `.local/releases/pruned-native-ci-37931128712/`.

This closes the experimental CI packaging/initialization gate for this macOS arm64 profile. The full default package remains selected; login, business/media acceptance for this generated candidate, other-platform pruning and signing authenticity remain outstanding. The pending full-package `0.0.2` read batch has not been executed or replaced.

## Full codec default and a new 58-path experimental profile (2026-10-10)

The full codec-bearing default mirror passed all six actual cold consumers in [CI 37969129032](https://github.com/lc-cn/qq-native-mirror/actions/runs/37969129032). Both macOS inventories currently contain 1,168 paths; the resource-pruned profiles are experimental and do not replace them. Original complete manifests/assets and the exact prior eight-entry catalog are preserved. See [bound default evidence](evidence/codec-default-ci-37969129032.json).

A new macOS arm64 profile is bound to source `6cae1ec0a5e1bfb03cb7871083915b3d03272347` / successful run `37962268125`. Every one of the old 47 retained vendor/bridge paths matches this source by SHA256 and actual size. Keeping those exact files plus all eleven `video/` files yields 58 native paths and 61 npm package files. Only the old profile's 1,110 resource paths are omitted; no new vendor/security file is selected for removal, and no binary bytes or signatures are rewritten. Source/relink/provenance/license closure is retained and verified before packing.

The separate local candidate was actually packed and independently re-read: all 58 original file bytes and the original main tarball match their approved hashes, with eleven video files retained. Tarball size is 59,326,804 bytes versus 59,911,840 for the full source, saving 585,036 bytes; file-count reduction is substantial but byte saving is small. SHA256 is `3128a4741044520f7c99a89673db0d04f3183312d7ff0191d580ddb2ca816da8`. The new helper has two refusal/receipt contracts and the manual-only `pruned-codec-native-candidate.yml` requires actual installed main-only preparation/close and three native codec decodes on the original runtime source. [CI 37971314866](https://github.com/lc-cn/qq-native-mirror/actions/runs/37971314866), builder `47667990e7c237f7d628338f96c1f531fc47df64`, passed the actual macOS arm64 installed consumer on Node 24.20.0: main-only installation, automatic codec selection and three real clip decodes, 104 QQ native exports, preparation and close. Independent downloaded-artifact and full-log verification confirmed all 58 retained original file bytes, the unchanged original main tarball and matching consumer receipts. The CI auxiliary tarball was byte-identical to the separately packed local candidate in this specific comparison; this does not establish universal build reproducibility. See [bound evidence](evidence/pruned-codec-ci-37971314866.json). No account operation, publication or default replacement for this new candidate has occurred. Prior 47-path account evidence is not treated as evidence for this new packaged candidate or signing authenticity.

## Experimental macOS x64 codec resource pruning (2026-10-10)

A separate x64 profile uses the same reviewed 47 vendor/bridge path names as removal policy plus the complete eleven video files. Every retained byte is taken and hash/size-checked from the actual x64 auxiliary bound to source `6cae1ec0a5e1bfb03cb7871083915b3d03272347` / run `37962268125`; 27 retained path contents differ from arm64. Shared path names do not transfer arm64 loading, account or signing evidence. Complete original source/relink/provenance/license references remain present.

Actual local npm packing produced 61 package files and 58 native paths at 65,268,780 bytes, versus 65,852,287 for the original x64 auxiliary: 583,507 bytes saved. Candidate SHA256 is `27a1b4ba476d353d538d01d3e6c5b934c91621c9bbffe75f23445a8a01ce742f`. Independent tar readback confirmed all 58 original x64 byte sequences and the unchanged original main tarball. This supersedes the earlier generic gzip-size estimate; file-count reduction is large and compressed-byte saving is small.

The tool supports only the two fixed macOS codec profiles. A separate rebuild of its default arm64 path produced exactly the previously accepted tarball SHA256 `3128a4741044520f7c99a89673db0d04f3183312d7ff0191d580ddb2ca816da8`. Four refusal/receipt contracts pass, including rejection of arm64 consumer receipts for x64. The independent manual-only `pruned-codec-native-candidate-x64.yml` uses a real Intel macOS runner, Node 24.20.0 and the original fixed runtime verifier; runtime decoding, initialization/close and account acceptance for this x64 candidate remain separate gates. No publication or default catalog replacement occurred.
