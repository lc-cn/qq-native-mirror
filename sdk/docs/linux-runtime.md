# Linux pure Node runtime evidence

Verified 2026-09-30 with QQ Linux 3.2.32-52194. These tests run ordinary Node in ephemeral Linux containers provided by the already available OrbStack Docker environment. No QQ executable or Electron process runs. No macOS login state is copied.

| Architecture | Node | Loader | Kernel initialization and QR | Public `createClient` |
| --- | --- | --- | --- | --- |
| arm64 | 24.20.0, N-API 10 | Success, 98 exports, normal exit | Success, 600-byte QR PNG | Source: 599-byte QR; installed tarball: 601-byte QR |
| x64 via Linux amd64 emulation | 24.20.0, N-API 10 | Success, 98 exports, normal exit | Success, 600-byte QR PNG | Source: 597-byte QR; installed tarball: 596-byte QR |

The table describes QR-only probes. A subsequent Linux arm64 run received user phone confirmation and reached authenticated Session readiness, as recorded in `.local/linux-live-arm64/verification.json`. Linux x64 still has QR-only evidence. Linux arm64 restore then failed because no eligible native quick-login record was available; account services, media/message operations and installed-package restore remain unverified. See the authorization/restore update below. QR generation alone does not establish authenticated login.

## Actual loading prerequisites

The ELF wrappers import the custom `qq_magic_napi_register` symbol, just like the tested macOS wrapper. The compiled Linux registration bridge forwards that symbol to standard `napi_module_register`.

A base `node:24` Debian container has most needed loader libraries, but requires the distribution package `libx11-xcb1`. QQ's included `libbugly.so` imports `gnutls_free` without a direct ELF dependency that loads GnuTLS. Loading the standard system `libgnutls.so.30` globally fixes that missing symbol. The bridge now exposes `preloadLibrary(path)` using `dlopen(RTLD_NOW | RTLD_GLOBAL)`. Both architectures were verified with this method, without `LD_PRELOAD` or a QQ host.

The wrapper ELF RPATH is `$ORIGIN:$ORIGIN/sharp-lib`. Native files include `libvips-cpp.so.42`, `libbugly.so`, `libcrbase.so`, unwind and SSH libraries, plus base distribution libc, X11, C++ and Kerberos dependencies. An Alpine/musl base is not equivalent to this verified glibc environment.

The optional `PerfTrace` symbol warning also occurs on Linux and did not block QR generation.

## Metadata and digests

Although both archive filenames advertise `3.2.32_260812`, internal package version is `3.2.32-52194`. The native marker in `major.node` gives architecture-specific app IDs; package.json's `appid.linux` is an older value and was not used.

- arm64 app ID: `537379448`; wrapper SHA-256: `c302361f52494de257044e912e43ed244bb29ee59f59345d25a8959327828337`.
- x64 app ID: `537379447`; wrapper SHA-256: `7882b8e3055cd38584861042befacd8be9939896f5cbbca6fa4a230926b48526`.
- Verified QUA: `V1_LNX_3.2.32-52194_52194_GW_B`.

## Reproduction

The verified archives are under `.local/research/linux-archives`. Extract only their app resources into `.local/research/linux-arm64/opt/QQ/resources/app` and `.local/research/linux-amd64/opt/QQ/resources/app`:

```sh
mkdir -p .local/research/linux-arm64
bsdtar -xOf .local/research/linux-archives/QQ_3.2.32_260812_arm64_01.deb data.tar.xz |
  bsdtar -xf - -C .local/research/linux-arm64 './opt/QQ/resources/app'
```

`scripts/linux-docker-probe.sh arm64 load` compiles the bridge and safely enumerates exports. Replace arm64 with amd64 to verify x64. Mode `kernel` runs engine/QR setup with the built `dist/kernel.js`; mode `client` exercises source `createClient`, generates a QR code in a new Linux-specific data directory, and closes automatically. The script installs only the missing system library in a temporary container; it does not install QQ on the host.

Native bridge builds use `node scripts/build-native.ts`; Linux needs a C compiler and Node C headers. Generated bridges are under `native/linux-arm64` and `native/linux-x64`. `QQ_NODE_INCLUDE` and `QQ_CC` override headers and compiler locations.

The mirror must package the QQ native dependency closure and declare base glibc/system-library requirements. A complete arbitrary-distribution standalone bundle is not yet verified, and successful container loading must not be described as authenticated Linux client readiness.

## Installed npm consumer verification

