# QQ native SDK capability and acceptance checklist

The target is an embeddable TypeScript SDK comparable in everyday bot operations to oicq: account lifecycle, contacts, groups, message receive/send, history, recall, media and explicit management actions. This document defines acceptance; listing a capability does not claim it already works.

Runtime contract: ordinary Node.js, no QQ installation or Electron executable needed by consumers. Proprietary native dependencies must be supplied as a complete local bundle or a trusted mirror package. The current native registration bridge and kernel driver are platform/version specific. Other platforms and kernel versions require independent runtime verification.

## Evidence levels

- **Implemented**: code and documented public contract exist.
- **Fake-tested**: synthetic native services exercise translation and lifecycle behavior. This cannot establish QQ server behavior.
- **Native-tested**: the actual native kernel ran under Node against the authorized account and produced the expected result.
- **Packaged-tested**: install the npm tarball into a clean consumer directory, import by package name, then repeat the native test with the independent dependency bundle or mirror.

Every acceptance result must record kernel version, platform/architecture, Node version, package revision, operation and evidence level. Avoid including account secrets, complete contact lists, message content or login images in published records.

## Required capabilities

| Capability | Public surface / intended behavior | Real acceptance standard |
| --- | --- | --- |
| Native preparation | `createClient(options)` with local bundle or manifest/digest | Clean consumer loads bundle without launching QQ/Electron; missing dependency and incompatible registration fail clearly |
| Mirror/cache | Trusted manifest and per-file SHA-256; relative dependency paths | Fresh fetch, valid cache reuse, corruption repair, four separate process contenders, dead installation owner recovery |
| QR login | `login({method:'qr'})`, `qrcode`, `authenticated`, `ready` | User scans generated image; readiness comes only after account Session initialization |
| Account restore | `login({method:'restore',uin?})` | Restart Node with same data directory and regain ready Session; ambiguous records require explicit account |
| Quick login | `login({method:'quick',uin})` | Explicit account reaches readiness; expiry/error yields actionable failure |
| Lifecycle | `close()`, disconnect/logout/termination events | Native worker exits on close; pending requests fail on crash; shutdown does not erase account credentials |
| Friend list | `listFriends()` | Authorized account returns identifiable friends; empty list remains distinguishable from operation failure |
| Group list | `listGroups()` | Authorized account returns joined groups with consistent IDs and names |
| Group members | `getGroupMembers(groupId)` | Known group returns matching membership, handles paging/completion and rejects unavailable group |
| Incoming messages | `message` event and normalized elements | Explicitly authorized peer sends private and group messages; SDK emits sender, target, message ID, time and content; history/local notifications do not duplicate live delivery |
| Private send | `sendPrivateMessage(userId,message)` | Explicit human instruction names recipient and content; successful native result and peer receipt agree |
| Group send | `sendGroupMessage(groupId,message)` | Explicit human instruction names group and content; successful native result and visible receipt agree |
| Text / mention | String or text/at elements | Plain text and group mention preserve order, Unicode, target and returned message identifiers |
| Image / reply | Image/reply elements | Local image is uploaded and visible; reply references the actual originating message; invalid paths/IDs reject clearly |
| History | `getHistory(...)` | Retrieve known messages with bounded limit/cursor; stable order, target and pagination; no invented placeholder records |
| Recall | `recallMessage(...)` | Explicitly authorized recall removes a known own message; permission/time-window failures surface |
| Files and rich content | File/audio/video/forward elements or dedicated APIs | Upload/download can be checked against hashes; type-specific metadata and native error behavior verified individually |
| Group management | Mute, kick, settings and notices as explicit methods | Only explicit human-authorized actions; permission errors are surfaced; never exercised automatically by smoke tests |
| Friend/group requests | Request events and explicit accept/reject methods | Real pending request reaches SDK; chosen action matches explicit authorization; no implicit approval |
| Profile/contact operations | Profile lookup, nickname/card changes, relationship actions | Read APIs agree with account; mutations separately authorized and verified |
| Multi-account | Separate clients and data directories | Two authorized accounts run concurrently with isolated sessions/events/cache; no credentials cross account boundary |
| Native security signing | Authentic provider initialization, explicit missing-environment failures, preserved kick reasons | Vendor provenance and provider/host contract demonstrated separately from login success; no fabricated signatures, success responses or detector outcomes |
| Version/platform drivers | Compatibility declaration and driver selection | Each declared kernel/platform loads, logs in and repeats message/contact acceptance; static export inspection is insufficient |

## Current evidence baseline

Before the expanded SDK work, README records actual macOS arm64 / Node 24.19.0 / kernel 7.0.2-53644 evidence for native loading (104 exports), QR authentication, ready account Session, restore and the packaged consumer mirror path. The mirror fixture test verifies cache integrity and concurrency without executing downloaded binaries. This baseline does **not** establish messaging, group management, media or broad platform compatibility.

The expanded SDK's new method declarations and fake tests should be recorded separately from live native tests. Do not promote a method to native-tested merely because its proprietary export exists or a Promise resolves without confirming the native completion payload.

## CLI contract

`src/cli.ts` provides explicit `init`, `config`, `login`, `contacts`, `groups` and `send` commands. `init` creates a private config file using exclusive creation and refuses overwriting existing configuration. `config` validates locally without loading native code. Account commands explicitly await login before calling the SDK and close afterward. Config paths are interpreted from the invoking working directory; use absolute paths when creating configuration.

Examples (source checkout; installed binary wiring is handled by package metadata):

```sh
node src/cli.ts init --config ./qq.json --data-dir ./account-data \
  --wrapper /absolute/path/wrapper.node --client-version VERSION --app-id APP_ID --qua QUA
node src/cli.ts config --config ./qq.json
node src/cli.ts login --config ./qq.json --method qr --qr-file ./qrcode.png
node src/cli.ts contacts --config ./qq.json
node src/cli.ts groups --config ./qq.json
```

`send` requires an explicit command with `--kind private|group`, `--target ID` and exactly one of `--text TEXT` or `--message-file JSON`. Listing commands never send messages. This project's automated development checks must not invoke real sends or any account mutation. CLI QR writes and restoration are login actions; the user retains control of phone confirmation.

## Release gates

1. Build/type checks and meaningful fake regressions pass.
2. Fresh npm installation exposes declarations, worker, bridge and CLI correctly.
3. Native read-only contact/group/message receiving checks pass against authorized accounts.
4. Send/recall/media checks occur only after explicit authorization of exact target and operation.
5. Public README names supported versions and states remaining gaps. No “complete oicq compatibility” declaration until all promised capabilities have corresponding acceptance evidence.

## Latest native evidence and priority