The current built SDK was packed with `npm pack --ignore-scripts --cache .local/npm-cache`, then the tarball was installed offline into a new `/tmp/qq-package-consumer` inside each temporary Linux container. The consumer uses `import { createClient } from 'qq-native-client'` and supplies only wrapper path, a fresh data directory and version metadata. It does not import workspace SDK source or manually preload libraries. Both arm64 and x64 consumers created clients with 98 exports and generated QR PNGs, then closed immediately. This verifies the built npm entry and worker/bridge resolution through installed package layout.

Run `scripts/linux-packaged-probe.sh arm64` or `scripts/linux-packaged-probe.sh amd64` after packing to repeat. The package includes both Linux bridges. The temporary containers still install distribution `libx11-xcb1` and use installed glibc/GnuTLS; this is not evidence of zero system dependencies. No account authentication or post-login service verification is claimed.

## Unauthenticated service surface inspection

`scripts/linux-surface-probe.ts` enumerated loaded arm64 class prototypes without invoking account services. Buddy service exposes `getBuddyListV2`, `getBuddyList` and `getBuddyListFromCache`. Startup session exposes static `create`/`createWithModuleList`, and instance `start`/`stop`/`getSessionIdList`. Account session exposes static `getNTWrapperSession` and instance `init`/`onLine`/`offLine`.

Both architecture binaries contain native assertion strings requiring exactly three arguments for `getBuddyListV2`, zero for startup `start`, and four for account-session `init`. This checks method availability and argument counts only. It does not verify parameter semantics, result shapes, authenticated account session startup, or contact retrieval. Prototype snapshot is under private `.local/research/linux-arm64-surface.json`.

The exact tarball used for the installed-consumer checks had SHA-256 `08f3bc20391a8c6a2718c639dce8cae620eba309209a21e55022011cb21febd8`; a subsequent rebuild can produce a different digest and requires its own package validation.

## Prepared live Linux arm64 login runner

`scripts/linux-login-live.sh` is prepared for a user-authorized live login stage. It launches only ordinary Node in a temporary arm64 container, preserves its native account files under `.local/linux-live-arm64`, and never reads macOS account state. It writes private `qrcode.png`, `qr-ready.json`, `session-ready.json`, and a sanitized `verification.json` receipt without account numbers, UID, QR URL, native log output, or credential contents.

The runner waits for user phone confirmation and stays available after readiness until SIGINT or a 300-second limit. It does not query contacts or send messages. An explicit subsequent service gate is required for authenticated Linux account operations. `--restore` can exercise only the separately preserved Linux account directory after a real successful Linux login.

At preparation time this runner was syntax-checked only; it was deliberately not executed and did not generate a live login QR. Prior Linux QR probes remain unauthenticated evidence.

## Live authorization and restore evidence update

The parent task subsequently ran the prepared Linux arm64 live probe with user phone confirmation. Its private receipt records both `authenticated: true` and `sessionReady: true`; the process later closed normally at the 300-second deadline. This evidence is distinct from the earlier QR-only probes.

A later public restore probe failed with `No restorable login record` before any contacts/history queries or reconnect. A native diagnostic queried the login-record structure without storing identity or credentials: `LocalLoginInfoList` contains one record, with correctly typed boolean `isQuickLogin`, `isAutoLogin` and `isUserLogin` flags all false. Therefore the current strict quick-login eligibility guard is not failing because of a field-name or flag-type mismatch. The persisted native login database exists. Native MMKV initialization also reported `InvalidProtocolBuffer truncatedMessage` for an existing 111-byte `nt_mmkv_o3` payload and then loaded zero keys; this is an observed warning, not a proven causal link to quick-login eligibility.

No native data or credentials were cleared, patched or synthesized. Authenticated Linux contacts/history/reconnect and installed-package restore remain unverified because the restore prerequisite failed. Further account operations were stopped while prioritizing the user's signing/runtime concern.

## Static signing and official-runtime comparison

After account operations were stopped, only extracted binaries, archive inventory and SDK source were inspected. The Linux wrapper contains these exact static artifacts:

- `MSFSecuritySignCallback` and source-path string `wrapper/external/msf/msf_security_sign_callback.cc`.
- `SecuritySignManager` and `modules/group_pro/modules/msf-ng/msf/security/internal/security_sign_manager.cc`.
- `LoadSecuritySignType`, `SaveSecuritySignType`, `msfsecuritysign_type`, and `SSO_NEED_SIGNATURE_FLAG`.
- Error string `SendMsfRequestInternal security_sign_callback_ is null, cmd={} seq={}`.