On 2026-09-30, macOS readonly acceptance passed friends (568), groups (82), first-group members (2), bounded history, received group-message callbacks, explicit worker restart/restore and close. One private text send and one recall passed native callbacks; the user confirmed receipt or recall notice. Media, requests and management mutations are not promoted beyond their actual tests. Linux arm64 passed phone-confirmed auth/Session readiness; restore failed with one native login record whose three login flags are false. Signing investigation takes priority; no additional account test is performed while its runtime/provider integrity is unresolved. See [signing integrity](signing-integrity.md).

## Offline npm consumer verification (2026-09-30)

Run `node scripts/verify-package-consumer.mjs` to build, pack and install the current package in a fresh temporary consumer using npm offline mode. It checks the published file inventory for private/development files, imports `createClient` and `QQClient` by package name, runs installed CLI help, and compiles a consumer using typed callback/kick events and message APIs. The consumer explicitly enables Node types. No native library, QQ account or signature is executed. This proves packaging and public declaration usability, not native runtime or server acceptance. The latest private receipt is `.local/package-consumer-verification.json`; the current run passed all four checks with 31 published files.

## Account directory ownership

Each native worker now acquires `.qq-native-client.lock` before any bridge/wrapper loading. A live process owner excludes concurrent clients using the same directory. Normal process exit releases only its own token; abrupt exits leave a process/token record that another worker reclaims only after proving the owner PID no longer exists. Unknown/malformed locks remain untouched and produce an error. Tests cover live-owner exclusion, dead-process recovery and malformed-lock preservation without account data or native execution. Separate accounts should use separate data directories. This protects cooperating SDK workers; it is not a locking contract with the official QQ application.

## Incoming replay handling

`onRecvMsg` delivery suppresses repeated message identities within a native Session using chat type, native conversation ID and message ID. The bounded cache retains the latest 10,000 identities, does not store message content, and resets when the Session is replaced. History queries and recall updates remain independent. This does not classify synchronization notifications as live traffic, provide cross-restart exactly-once delivery, or deduplicate beyond the retention bound. Local regression covers repeated batches, other conversations/chat types and recall preservation; real replay behavior remains to be verified.

## Group request implementation and offline verification

`listGroupRequests({doubt?,limit?,before?})` returns actionable invitation/admin-approval/join-request records and the native next cursor. `request.group` emits deduplicated unhandled actionable notifications. `handleGroupRequest(request,accept,reason?)` preserves native type/sequence/group/doubt fields and explicitly dispatches acceptance or rejection. It does not promise server approval. Unsupported native notification types are not converted into actionable requests. Because page callbacks lack a request identifier, list operations serialize and any failed page invalidates further queries in that Session; recreate it explicitly to avoid delayed-page miscorrelation.

Current implementation is connected through QQClient, worker allowlist, native service dispatch and CLI. The fresh npm consumer verification passed with 35 published files and typed group events/pages. All 60 local tests pass, including multiple group listeners, timeout/late-page isolation, explicit decisions and invalid payloads. No real group request or approval was performed; native/server acceptance remains missing.

Shutdown completion now waits for the owning worker's actual exit. Native close acknowledgement alone cannot mark process cleanup complete. A bounded shutdown escalates to SIGKILL after two seconds and reports failure if the process still has not exited after four seconds; a failed stop is not reported as a closed client. A controlled-exit regression confirms concurrent close completion and state remain pending until the exit event. Native data-directory locking remains process-owned and is released by worker exit.

## Current package and audio verification

The latest fresh npm consumer receipt has 45 published files and all four packaging/import/CLI/declaration checks passed. Offline installation requires the original `silk-wasm@3.7.1` tarball at `.local/artifacts/silk-wasm-3.7.1.tgz`; the package declares that exact production dependency for normal npm installation. Local built-in codec tests perform actual WAV/SILK/PCM conversion and native message preparation without sending audio. Linux arm64 and emulated x64 installed consumers independently execute the same codec with one-second measured output, prepare the native environment and exit normally with empty account directories and networking disabled.

All 78 local tests pass in an environment that permits localhost listening. In the restricted sandbox the mirror HTTP fixture receives `EPERM`; its error is now handled explicitly rather than triggering a Node internal assertion. No mirror test is skipped or replaced, and no QQ module is loaded by those fixture tests. None of these checks provides QQ media-delivery or signing-integrity evidence.

After explicit PCM16 WAV format/frame metadata validation and its regression were added, the full suite passes 79 tests with no failures or skips. Invalid format or inconsistent headers must reject before an output SILK file is created; actual valid WAV conversion remains covered. Earlier counts above describe earlier snapshots.

## Native group notice implementation

`publishGroupNotice(groupId,text,options?)` and `deleteGroupNotice(groupId,noticeId)` are integrated through public methods, worker allowlist, native dispatch and explicit CLI commands. The fixed upstream contract obtains the `qun.qq.com` domain key inside the worker and uses native GroupService publication, local image upload or deletion. Tickets are neither emitted nor returned to the caller. Upload validates the native result and picture metadata; publication requires result zero. A void deletion response proves dispatch only. No real ticket request, publication, upload or deletion was performed during development.

Native bulletin-list/listener payloads remain unknown; fixed upstream OneBot listing instead uses WebApi. Native notice listing/events therefore remain missing, not represented as an empty list. Four module contract tests and a CLI preparation/validation test pass. Current complete local suite: 85 passes, no failures or skips. Fresh npm consumer: 47 published files, import/CLI/declarations/private-file checks passed, including typed notice methods. These checks do not establish native account/server acceptance.

An additional dispatcher integration regression verifies that constructing native services obtains no domain ticket, explicit notice operations return no ticket-bearing DTO/event, and calls after close cannot acquire another ticket. All five notice tests and the build pass. The freshly packed current SDK also passes both Linux installed consumers again (arm64 and emulated x64): actual local codec round-trip, 98 native exports, prepare and closed state, with networking disabled and no account mounts or login attempts. This is initialization/package evidence only; it performs no bulletin or ticket operation.

## Multi-client isolation regression

A two-client controlled-worker regression now exercises identical RPC counters and message IDs in separate instances: responses, message events and account identities stay with their originating client; kicking one account does not clear the other or take it offline. All 15 client lifecycle tests pass. This covers SDK IPC ownership rather than real simultaneous native account sessions. Native two-account acceptance remains missing and will not be claimed from these fixtures or account-directory lock tests.

The SDK now snapshots account identity before emitting `ready`, so mutation of event arguments cannot change the stored account or future restore identity. Reconnect initialization/login failure also waits for replacement-worker exit before rejecting; a kill request alone is not cleanup. Cleanup errors preserve both causes in an AggregateError. Controlled regressions cover both behaviors without native execution.

## Structured worker errors

Worker failures now serialize only message, name and an explicitly supplied string/number code. The parent rejects with exported `KernelRequestError`, retaining the originating pending operation rather than accepting a remote operation name. Arbitrary attached native payloads, causes and stacks are excluded. Legacy string replies remain compatible. Group/contact native result failures now attach their explicit result code; missing/malformed results retain an SDK `invalid-result` category instead of inventing a vendor code.

The actual initialization-failure child-process regression confirms missing bridge `ERR_DLOPEN_FAILED` reaches the caller as operation `init`, with worker cleanup and data-directory lock release still verified. Serializer regressions check payload exclusion and legacy handling. This is real worker IPC evidence, not a live vendor failure-code interpretation or safe-retry decision.

## Group notice HTTP list

`listGroupNotices(groupId)` and CLI `group-notices` now retrieve the fixed upstream HTTP list using a client key from the native TicketService and, when needed, a domain key from TipOffService. The authenticated Session UIN is passed internally by the kernel, never chosen from the caller's list payload. Cookie exchange uses manual bounded HTTPS QQ-domain redirects, and credential-bearing request errors are replaced with generic errors. Tickets/cookies are not returned as API fields or emitted by this module. There is no automatic list request during initialization.

The returned `{notices,raw}` preserves the HTTP bulletin response and normalizes notice IDs, sender, time, text and pictures. The fixed source appends duplicate `n=1&n=20` parameters; this exact bounded query is retained without inventing a pagination cursor or completeness claim. Three HTTP contract tests and CLI preparation verification pass. No real ticket exchange or HTTP account request was made; server interoperability is unverified. Native bulletin-list parameter/callback contracts remain separately unresolved. Details: [native versus HTTP investigation](group-notice-native-list-research.md).

HTTP listing is now bound to the owning native-services lifetime. Offline transitions and explicit close abort active HTTP exchanges. A native ticket call already in progress cannot be cancelled by this JavaScript layer, but a ticket arriving after closure cannot trigger the next HTTP request. Controlled tests cover cancellation while awaiting a ticket and during an active HTTP exchange, and prevent another native domain-key request afterward. This adds shutdown/disconnect evidence without actual account traffic.

Parent-side login timeout now marks the client failed, terminates and waits for the authorization worker, and ignores late native readiness. A controlled regression confirms no account becomes online after the caller receives timeout, and another login requires explicit worker reconnect. Credentials are not erased. This behavior is specific to authorization; business request timeouts still have an unknown native completion outcome and must not cause replay. All 18 client lifecycle tests and build pass.

Synchronous IPC serialization/channel exceptions now use the same request cleanup as callback-reported send errors. A regression performs a failing first login send, a successful subsequent login, then crosses the old timer deadline to prove the abandoned request cannot terminate the later session. All 19 lifecycle tests and build pass; this is controlled-worker evidence rather than new native login acceptance.

## Self nickname modification

`setNickname(name)` and CLI `nickname` are integrated through worker dispatch and use the authenticated Session UID internally. Native detail callbacks must match that UID and the lookup request must return result zero. Existing longNick/signature text, sex and birthday are required and preserved in the exact pinned `modifyDesktopMiniProfile` payload. Missing fields reject instead of overwriting them with defaults. Only nickname is exposed; this is not acceptance for broader profile editing.

The lookup has one pending owner. Lookup failure/timeout invalidates that Session's self-profile query channel to prevent late callbacks satisfying a later request. Native-services close cancels lookup and removes its listener; no modification starts after lookup cancellation. Three module tests plus explicit CLI validation cover preservation, failed results, invalidated queries and close. Native mutation result zero is required but is not a post-update server readback. No real nickname or profile was changed during development.

A fourth self-profile regression crosses the actual ten-second lookup deadline (no mocked clock), then delivers a late complete self-profile callback and attempts another nickname update. The listener is removed once, only one fetch occurred, zero mutations occurred, and the subsequent lookup requires Session recreation. All four focused module tests pass. This supplies timeout-branch evidence separately from the earlier immediate native-failure test and does not constitute native-account acceptance.

## Reviewable media acceptance proposal

`scripts/verify-sdk-media.ts` defaults to review-only mode: read and verify the fixed plan and all fixture SHA-256 values, then print the plan without importing the SDK runtime or opening an account. Private fixtures at `.local/acceptance/media-v1` are a 64×64 blue PNG, one-second 440 Hz PCM16 WAV, 0.4-second silent blue MP4 and 59-byte text attachment. The proposed action is at most four private sends to the already selected peer 8596238, each followed by one own-message recall. This proposal does not reuse the previous text-send authorization.

Execution requires separate explicit human authorization; the CLI switch does not constitute that authorization. An exclusively created durable batch marker prevents rerunning the batch even after an uncertain outcome. No automatic retry occurs; errors stop later sends. SIGINT/SIGTERM stop future sends while allowing an already-dispatched send and its one recall to settle. The receipt stores only status/category fields, not messages, native ticket values or returned message identifiers. No script execution in account mode has occurred; review-only execution, fixture hashes and script type checking passed. Signing integrity remains unresolved, so functional media acceptance must not be reported as proof of account safety.

## Built-in WAV format matrix

`node scripts/verify-codec-rates.mjs` (after build) generates one-second local PCM16 WAV samples for all seven declared rates, 8/12/16/24/32/44.1/48 kHz, each with one and two channels. Actual WASM conversion and decoded-sample duration measurement pass all 14 cases with one-second output. Temporary samples are removed afterward; receipt `.local/research/builtin-codec-rates.json`. This validates local conversion of these sample formats, not preservation of stereo separation, arbitrary WAV codec support, QQ upload or server receipt. No QQ native module or account is accessed.

## Native result error codes

Profile lookup/update, friend/group request handling, forward-message operations and bulletin operations now retain the native failure result in the structured worker error code. Bulletin upload retains its separate errCode. Only message/name/code cross the error boundary; native response objects and credential fields are not attached. Missing or malformed result codes use the SDK category `invalid-result`, which is not a vendor detection code. Tests verify profile result 9, deletion result 5 and upload errCode 17; a rejected upload never proceeds to publication.

Build and all 104 regressions pass (zero failures/skips). Fresh package consumer verification passes installed import, CLI help, declarations and private-file exclusion for 53 published files. These checks use fixtures and packaging, not a new account login or signing authenticity test.

The message submission waiter also preserves a nonzero native submission result as the structured error code. A regression delivers a matching successful message callback before the native call returns result 23: the operation still rejects with code 23 and makes exactly one send call. A native rejection is authoritative even if a callback has already settled the internal waiter. No retry or real message is performed. Current build, all 105 regressions (zero skips/failures) and fresh 53-file npm consumer verification pass.