The official archive has no separately named `qqsign` or `signsdk` library in its inspected file inventory. That absence does not establish absence of signing: the wrapper contains embedded signing-manager and callback code. Third-party ticket/signature services also exist, but their names alone do not establish that they implement transport security signing.

The official Linux QQ ELF executable contains the `qq_magic_napi_register` and `qq_magic_node_register` names and Electron embedded code. The ordinary-Node bridge supplies only the verified N-API registration alias and optional system-library loading. Loading standard GnuTLS supplies libbugly's missing TLS-library symbols; it is not a replacement QQ signing SDK. The bridge does not forge a signature or a security flag.

Current SDK account-session setup uses no-op MSF/status and shell-dispatch callbacks, and generic no-op fallback callbacks for unknown callback names. Whether native security-sign callbacks, their initialization, and every official environment input are fully supplied remains unverified. Ordinary Node lacks the official Electron linked bindings and bundled shell initialization. Docker hostname/network/device context can also differ across runs, independently of the registration alias.

These static findings establish a signing integration boundary to investigate. They do not demonstrate a server-visible unofficial-client marker, fake-sign flag, successful signature generation, or the cause of disconnection. No live signing calls, SSO requests, new restores/logins, or messages were executed during this static review, and no detection-evasion implementation was added.

## Standalone Linux native bundle export

`scripts/export-linux-native.py <extracted resources/app> <new destination>` reads ELF64 program headers and the dynamic section directly using Python's standard library. It never runs QQ, `ldd`, or native constructors. The traversal starts at `wrapper.node`, resolves `DT_NEEDED` through `DT_RPATH` / `DT_RUNPATH` with `$ORIGIN` expansion, retains inherited RPATH for transitive dependencies and retains vendor paths in the output. A vendor library present but unreachable through the inspected loader paths causes an explicit failure. The destination must be new. Symlinks are dereferenced after checking that their real targets stay in the vendor root.

Both current extracted bundles have now been exported and every copied file verified by SHA-256 and size:

| Architecture | Export | Native files | Bytes | Actual native appId |
| --- | --- | --- | --- | --- |
| arm64 | `.local/native/qq-3.2.32-52194-linux-arm64` | 8 | 181287704 | 537379448 |
| x64 | `.local/native/qq-3.2.32-52194-linux-x64` | 7 | 172094832 | 537379447 |

Each export has an SDK schema-1 `manifest.json` with relative file URLs, suitable as a `stageMirror` input after hosting the listed files together. The adjacent `dependency-report.json` records each dependency edge and externally required library. These reports are local metadata, outside the native file manifest. The appId comes from the unique `major.node` `QQAppId/<digits>` byte marker, while clientVersion/buildVersion come from `package.json`. QUA is explicitly constructed as `V1_LNX_3.2.32-52194_52194_GW_B`; it is not claimed to be an extracted native literal. major.node is inspected for metadata and hashed in the report, but is not loaded or included as a Node dependency.

The exported closure includes vendor bugly/crbase/unwind/ssh2 and sharp libraries; external dependencies include glibc, X11/X11-xcb/Xext, libstdc++, libgcrypt and Kerberos GSSAPI. Exact per-architecture names are in the report. `libgnutls.so.30` is additionally recorded as a runtime preload based on the earlier ordinary-Node symbol-resolution probe; it is absent from this ELF `DT_NEEDED` inventory. System libraries are not copied or automatically installed by this exporter.

This is a **static closure and hash-inventory validation**, not a new runtime or account test. Runtime `dlopen` modules, optional services and resources are beyond `DT_NEEDED` analysis. Linux exports differ from macOS framework exports: they preserve ELF library search layout and record external system libraries, while macOS copies complete framework bundles needed for code-signature/resource metadata. Neither exports the entire official QQ executable as a Node host, and no configuration or account data is copied.

## Exported-bundle loading verification

2026-09-30: the independently exported QQ 3.2.32-52194 bundles both loaded successfully under Node 24.20.0 (N-API 10), with 98 exports and normal exit: arm64 natively, x64 using the existing amd64 emulation. Reproduce with `sh scripts/linux-bundle-load.sh arm64` or `x64` after preparing the indicated Node/system-library image. Each container uses `--network none`, a read-only filesystem, a temporary `/tmp`, and mounts only the exported native bundle, matching bridge and scripts. No account directory or QQ executable is mounted; the script only loads modules and enumerates exports. This upgrades the new bundle's evidence from static closure to actual loading, not authentication, provider initialization or server acceptance. Private load receipts are `.local/research/linux-bundle-load-{arm64,x64}.json`.