## Recall conversation correlation and download errors

Recall completion now requires the selected native chat type and peer UID in addition to message ID and recall timestamp. A controlled listener regression injects both a different conversation and a different chat type with the same message ID; neither completes the operation. Only the matching notification completes it, with one native recall call and no retry. This strengthens callback correlation and does not claim a new real-account recall acceptance.

Attachment failure callbacks retain their explicit fileErrCode/fileSrvErrCode in the structured error code. A failure with string code 42 rejects without publishing a destination file, and staging cleanup still completes. Build and all 106 regressions pass with no failures/skips; fresh npm consumer checks pass for 53 files. No account or network QQ operation was used.

## CLI watch terminal failures

CLI watch now rejects and reaches its existing close/finally path on nonretryable or unspecified disconnect, kick, logout, worker termination and reconnect failure. It waits across a retryable disconnect only when autoReconnect is explicitly enabled. Watch failure observers are removed during cleanup. Controlled event regressions cover both reconnect settings and listener cleanup. Build, all 107 regressions and fresh npm consumer checks pass; no account activity was performed.

## Session shutdown and deferred module calls

Native submodules now receive a guarded Session/service boundary: each service method checks current closed state, including methods retained across await points. Verified listener removal remains permitted during cleanup. A regression starts group-admin modification, suspends native UID resolution, closes services, then completes resolution. The operation rejects and zero native modifications occur. This cannot cancel a native operation already dispatched before shutdown. Build, all 108 regressions and fresh npm consumer verification pass; no actual group or account was modified.

The same guarded service boundary now also supplies the core message/media helpers. A regression starts local image preparation, closes services while asynchronous file inspection is pending, and verifies zero native staging calls and zero sends. The image path is a local format fixture, not a QQ delivery test. Previously dispatched native calls and local filesystem/codec work are not retrospectively cancelled. Build, 109 regressions and fresh npm consumer checks pass.

## Attachment publication after shutdown

Attachment download receives the native-services lifetime AbortSignal and checks it before work, after native completion and immediately before submitting the final exclusive copy. A regression aborts after native completion but before publication: the operation rejects with AbortError, leaves no destination and removes staging. This does not retract an already-dispatched copy or cancel a native download already in progress. Build, all 110 regressions and fresh npm consumer checks pass without account activity.

## Friend query completeness

Friend queries validate requested UID strings, deduplicate category overlap, and require a profile for every requested UID. Results are assembled in requested order and unrelated map entries are not included. Missing profiles reject instead of silently returning a partial friend list; malformed UINs also reject. A fixture regression returns two requested UIDs but only one profile and confirms rejection. Build, 111 regressions and fresh npm consumer checks pass. This has not been rerun on a real account during the signing investigation.

## Malformed native message notification batches

Receive callbacks reject nonarray batches and skip null/nonobject messages or malformed element arrays with payload-free diagnostic stage names, then continue later valid delivery. Message-update callbacks similarly reject nonarray batches and filter null/nonobject entries before dispatching waiters. No fake completion is synthesized; absence of a valid correlated response can still time out. A regression injects malformed batches, checks that callback handling does not throw, verifies later valid message delivery and confirms diagnostics omit fixture payloads. Build, 112 regressions and npm consumer checks pass without account activity. This is structural notification resilience, not a guarantee against every native payload shape or a new live-receive acceptance.

## Prepared amd64 QR read-only acceptance

`scripts/linux-qr-readonly.sh review` prints the fixed plan without importing the SDK or opening a Session. Separately authorized execution uses the installed current npm tarball, exported 3.2.32-52194 x64 bundle and a dedicated fresh account directory. The plan permits one QR login, friend/group queries and members of the first joined group; no messages, management mutations, history reads, reconnect or automatic retry. A durable exclusive login marker is reserved before Session creation. A five-minute deadline closes the worker; receipt stores only status/count/categories, not IDs, contact data or tickets. Native account data remains on disk. JS/shell syntax and review mode passed, and the current SDK tarball was repacked. The first authorized attempt ran on 2026-09-30: phone QQ reported login success, but the SDK did not reach ready and closed with an offline category; no queries or messages ran. See linux-runtime.md for the evidence boundary. Signing safety remains unresolved; amd64 runs under emulation.

## Prepared second amd64 diagnostic attempt

The explicit `--execute-approved-v2` runner selects a separate data directory, preserving v1 account data, receipt and exclusive login marker. It retains the same single-login/read-only plan and stop-on-error behavior. `.local/research/linux-x64-diagnostic-v2-plan.json` binds the reviewed scripts, npm artifact and native manifest by SHA-256. The second attempt has not executed; confirmation is pending after the first attempt failed. Stage telemetry records QR scan, native authentication and Session readiness separately, with numeric MSF status/error fields and no account/ticket payloads.

Friend mutation result failures now use the shared native error conversion, preserving explicit string and finite numeric vendor codes while classifying NaN/Infinity/malformed fields as invalid-result. The 2026-09-30 10:25 UTC regression run passed 113 tests, and a fresh installed npm consumer passed private-file exclusion, package import, CLI help and declaration checks (53 package files). No real friend mutation was attempted. The pending amd64 diagnostic plan was rebound to the repacked current artifact.

Group-list requests now require native GeneralCallResult result zero, coalesce concurrent callers, and invalidate the Session query channel after failure/timeout. Group callbacks carry no request identifier, so a later call cannot safely reuse the channel after an uncertain earlier result. Two regressions verify actual ten-second timeout isolation and that native rejection overrides an early full-list callback while preserving code 73. All 117 regressions and fresh installed consumer checks passed. This is query reliability evidence; the real amd64 group timeout and friend completeness remain unresolved. No further account login or business operation was attempted.

## Default native selection and CLI acceptance (2026-10-09)

`createClient({dataDir})` selects the latest matching device package from the published GitHub catalog. CLI `init` now accepts just config/data-dir, optional `--catalog`, and optional `--download-mirror`. Both local wrapper version inference and explicit complete version metadata are supported. Configuration validation does not load native binaries or contact QQ.

Build and 125 regressions pass. Fresh offline npm consumer checks cover package-name import, declarations with default native selection and downloadMirrors, installed CLI help, installed CLI default configuration creation/readback, and private file exclusion. CLI subprocess regression also verifies existing configuration preservation and rejects partial version metadata and insecure accelerator prefixes.

Installed npm accelerated default preparation passed with completed content reused; an empty-cache full accelerated download passed in 304 seconds. The thinned macOS arm64 candidate passed complete manifest integrity, preparation with 104 exports and normal close through the installed npm module. Neither check attempts login or establishes new account/media/signing evidence.

The separate thinned macOS arm64 QR attempt on 2026-10-09 completed after explicit user authorization and phone confirmation: authenticated, Session ready, friend count 3, group count 13, normal close, no errors. It used the installed npm module and a new account directory. No sends, management mutations, restore or retry occurred. This is real candidate account evidence, not media or signing safety evidence.

Resource-pruned macOS candidate acceptance on 2026-10-09: 46 paths/21 unique contents, ordinary Node 24.19.0, installed npm import, fresh QR authentication and Session ready, 3 friends, 13 groups, closed normally with no error. Explicit phone confirmation was supplied for this attempt. No messages, mutation, restore or media operation was executed. The complete original mirror remains the default.

## Resource-pruned media attempt (2026-10-09)

After separate explicit approval, `verify-sdk-media.ts --profile pruned-v1 --execute-approved` used the 46-path candidate and restored the account paired in the preceding QR attempt. The fixed batch targeted 8596238 with at most four sends and four own recalls. Image, voice and video each completed native send and recall callbacks. The text attachment completed its send callback, but recall timed out with an unknown outcome. The script stopped, made no retry, and closed normally. The durable batch marker remains reserved; do not rerun this batch. The user confirmed two recall notices and that file.txt remained visible; individual image/voice/video arrival is not established. This is partial live media evidence and a concrete remaining file-recall issue, not a complete acceptance pass or signing-safety proof. Receipt: `.local/acceptance/media-pruned-v1/receipt.json`.

Peer confirmation therefore establishes an actual attachment recall failure for this batch, rather than merely an absent completion callback. The difference between three native recall completions and two observed notices remains unresolved; no automatic account action is taken to investigate it.

## Recall native return validation (2026-10-09)

Recall now requires GeneralCallResult result zero before accepting the correlated completion. A nonzero or malformed native return is reported through the existing structured error path instead of waiting until a notification timeout. A regression injects a matching early completion followed by native result 8: the SDK rejects with code 8, excludes the attached fixture credential field and calls recall exactly once. Build, all 128 regressions and fresh installed npm consumer checks pass. No live account operation or retry occurred after this change. It improves rejection reporting; it does not prove the previous file-recall cause or resolve the native/peer notice discrepancy.

The reviewed upstream native service contract also declares recallMsg as Promise<GeneralCallResult>: https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-core/services/NodeIKernelMsgService.ts . Public code is supporting interface evidence, not live verification of this pinned kernel. The acceptance runner now records bounded structured error codes and payload-free callback name/type/count diagnostics for separately authorized future attempts. Existing batch markers remain reserved.

## Bounded native catalog download (2026-10-09)

Catalog bodies are limited while streaming rather than after unbounded response.text allocation. A fixture verifies that crossing 1 MiB cancels the body before JSON parsing. Catalog URLs and selected manifest URLs require credential-free HTTPS; malformed package identities, nonstring version fields and unsafe numeric version components reject before native payload selection. Build and all 130 regressions pass. No account operation occurred.

## Prepared file-only recall diagnostic

`verify-sdk-media.ts --profile file-v2` is review-only and binds a distinct fixed one-file plan, its 59-byte fixture, and the previously QR-verified pruned manifest by SHA-256. With separate explicit approval, it may restore the same account, send one new attachment to 8596238 and attempt its recall once. It never retries the old batch or creates a fallback QR login. A new exclusive durable marker separates this proposed action from the reserved prior batch. Script type checks and local review passed. No file-only account operation has executed yet. Native errors and callback name/type/count diagnostics are retained without payloads.

The separately approved file-v2 attempt executed once on 2026-10-09 using the corrected SDK and the same resource-pruned account. Restore and attachment send succeeded; recall returned structured native code -7003, so the SDK immediately rejected rather than waiting for a notification timeout. It closed normally without retry. The error-code meaning and whether full resources change the native refusal remain unverified. Receipt: `.local/acceptance/file-recall-v2/receipt.json`.

## Content cache installation copies

Valid content-cache hits no longer rewrite the cached object. Installation copies request filesystem copy-on-write cloning and fall back to ordinary copies when cloning is unsupported. Cache and installation retain independent inodes, so installed-file corruption does not damage the reusable cache; duplicate paths within one installation still use the existing hardlink grouping. Copied bytes are rehashed before publication. The content-cache subdirectory must remain a real directory inside the resolved cache root. Full existing regressions pass, and focused checks verify preserved cache modification time, independent installed/cache files, corruption repair without a new payload request, and refusal of a content-directory symlink before payload download.


## Ordinary-user locks and six-platform corrected-main acceptance (2026-10-09)

The local complete regression passed 143 tests. Both data-directory and native-cache locks now publish a fully written regular owner file using an atomic same-directory hardlink; they read legacy symlink tokens without following or creating them. Live-owner exclusion, dead-owner recovery, concurrent contenders and malformed-owner preservation remain covered. Filesystems must support same-directory hardlinks.