## Installed SDK plus independent mirror bundle

Both arm64 and x64 then passed `sh scripts/linux-bundle-consumer.sh <arch>` under Node 24.20.0: install the current npm tarball offline, import by package name, serve the independent staged bundle through a container-local HTTP mirror with trusted manifest SHA-256, call `createClient`, verify 98 exports, and close with state `closed`. External networking is disabled; no account directory is mounted and no login is requested. This covers automatic packaged registration bridge selection, system GnuTLS preload, mirror download/hash validation, worker initialization and close. It does not initialize desktop/account Session signing or prove account operations. Receipts: `.local/research/linux-bundle-consumer-{arm64,x64}.json`.

The first attempt failed because Docker's default `/tmp` tmpfs was `noexec`, preventing installed `.node` libraries from mapping executable segments. The dedicated temporary consumer now uses `/tmp:rw,exec,mode=1777`. Production installation/cache directories must also permit dynamic-library loading; this is an operating-system mount constraint rather than a QQ signature result.

The latest SDK now calls the kernel's single-flight `prepare()` during worker initialization, before `createClient()` returns. It creates the local engine/session objects, initializes desktop and login configuration and registers listeners, but does not call LoginService.connect or request authorization. Both installed Linux bundle consumers passed again with this path in empty data directories and disabled networking. This proves local preparation returns normally; it does not initialize an authenticated account Session or resolve the signing callback's runtime pointer/guard state. Login still performs the explicit connection/authentication stage.

The current consumers also install the pinned production dependency `silk-wasm@3.7.1` from its original local npm tarball and execute the installed built-in codec. Both architectures encode a generated one-second PCM16 WAV to Tencent SILK and decode it to measure exactly one second (`builtinCodecSeconds: 1`), then prepare and close the native client normally. The x64 run uses amd64 emulation on this arm64 machine. No audio is sent. This establishes local codec execution and packaged native preparation, not QQ voice delivery or signing authenticity. The codec tarball must first be available at `.local/artifacts/silk-wasm-3.7.1.tgz` for these offline scripts; ordinary npm consumers resolve the declared dependency normally.

Separate no-account hardware-breakpoint observation now identifies a registered native signing callback during arm64 preparation; see [signing investigation](linux-signing-static.md). This does not establish provider execution or authentic signature output.

## Current packaged regression receipt

At 2026-09-30 09:14 UTC, both isolated installed consumers passed again after the native error-code and recall-correlation changes. Each receipt now binds results to the actual mounted npm tarball SHA-256, rather than only the unchanged package version: `9c59cf257f1238632503250187b6394137e943e4674c0190c6e5f48c305d2972`. Both report Node 24.20.0, 98 exports, mirrorLoaded/environmentPrepared true, one second measured built-in codec output and final state closed. Linux x64 still runs through amd64 emulation; arm64 runs natively. Both accountMounted and loginAttempted are false. These are current package execution receipts, not new authorization, messaging, account restoration or signature-integrity evidence.

At 2026-09-30 09:21 UTC, package SHA-256 `93241061a79d0b0f516c0c9df16fdfea0248b4476ebf4b98375291a7d6a1e61d` passed both installed consumers after addition of the guarded native submodule service boundary. Native listener registration, preparation and close still complete on both architectures, with 98 exports and one-second codec output. No account is mounted and no login attempted. This verifies compatibility of the new proxy boundary during actual initialization, not its behavior under an authenticated account operation.

## Second Linux version: installed SDK preparation

QQ 3.2.31-51102 arm64 passes the current offline installed npm consumer using `sh scripts/linux-bundle-consumer.sh arm64 "$PWD/.local/native/qq-3.2.31-linux-arm64"`. On 2026-09-30 09:36 UTC it imported the npm package, downloaded the exported bundle through the local trusted-digest mirror, prepared 92 exports and closed normally under Node 24.20.0. The built-in codec measured one second. Receipt `.local/research/linux-3.2.31-consumer.json` binds package SHA-256 `fcb6081d9cda49a987cef630a34de7805adebbf6b3ad1b7e9c61bd3eee090776` and manifest SHA-256 `a2d7862ec4d6bc68fedf19f4b88aa38e6e69e2a7c0f3249f3f850f233d338d43`. No login or account mount occurred.