Actual GitHub run [37886708952](https://github.com/lc-cn/qq-native-mirror/actions/runs/37886708952), commit `6af4b3c4bb4309f14753d6bc6c3ab67503bd2d59`, succeeded on native Windows/Linux/macOS x64/arm64 runners, all under official Node 24.20.0. Every SDK/worker process denied symlink creation. Each platform installed only the main package, selected its own auxiliary automatically, prepared the real kernel and closed; then a fresh local HTTP fixture served the actual byte-verified native closure into a new cache and repeated initialization. Every second cache initialization made zero native-file requests. Windows/Linux exposed 98 exports; macOS exposed 104. The final aggregated main was independently installed and initialized on Linux x64, and its complete regression passed.

The six auxiliary tarballs are byte-identical to successful original run 37880903538; the corrected main is 230,041 bytes, SHA-256 `0e51e6dee2a99503c8bd0849483394e5979961b01d29826cdcfd08302affd556`. The candidate has seven tarballs and 25 explicitly bound evidence files, including original auxiliary provenance and fresh per-platform installed/cache receipts. Local download validation checked GitHub run/release identity, asset hashes, all package integrities and all 25 evidence files.

This establishes real native package and cache preparation under denied symlink creation. It does not establish public npm installation, Windows account functionality or authentic security signing. Public compressed mirror cold downloads have separate evidence below. Those gates need separate evidence. No login, restore, messaging or account mutation ran in this CI.


## Six-platform public compressed mirror acceptance (2026-10-09)

[Run 37889421789](https://github.com/lc-cn/qq-native-mirror/actions/runs/37889421789) passed on six actual native runners under Node 24.20.0. Each fresh consumer installed the fixed corrected main tarball from source run 37886708952 with all optional auxiliary packages omitted, imported by package name, and explicitly selected the public `catalog-gzip-v1.json`. The configured download accelerator was `https://gh-proxy.com/`; origin fallback remained enabled. This is not a direct-origin-only benchmark or public npm installation proof.

| Device | Native exports | First payload bytes observed | Second payload requests / bytes |
| --- | ---: | ---: | ---: |
| darwin-arm64 | 104 | 48,186,949 | 0 / 0 |
| darwin-x64 | 104 | 52,288,283 | 0 / 0 |
| linux-arm64 | 98 | 63,996,855 | 0 / 0 |
| linux-x64 | 98 | 62,122,352 | 0 / 0 |
| win32-arm64 | 98 | 46,360,957 | 0 / 0 |
| win32-x64 | 98 | 58,927,406 | 0 / 0 |

All receipts bound the expected public manifest digest to the checked-out catalog before downloading native files. The SDK verified compressed and restored byte hashes; the consumer independently rehashed every cached runtime file. Both initialization passes prepared and closed the real kernel with symlink creation denied. No account login, restore, send or management operation ran. Signing authenticity remains unresolved.

The default catalog now also includes the three verified macOS x64 and Windows x64/arm64 compressed entries, preserving the original five macOS arm64/Linux full-bundle rows. [Run 37890258044](https://github.com/lc-cn/qq-native-mirror/actions/runs/37890258044), commit `0acc260b2a139b1f398ac028e47699302adc2223`, subsequently passed all six native runners with `catalogUrl`, `version`, `manifestUrl` and `wrapperPath` omitted. Each receipt selected the exact latest device row in the default catalog, verified all cache files independently and showed zero payload requests/bytes on second preparation. It used the same fixed main candidate, omitted all optional auxiliaries, denied symlink creation and configured the download accelerator with origin fallback. No account activity occurred; public npm installation remains a separate gate.


## Login and query generation isolation (2026-10-09)

A failed worker now clears any pending automatic reconnect timer before reporting termination. A fake-worker regression reproduces retryable disconnect followed by a crash, verifies that no automatic restore or replacement worker occurs afterward, and confirms a later explicit reconnect still works.

Account Session initialization and callbacks are bound to their originating login generation and pending authorization. Delayed readiness, MSF status and SSO error callbacks from an interrupted Session cannot finish or interrupt a subsequent login. Async account-directory preparation and restore/quick-login completions also recheck their generation before affecting a current attempt. The regression interrupts one mock QR attempt, injects its callbacks during a new unauthenticated attempt, and permits only the new Session's actual readiness to complete it.

Friend-request listing coalesces concurrent callers but invalidates its query channel after any failed or timed-out query: the native callback contains no request identifier. Subsequent lists reject before dispatch until a new Session is explicitly created. Unsolicited friend-request events and explicit decisions remain available. Regressions cover timeout plus late notification, native failure overriding an early notification, preserved error code 73 and continued explicit decision dispatch. The unmodified source fails both new friend-query regressions.

Build and all 147 local regressions passed. These are synthetic lifecycle/correlation tests; no native library, QR authorization, restore or account operation ran. They do not establish new account acceptance or signing authenticity. The unpublished main package will be rebuilt and revalidated as a new immutable first-publication candidate; the six native auxiliary packages remain byte-identical.


The new immutable candidate [run 37890893656](https://github.com/lc-cn/qq-native-mirror/actions/runs/37890893656), source commit `9237a3a50329e5ce8d247c3f153003501cb7c349`, passed all six native Node 24.20.0 installed/cache consumers and the final Linux aggregate. Symlink creation was denied, native preparation/close succeeded, and each cache reuse made zero native-file requests. The aggregate also passed the full SDK regression suite. Main tarball: 236,137 bytes, SHA-256 `346bfee5895de2e0ef236cfb25d97654c8b773a5ec5adc67568b79e81301b11a`. All six auxiliary tarballs retain their earlier exact SHA-256/SHA-512 values. Local verification checked GitHub run/release identity, all asset hashes and the 25 bound evidence JSON files.

This candidate supersedes run 37886708952 for the unpublished first main package. It made no real-account login or restore attempt, and has not yet been published to npm. Historical public mirror runs above tested the previous fixed main candidate; new consumer workflows pin the new candidate for further verification.


The new fixed main candidate also passed independent public consumers: [default six-platform mirror run 37891347865](https://github.com/lc-cn/qq-native-mirror/actions/runs/37891347865) and [Linux two-version/two-architecture run 37891354573](https://github.com/lc-cn/qq-native-mirror/actions/runs/37891354573). Downloaded receipts were checked against source run 37890893656 and its exact main SHA-256/SHA-512. All six default devices selected their canonical latest manifests; every runtime file was independently rehashed, and second preparation made zero payload requests. The four Linux consumers prepared and closed both 3.2.31-51102 and 3.2.32-52194, with 92 and 98 exports respectively and no second payload download. No account login or restore ran. Older Linux business APIs and security-signature authenticity remain unproven.


## Official npm first publication and six-device consumer proof (2026-10-09)

All seven `0.0.1` packages are publicly available, and their `latest` tags, SHA-512 integrities, platform constraints and main optional-dependency pins were read back from the official registry and matched immutable source run 37890893656. The main package is [qq-native-client](https://www.npmjs.com/package/qq-native-client). Publication alone was not treated as consumer acceptance.

[Run 37893553033](https://github.com/lc-cn/qq-native-mirror/actions/runs/37893553033), verifier commit `bbd28c067c941bfe63cac32a67b9abea8bbbc75f`, passed all six native runners. Each consumer used an independent empty npm cache and requested only the published main package from `https://registry.npmjs.org/`. The installed lock matched main/device auxiliary integrity, foreign platform packages were absent, and mirror fallback was forbidden during default native preparation. CLI help and real kernel close passed.

| Device | Node version | Native exports |
| --- | --- | ---: |
| Linux x64 | 24.21.0 | 98 |
| Linux arm64 | 24.21.0 | 98 |
| macOS x64 | 24.19.0 | 104 |
| macOS arm64 | 24.20.0 | 104 |
| Windows x64 | 24.20.0 | 98 |
| Windows arm64 | 24.20.0 | 98 |

Every runner separately forced the explicit public compressed catalog with a configured accelerator and origin fallback. Its pinned manifest matched the canonical device entry; the loader and independent consumer checked runtime hashes. Second initialization made zero native-file requests and transferred zero native payload bytes. SDK/worker symlink creation was denied during this mirror phase. Downloaded twelve receipts were independently checked and bound to the fixed first-publication main.

A fresh local macOS arm64 consumer also passed public npm installation, by-name import, 104 exports, normal close and CLI help under Node 24.19.0 without mirror fallback. These checks made no account login, restore, send or management operation. They establish official package consumption and initialization; they do not establish Windows account operations, older Linux business compatibility, complete oicq parity or security-signature authenticity. Trusted Publisher configuration remains a separate maintainer step.


After publication, [source CI 37893829215](https://github.com/lc-cn/qq-native-mirror/actions/runs/37893829215), commit `0bdf79dcde7379fc1f1f70f322947924404c5652`, passed all six native builds, installed native initialization/close checks and the aggregate regression gate with the official auxiliary integrity/engine fields refreshed in the SDK lockfile. Publication was skipped. This validates the updated source lock, separately from the immutable public `0.0.1` consumer evidence above; it does not replace or republish those tarballs, and no account operation ran.

## Login target ownership and shutdown during reconnect (unpublished source, 2026-10-09)

Pure mocks reproduced malformed JavaScript login methods reaching the native quick-login branch, numeric account values passing the former coercing regex, and caller mutation changing the account requested after asynchronous preparation/reconnect. Login requests now use shared runtime validation and an owned copy at factory, public login/reconnect and kernel boundaries. Invalid inputs reject before native preparation, IPC or retirement of an existing worker. Quick login requires a decimal-string account, restore accepts one optionally, and QR remains the default. Same-target concurrent reconnects retain a shared promise; conflicting targets reject explicitly. A separate mocked factory subprocess verifies the original target across both delayed native preparation and deferred automatic login.

A second pure-worker reproduction showed `close()` during old-worker retirement waiting for a filtered RPC response and incorrectly reporting timeout after the worker had already exited. Shutdown now waits for the retiring worker's actual exit directly. Regressions check shared close promises, no replacement spawn after shutdown, no login while replacement initialization is interrupted, rejection on actual cleanup failure and ignored late readiness.

The build, 157 complete local regression tests and fresh offline package consumer passed. The installed consumer checked imports, declarations, CLI help/configuration and exclusion of private/development files; neither it nor these mock regressions executed QQ native code or operated an account. These source fixes are not present in the immutable public `0.0.1` tarball. No new npm publication was attempted.


[Six-platform source CI 37895151720](https://github.com/lc-cn/qq-native-mirror/actions/runs/37895151720), commit `2bf1aa61afc472654afeb817d7dcfe11ee30c7c9`, passed all native builds and the aggregate. The complete job log was independently parsed: all six matching-device consumers plus the final Linux aggregate installed only the main request, selected exactly their platform auxiliary, prepared and closed; macOS exposed 104 exports and Linux/Windows 98. The aggregate passed all 157 regressions. These consumers used isolated local registry fixtures serving the actual new CI tarballs, rather than claiming a new official npm release. Publication was skipped and no account login ran.

A separate subsequent pure-mock check identified an additional unresolved authentication boundary: quick login, explicit-account restore and automatically selected single-record restore all accept a native callback identifying a different account, then initialize that account's Session. The reproduction dispatched mock account `123` but resolved mock `456` in all three cases. Pre-fix kernel SHA-256: `1be2f7e2f286bf4fed669ae92b87ec278115a1c24bc3e60710d4cf59e19941d4`. The next fix must retain the selected authorization target per login generation and reject mismatched native identity before authenticated events or Session initialization. The successful preparation-only CI does not cover or resolve this boundary. Local reproduction script/receipts are under `.local/research/native-login-target-mismatch.*`; no real identity, native execution or network was used. Signing authenticity also remains unresolved.


## Native account target and identity isolation (unpublished source, 2026-10-09)

The preceding mismatch is fixed in source. Each pending login retains its method, actual selected quick/restore account and whether the authentication request has been issued. Automatic restore records the sole eligible account before invoking quick login, including after asynchronous login-list retrieval. Native identity must contain a nonblank string UID and a decimal-string or safe nonnegative integer UIN, normalized to the public string form. A non-QR callback must match the selected account; unexpected authentication before dispatch or a mismatched account rejects without an authenticated event or Session initialization. The original three-path pure reproduction now rejects each mock `123`→`456` mismatch before Session creation. These errors do not trigger another login.

Authentication, login/ready events, resolved identity and later online identity returns have independent copies. Regressions verify that event/result mutation does not change Session configuration or stored identity. An interrupted authenticated notification cannot initialize a newer attempt using the old account, and a disconnect during the login notification suppresses the old ready event. The parent also ignores native account events once closing begins while still processing the shutdown RPC; four fake-worker tests reproduce and prevent late ready/disconnected/logout/kicked events changing the closing state.

Build and all 181 local regressions passed, including 24 new focused identity/closing cases. A fresh offline package consumer passed installed imports, declarations, CLI help/configuration and private-file exclusion. These are mock/offline checks, with no QQ native execution or real account operation. The fixed-source six-platform native preparation CI is a separate gate. The immutable public `0.0.1` package remains unchanged; no new npm release was attempted. Account-target matching does not establish native signing authenticity or correlation of native callbacks that have no request identifier.


[Fixed-source six-platform CI 37896779539](https://github.com/lc-cn/qq-native-mirror/actions/runs/37896779539), commit `04030e7024edce3454c3808970eab1a9b2bfbb11`, passed all six native runner builds and the aggregate. Independent parsing of its complete job log confirmed every matching-device consumer plus final Linux aggregate prepared and closed using the actual CI tarballs and automatic auxiliary selection; macOS exposed 104 exports, Linux/Windows 98. The aggregate passed all 181 regressions, with publication skipped. This is current-source native preparation evidence through isolated registry fixtures, distinct from the earlier public npm `0.0.1` acceptance. No new account login or restore, messaging or management operation occurred.

## Standard QQ face sending (unpublished source, 2026-10-09)

`SendableMessageElement` now includes `{type:'face',id:number}`. Private/group sends and CLI JSON support mixing faces with text in the original order. The constructor uses only 329 known catalog IDs, rejecting nonnumeric, negative, fractional, unsafe or unknown IDs before native message ID generation and submission. Private numeric-target UID resolution can still precede element validation. CLI payload preparation rejects an invalid face before client creation. Native submission errors retain their result code and cause no retry.

The contract is pinned to NapCatQQ commit `26d7533e0f5800fdff865ab2f2ad7692917e1076`: [standard face converter](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-onebot/api/msg.ts#L707-L748), [face metadata](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/external/face_config.json), and [native enums](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/types/msg.ts). Downloaded bytes were independently checked against Git blob IDs `055227c97203b6ccb496dc1de0e6d12ea33acf75`, `ba937ea96f315235c80e34039d5c039f9b8e2d3c` and `8b1278e679f520a5e8a9916adc9fb473dca70c7d` respectively. `scripts/generate-qq-faces.mjs` verifies the exact catalog blob, unique IDs and field types before deterministic projection; `--check` verifies the generated source. No runtime metadata download or UI asset is added. The projected TS source is 8,084 bytes.

The native payload uses element type 6, name and source type 1. IDs below 222 default to classic face type 1 and later IDs to type 2; truthy animation type overrides to type 3. Sticker type, pack ID and sticker ID retain exact values, including the zero-valued metadata of ID 428. The table has 123 type-1, 104 type-2 and 102 type-3 entries. Standard dice/rock-paper-scissors IDs use this same converter; selected outcomes and specialized game-result fields are not exposed.

Thirteen fake-native tests cover exact classic/extended/animated/zero-sticker metadata, private and group mixed order, invalid-ID dispatch prevention and native rejection code 23 without retry. A CLI regression verifies payload rejection before client creation. Offline installed-tarball verification checks compiled metadata, CLI dispatch through a fake client and the public TypeScript send signature. These checks use no native library or account. The fixed upstream catalog does not establish every ID's compatibility with every QQ version. Real face arrival, Windows account behavior and signing authenticity remain unverified. Published npm `0.0.1` remains unchanged.

[Six-platform source CI 37898889595](https://github.com/lc-cn/qq-native-mirror/actions/runs/37898889595), commit `c178955115b37799c5145d9c8bf80fd9275b5210`, passed the six native runners and final Linux aggregate. Independent full-log inspection found seven actual installed-tarball consumer receipts with `faceContract:true`, correct device-only auxiliary selection, real native preparation/close, `faceDeliveryAttempted:false` and `loginAttempted:false`. macOS exposed 104 native exports; Linux/Windows exposed 98, with Windows on pinned Node 24.20.0. The aggregate passed 195 tests with zero failures. The compiled face checks use fake CLI dispatch; the real native preparation performs no login or message submission. The publish job was skipped. Private local receipts are `.local/research/qq-face-local-verified.json` and `qq-face-ci-verified.json`; these are build/source evidence, not a new public npm release or live face-delivery proof.

## Single-message lookup and checked reply source (unpublished source, 2026-10-09)

`getMessage(peer,messageId): Promise<Message | undefined>` reads one existing native message in a specified private/group conversation. `message --config FILE --kind private|group --target ID --message-id ID` exposes the same operation and prints JSON `null` for an absent message. Peer identifiers and message IDs must be decimal strings; no conversion through JavaScript numbers occurs. The public method and kernel validate inputs, with an owned query copy, before native invocation. Private QQ account numbers resolve to UIDs before calling `getMsgsByMsgId(nativePeer,[messageId])`.

The fixed NapCatQQ commit `26d7533e0f5800fdff865ab2f2ad7692917e1076` declares `getMsgsByMsgId` as `GeneralCallResult & {msgList:RawMessage[]}` ([service declaration](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/services/NodeIKernelMsgService.ts#L195), [caller](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/msg.ts#L55-L59), [result declaration](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/services/common.ts)). Downloaded bytes independently matched Git blobs `f2c646b6ded83fe665547bb4937e8de681a8ae7f`, `be65d9fb9df14088d742786c9e3b4f5136a29d38` and `c7c8e0abc6b5df3349991abf10e118b6aba0e161`. The result requires numeric success code zero; missing results, native rejection and malformed lists are errors. A successful empty list returns `undefined`. A nonempty single-query result must contain exactly one record with the requested message ID, chat type and resolved peer UID, and an array of native elements. Query failure retains its native code and does not retry. A query completed after Session close is rejected locally; this does not cancel a previously dispatched native read.

Reply construction now shares this lookup and rejects native failure or records from another conversation before constructing a reference. Its additional nonempty-string `msgSeq`, `senderUin` and `clientSeq` requirements apply only to replies; plain `getMessage` does not require optional native `clientSeq`. No identities or reply metadata are synthesized.

Fake service and public IPC regressions cover private/group resolution, IDs above the safe integer range, empty lists, code 23 preservation, missing success codes, malformed/duplicate/mismatched records, invalid inputs before lookup and close during a pending query. CLI preparation and offline installed-tarball checks cover the compiled lookup and public declaration. No account query, login, send or reply ran. This interface does not claim remote message recovery, complete retention, older-kernel behavior or real reply delivery. Published npm `0.0.1` is unchanged.

[Final source CI 37900671734](https://github.com/lc-cn/qq-native-mirror/actions/runs/37900671734), commit `00d94b7e7262347a1ed84c2eaa43d83923f6e8a9`, passed six native runner builds and the aggregate, with 215 regressions and no failures. Independent full-log inspection verified seven actual installed-tarball consumers: automatic device-only auxiliary selection, compiled single-message CLI/helper checks, 104 macOS or 98 Linux/Windows exports, real preparation/close, and no native account message query or login. Windows used Node 24.20.0. Publication was skipped. `.local/research/message-query-ci-verified.json` binds the receipts to this final source revision.

A separate real-account proposal was prepared for review before fresh human authorization: `scripts/verify-sdk-message-query.ts` defaults to review-only, checks a fixed plan hash, an installed unpublished SDK tarball plus 28 runtime JS hashes, and every file in the 46-path native candidate. The plan restores the previously paired macOS account once, reads at most one historical message in private conversation 8596238, and queries that same message ID once. It compares ID, sequence, timestamp, sender UID and peer; the receipt stores none of those values or message content. There is no send, recall, QR fallback or retry. An exclusive reservation prevents repeating an uncertain run. Stop signals block further reads after async receipt writes and produce an interrupted exit after closing. Native calls already dispatched can settle. Review mode and script type checks passed before any reservation or account receipt was created. This proposed login/read batch needs separate fresh human authorization, and signing authenticity remains unresolved. The script flag alone is not authorization. Plan SHA-256: `0a3973b6281fac282b0e0b11ffde28f14bdd132a4721158c0878b27883311824`; installed unpublished tarball SHA-256: `28260c399cf6c5bbaba4504602af1944ec4331e27260b662eec3742aa2ff02fa`.

After the user separately authorized exactly this read batch, the installed unpublished module completed its single reserved attempt on macOS arm64 / Node 24.19.0 / kernel 7.0.2-53644 with the 46-path pruned native bundle. Restore reached readiness, private history returned one record, and `getMessage` returned matching ID, sequence, timestamp, sender UID and peer. Close succeeded with no error or interruption. No send, recall, QR fallback or retry occurred. This is actual account evidence for native single-message lookup through an installed npm module, not only synthetic contract evidence. It does not establish remote retention, reply delivery, Linux/Windows account lookup or signing authenticity. The reserved marker remains and this batch must not run again. Private payload-free receipt: `.local/acceptance/message-query-v1/receipt.json`; independently checked summary: `.local/research/message-query-account-verified.json`.