Export-name comparison shows all 92 older names remain in 3.2.32-52194; six newer names are added: NodeIGetAppActiveStatusCallback, NodeIGetSwitchToBackgroundReqCallback, NodeIGetSwitchToSilentReqCallback, NodeIKernelPYMKService, NodeIKernelVasClubService and NodeIKernelVasGroupService. Receipt `.local/research/linux-version-export-diff.json`. Method ABI, login, business operations and signing compatibility are not established by this comparison. The version-gated buddy query driver remains unchanged; no account support claim was broadened.

## Older amd64 sample

3.2.31-51102 amd64 also passed installed SDK mirror download, prepare/close and one-second built-in codec execution under Node 24.20.0 at 2026-09-30 09:42 UTC. It reported 92 exports and closed state; accountMounted/loginAttempted are false. Execution uses amd64 emulation on the local arm64 host. Receipt `.local/research/linux-3.2.31-x64-consumer.json`. The exported ELF closure contains seven files totaling 161998248 bytes. No authenticated account APIs or security-signature output were verified.

## Authorized amd64 QR acceptance attempt

On 2026-09-30 10:11:47–10:12:49 UTC, the user-authorized fixed amd64 QR/read-only runner produced a 603-byte QR image but did not reach ready. It closed with category offline, executed no read operations, and did not send messages. The original receipt lacks the detailed native offline fields, so the cause cannot be assigned to QR expiry, mobile rejection, detection or network failure. Receipt `.local/linux-x64-qr-readonly-v1/receipt.json`; one-attempt marker retained, no automatic retry. The runner now records bounded timestamped QR-scanned, authenticated and ready stages, whitelisted initialization stages, numeric MSF status/reason/error code, and offline event kind/source/retryable fields for future separately authorized runs. Account identities, native argument payloads and textual native errors are excluded. Phone-side confirmation is recorded below. The authorized media batch was not started after this abnormal outcome.

The user subsequently confirmed that phone QQ scanned and accepted this QR and displayed login success. Record `.local/linux-x64-qr-readonly-v1/phone-confirmation.json`. This rules out treating the attempt simply as an unscanned QR, but does not establish the SDK authenticated callback or Session readiness. The runner only recorded ready state and lacked authenticated-stage telemetry, so the exact boundary between mobile confirmation, native authentication and Session failure remains unknown. Do not label this a successful amd64 account Session, or a proven signature kick. No retry or media send has occurred.

The updated diagnostic runner passed a simulated authenticated-then-disconnected path: authenticated true, ready false, closed true, no read operations, offline error category, and ordered stage timestamps. Injected account identifiers/ticket strings did not appear in the saved receipt. This is a runner control-flow and redaction check, not a second real login or native signing observation.

At 2026-09-30 10:26–10:27 UTC, the latest npm artifact SHA-256 `2680e087f3af11c088cea8a647e76959bc67b1e89fe9bdea437a7985faceec24` passed the installed mirror consumers on both Linux arm64 and amd64 (amd64 emulated). Node 24.20.0 prepared 98 exports, measured one second with the bundled codec and closed normally. Both containers had networking disabled, no account mount and no login attempt. This verifies the current packaged environment preparation, not authenticated query/mutation behavior or signing authenticity. The separate second amd64 QR diagnostic remains unexecuted pending user confirmation.

## Second authorized amd64 QR attempt

On 2026-09-30 10:28 UTC, the user explicitly authorized another attempt and confirmed phone-side login success. The installed package recorded qr-scanned at 10:28:43.620, authenticated at 10:28:45.094, then MSF status 1/reason 0 at 10:28:45.248 and disconnected at 10:28:45.253. No ready event or read operations occurred, and the worker closed normally. Receipt and phone confirmation are retained in `.local/linux-x64-qr-readonly-v2/`; its exclusive attempt marker remains. No further login or message send followed.

The immediate termination originates in the SDK Depends adapter handling status 1; the pinned community adapter source leaves onMSFStatusChange empty. The enum identifies status 1 as disconnected and reason 0 as unknown, but does not establish whether the initial Session notification is a terminal failure or a pre-connection snapshot. The native authentication callback is now proven for amd64, while usable Session readiness is not. This observation does not prove server-side kick, detection, signature failure or ordinary network failure. No lifecycle behavior was changed to ignore the notification or fabricate online state.

## Startup MSF lifecycle correction

The SDK now distinguishes an initial disconnected/unknown MSF snapshot during a pending account Session startup from disconnection of an established account connection. Status 1/reason 0 before readiness and before any status 2 is recorded without cancelling startup. It does not resolve login or manufacture ready; native readiness remains required, and the login deadline still fails if readiness never arrives. Status 1 after readiness/connection, explicit logout reasons, login disconnects and SSO errors retain failure handling. Two regressions cover initialization followed by readiness, missing readiness timeout, established disconnection and explicit logout. All 115 regressions and installed npm consumer checks passed. This corrects the demonstrated premature-abort path but has not yet been validated with another real amd64 login; the cause of its initial notification and signing authenticity remain unknown. The artifact used in the second real attempt was archived by SHA-256 before repacking.

## Third authorized amd64 QR attempt after lifecycle correction

The user authorized execution and confirmed phone login success. On 2026-09-30 10:34 UTC, the corrected installed SDK authenticated at 10:34:22.386, received initial MSF status 1/reason 0 at 10:34:22.503, and reached native ready at 10:34:23.021. This directly confirms that the earlier initial MSF snapshot must not alone terminate Session startup for this pinned amd64 sample. The friend query returned 12 records; the group query timed out after approximately ten seconds, so no member query ran. The account worker then closed normally. No messages, retries or reconnects were attempted. Receipt and phone confirmation: `.local/linux-x64-qr-readonly-v3/`.

This establishes actual amd64 native authentication, Session readiness and a friend-query response under ordinary Node in amd64 emulation. It does not establish friend-list completeness (prior macOS acceptance returned a larger list), group-query compatibility, account restoration, messaging or signature integrity. The group timeout remains an unresolved native callback/query issue; it is not categorized as a kick. The exclusive marker and account data are retained.

## Group refresh callback correction

Pinned NapCat group types define REFRESHALL=0 and GETALL=1 as whole-list updates. The SDK requested force=true but accepted only GETALL, incorrectly discarding REFRESHALL. Both kinds are now accepted; MODIFIED/REMOVE/unknown kinds remain ignored. A regression dispatches only REFRESHALL after deltas and requires the full refreshed result. Query mocks now retain every registered listener, matching the native multiple-listener contract. All 118 regressions and installed consumer checks passed. This is a confirmed adaptation defect; the previous live attempt did not record update kinds, so whether it caused that timeout remains unverified. Source: https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/types/group.ts . Friend definitions expose overloads and category counts but no pagination cursor in getBuddyListV2; the 12-record result alone does not prove pagination or completeness.

## Fourth authorized amd64 QR and read-only attempt

2026-10-08: the user authorized and confirmed another QR login. OrbStack was initially stopped and the old local test image was absent; neither failed infrastructure launch opened a Session or consumed the login marker. OrbStack was started and the existing Node:24/system-library Dockerfile rebuilt before the single account attempt. The installed package authenticated, reached ready, returned 3 friends and 13 groups, and returned an empty member response for the first group; it closed normally with exit zero. Group telemetry captured kind 4/count 0 twice, then REFRESHALL kind 0/count 13. This confirms the full-refresh callback correction works on this actual amd64 native sample. Receipt and phone confirmation: `.local/linux-x64-qr-readonly-v4/`.

These are actual query responses, not proof of contact/member completeness. The account may differ from earlier attempts; no identity comparison is claimed or identifiers published. The empty member result needs investigation. No messages, mutations, reconnects or retries occurred. Signature authenticity and durable account restoration remain unresolved.


## Native Linux CI with the corrected main (2026-10-09)

[Run 37888770685](https://github.com/lc-cn/qq-native-mirror/actions/runs/37888770685) passed on native x64 and ARM64 Ubuntu 24.04 runners for both 3.2.31-51102 and 3.2.32-52194, under Node 24.20.0. Fresh consumers imported the verified corrected main by package name with native optional dependencies omitted, downloaded from the public default catalog, verified every native file, prepared and closed twice, and made zero native-file requests on the second preparation. Symlink creation was denied throughout SDK/worker execution. The older versions were selected explicitly; omitting version selected 3.2.32-52194. Older/newer exports were 92/98. No QQ account was mounted or login attempted. This upgrades preparation and mirror evidence to native runner execution; previous account claims keep their original scope.

Private bound receipts and the independently checked summary are in `.local/research/linux-version-ci-37888770685/`. Old version business-method compatibility remains unverified, and the existing buddy-list guard is retained.
