# README snapshot at f45f39a

This preserves source revision `f45f39a6c7b3c27610460c2bfc4427b16266212f`.
Claims, counts and CI links below describe their recorded cohorts, not later revisions.
Use the current [package guide](../../README.md) and [acceptance checklist](../sdk-acceptance.md).

# qq-native-client

TypeScript/npm QQ client SDK under development, using a QQ native kernel under ordinary Node.js. No QQ/Electron executable is launched. Native singletons run in an isolated **Node.js** child process owned by the module.

Real-account baseline: macOS arm64, Node 24.19.0, QQ native kernel 7.0.2-53644. Real wrapper loading (104 exports), QR generation, user-confirmed authentication and account Session readiness have passed. The installed npm tarball also passed a real mirror download and restored the authorized account from the independent native bundle. Linux 3.2.32-52194 arm64 also passed ordinary Node loading and QR generation through the public createClient API; Linux arm64 QR authentication and account Session readiness have since passed; Linux login restoration has failed and post-login read APIs remain unverified. See [Linux runtime evidence](../linux-runtime.md).

Platform evidence is specific to the tested native version; it is not a promise of complete compatibility.

| Platform / native version    | Installed Node preparation                                 | Account login / restore                                            | Account operations                                                                                                   |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| macOS arm64 / 7.0.2-53644    | Passed                                                     | QR and restore passed in prior account runs                        | Friends/groups/members/history and one authorized private text send/recall passed                                    |
| Linux arm64 / 3.2.32-52194   | Passed with current package                                | QR readiness passed; restore attempt failed                        | Post-login queries and messaging not verified                                                                        |
| Linux amd64 / 3.2.32-52194   | Passed on native x64 CI; account runs used amd64 emulation | QR authentication and Session readiness passed; restore unverified | Latest read-only run: 3 friends, 13 groups, first-group member response empty; completeness and messaging unverified |
| macOS x64 / 7.0.2-53644      | Passed on native x64 CI                                    | Not verified                                                       | Not verified                                                                                                         |
| Windows x64 / 9.9.33-52230   | Passed on native x64 CI, Node 24.20.0                      | Not verified                                                       | Not verified                                                                                                         |
| Windows arm64 / 9.9.33-52230 | Passed on native arm64 CI, Node 24.20.0                    | Not verified                                                       | Not verified                                                                                                         |

The six native platforms also passed installed-package and mirror-cache preparation/close with symlink creation denied in [CI run 37886708952](https://github.com/lc-cn/qq-native-mirror/actions/runs/37886708952). This initialization run made no account login attempt. All six public compressed mirror paths also passed fresh downloads, native preparation and second-pass zero-payload cache reuse in [CI run 37889421789](https://github.com/lc-cn/qq-native-mirror/actions/runs/37889421789). It used the fixed main candidate with optional native packages omitted and an explicitly configured download accelerator.

Security-signature authenticity remains unresolved on every platform. Quick login has a public implementation but lacks separate account acceptance; media, management and request handling require their own real-account acceptance. See [acceptance requirements](../sdk-acceptance.md).

Install the public [npm package](https://www.npmjs.com/package/qq-native-client):

```sh
npm install qq-native-client@0.0.1
```

The six optional native packages are published at the same version. Their official npm installation, automatic platform selection, preparation/close and explicit public mirror reuse passed on all six native platforms in [CI run 37893553033](https://github.com/lc-cn/qq-native-mirror/actions/runs/37893553033), without account login. npm selects the package for the current OS/architecture; local QQ installation, Docker and a supplied wrapper path are unnecessary. Windows currently requires official Node **24.20.0** exactly; macOS/Linux require Node 24 or later. Platform initialization support and real-account acceptance remain distinct, as shown above.

```ts
import { createClient } from 'qq-native-client';
import { writeFile } from 'node:fs/promises';

const client = await createClient({
  dataDir: '/path/to/my-account-data',
  login: { method: 'qr' },
  timeoutMs: 120_000,
});

client.on('qrcode', async ({ image, url }) => {
  await writeFile('./qrcode.png', image, { mode: 0o600 });
  // Show the image to the user, who confirms authorization on their phone.
});
client.on('authenticated', (identity) => {
  /* Account auth succeeded; session starts next. */
});
client.on('loginError', (error) => console.error(error.message));

try {
  const identity = await client.waitForLogin();
  // Resolves after the account Session reports readiness.
} finally {
  await client.close();
}
```

Omit `login` to prepare/load the native kernel only, then call `client.login({method:'qr'})` explicitly. To restore an account previously authorized in the same data directory, use `login: {method:'restore'}` (verified with a real macOS arm64 account; Linux restore has not passed). Restore without an account number requires exactly one eligible record; otherwise provide `uin`. `login: {method:'quick',uin:'...'}` explicitly requests native quick login. Password login is not implemented.

Login requests are copied when supplied. `method` must be `qr`, `quick` or `restore`; quick login requires a decimal-string `uin`, and restore accepts an optional decimal-string `uin`. Malformed requests reject before native preparation or account replacement. Concurrent calls for the same reconnect request share one promise; a different target rejects. Closing during reconnect waits for the worker's actual exit and prevents the replacement from starting authorization.

Quick/restore authentication must identify the account actually selected for the request; a mismatch rejects before its account Session is initialized. Identity events and returned account objects are copies. Once shutdown starts, late account events cannot move the client out of `closing` or restore its online identity.

A parent-side login timeout retires the worker and ignores late readiness. Retry with explicit `reconnect(...)`; it does not automatically repeat authorization. Account files are preserved. Business-operation timeouts report an unknown completion outcome and do not imply cancellation of the native mutation; never automatically replay a timed-out send or management action.

Worker failures reject with exported `KernelRequestError`: `operation` identifies the request, `code` preserves an explicitly supplied native/system code, and `originalName` preserves the worker error name. Errors without a supplied code leave it undefined. Arbitrary native objects, causes and stack traces are not copied through this error serializer. Error codes are not interpreted as detection or safe-retry signals.

## Native dependencies

The package includes our small N-API registration bridge. QQ native files are supplied separately and **are not included in this npm package**. Keep the kernel's dependent dylibs/frameworks at their original relative paths. Providing only wrapper.node is insufficient for the inspected macOS kernel.

Native files can be supplied by a complete mirror manifest:

```ts
const client = await createClient({
  manifestUrl: 'https://your-mirror.example/qq/macos-arm64/manifest.json',
  manifestSha256: '...trusted 64-character SHA-256 digest...',
  cacheDir: '/path/to/native-cache',
  dataDir: '/path/to/account-data',
  login: { method: 'qr' },
});
```

The manifest contains kernel version metadata, platform/architecture and a list of every native dependency. Files download individually, preserving nested framework directories. Relative URLs resolve against the manifest URL. The manifest and each file require SHA-256 verification; cached files are revalidated. HTTPS is required except for localhost development. The default public mirror is hosted at [lc-cn/qq-native-mirror](https://github.com/lc-cn/qq-native-mirror).

```json
{
  "schemaVersion": 1,
  "id": "qq-7.0.2-53644-darwin-arm64",
  "platform": "darwin",
  "arch": "arm64",
  "wrapper": "wrapper.node",
  "version": {
    "clientVersion": "7.0.2-53644",
    "appId": "537391652",
    "qua": "V1_MAC_7.0.2-53644_53644_GW_B"
  },
  "files": [{ "path": "wrapper.node", "url": "wrapper.node", "sha256": "..." }]
}
```

The abbreviated example must be extended with all dependent native files. See `scripts/export-local-native.ts` for exporting a local dependency bundle for research/mirror preparation. Exported binaries stay in `.local` and are excluded from npm packaging.

## Development

```sh
npm install
npm run build
npm test
node scripts/probe-native.ts
node dist/cli.js --help
```

Local bridge builds on macOS/Linux require clang/cc and Node C headers. Set `QQ_NODE_INCLUDE` if the headers are not in the normal Node install locations. On Windows, use `npm exec tsc`; GitHub CI builds the pinned-runtime DLL with MSVC. Packaged consumers use prebuilt platform packages and need no compiler.

The native probe selects an installed auxiliary package or a verified mirror bundle by default, loads it in a separate process, and lists exports without account initialization or login. `--addon` selects an explicit native file. Use the public CLI for configuration and explicit QR login; `--help` performs no account operation.

Native files execute native code; SHA-256 establishes correspondence to a trusted package, not that an arbitrary mirror is trustworthy. Treat login images and account directories as private. The macOS kernel queries Disk Arbitration during initialization: a restrictive sandbox can produce an upstream CFRelease(NULL) crash. The module reports worker termination; it does not suppress the native error or invent hardware data.

Preserve original native filenames and dependency layout when building bundles. Static inspection of the pinned Linux arm64 signing provider found a caller-image path substring check for `wrapper.node`; matching bytes alone do not establish equivalent loading context. The SDK's exporters preserve that vendor filename. This observation does not prove signing authenticity or identify a fake-sign marker; see [signing investigation](../signing-integrity.md).

## Status and limitations

- Implemented: local native loading, mirror download/cache, registration bridge, QR/quick/restore login adapters, Session readiness lifecycle, explicit close and native crash isolation.
- Verified with real native kernel: loading, QR authentication, account Session readiness and restoration using a standalone native package.
- Verified packaged consumer path: npm tarball installation, import by package name, 1157 localhost mirror requests (manifest plus 1156 native files), SHA-256 validation, restored account readiness.
- The public GitHub mirror covers all six devices. Public compressed mirror cold preparation passed on all six native runners; implicit default-catalog selection and cache reuse also passed on all six native runners in [CI run 37890258044](https://github.com/lc-cn/qq-native-mirror/actions/runs/37890258044), with a configured accelerator and no account login.
- Public APIs now include friend/group/member queries, text and group mention sending, history, recall and message events. Real macOS account testing has verified friend queries and incoming message callbacks; group/member/history queries and explicit private text sending/recall have also passed real account checks; the user confirmed seeing the message or recall notice.
- Image/reply/file/video/record sending and attachment downloading are implemented. A macOS media batch returned native send/recall acknowledgements for image, voice and video; the peer confirmed two recall notices and the file attachment, without identifying each media item. File recall remained unsuccessful, with a separate diagnostic returning `-7003`. Complete media-delivery acceptance and oicq-like capability parity remain unfinished; see [file recall evidence](../file-recall-investigation.md). Video preparation and built-in WAV/SILK conversion also have local verification.
- See [SDK acceptance criteria](../sdk-acceptance.md) for the full project scope. Login success is not the SDK completion criterion.
- Main npm package name: `qq-native-client`; initial release version: `0.0.1`. The six native auxiliary packages use the same release version.
- Working source is the `0.0.2` candidate with six matching auxiliary version pins. Public npm remains `0.0.1` until a separately reviewed local release. See [candidate preparation and evidence binding](../npm-first-publish.md#002-候选准备); newer query/event contracts below remain unpublished.

See [research](../../RESEARCH.md), [registration bridge](../../native/README.md), [login contract](../login-contract.md), and [Session creation/startup](../session-strategy.md).

Group notices use `publishGroupNotice(groupId, text, { imagePath?, pinned?, confirmRequired? })` and `deleteGroupNotice(groupId, noticeId)`. CLI commands are `group-notice-publish` and `group-notice-delete`. Images require a local file; account tickets stay inside the worker. Publication checks the native result, while a void deletion return means dispatch only. `listGroupNotices(groupId)` (`group-notices` CLI) uses a native ticket plus Node HTTP and returns `{notices,raw}`. It uses the fixed upstream list request and does not guarantee complete pagination. Native bulletin-list callbacks remain unresolved; this HTTP implementation is explicitly a separate path. All notice operations have contract tests but no real account acceptance yet.

Unpublished working source corrects group mutation returns: `setGroupAdmin`, `setGroupMemberCard`, `kickGroupMember` and `leaveGroup` accept the pinned native void return as submission only; completion does not confirm permission or remote group state. Group name and mute changes still require native `result: 0`. Explicit rejection codes are preserved, and the SDK does not retry these operations. This correction has synthetic contract coverage; no real group was changed.

Working source adds `setGroupEssenceMessage(groupId, messageId, enabled)` and CLI `group-essence`. The SDK resolves the exact group message, derives native sequence/random fields, invokes add/remove once and requires both native status layers to be numeric zero. This acknowledges the native return and does not confirm remote state. [Contracts and limits](../contacts-groups.md#group-essence-messages) include actual Linux/macOS ARM64 codec inspection and controlled tests; real group mutation acceptance, essence listing and events remain pending.

Unpublished `getGroupMembers` also checks native `errCode: 0` and `finish: true` before returning the member Map as an array. Errors and incomplete responses reject instead of appearing as an empty or complete list. A successful completed empty list remains `[]`. Member account numbers, matching Map/member UIDs, nickname/card strings and numeric membership roles are also validated before the complete batch updates the UID cache. These corrections have synthetic coverage and have not rerun the previously empty Linux account query.

Unpublished source adds `group-list-updated` (`kind`, `groups`) and `group-members-updated` (`groupId`, `source`, `members`) events from the pinned native metadata callbacks. They can arrive during startup, queries or synchronization; they do not classify member join/leave causes or guarantee unique live delivery. Optional fields remain absent when native data does not supply them. `qq-native-client watch --config ./qq.json --events all` prints business events as `{event,payload}` JSON lines. Default `watch` still prints only message JSON. Native-account observation of the new callbacks remains unverified.

Unpublished `friend-list-updated` provides categorized Buddy metadata: `{categories:[{categoryId,name,memberCount,friends:[{uid,userId,nickname,remark?}]}]}`. It reuses the existing Buddy listener and does not initiate a query. Missing remarks remain absent, and native counts are preserved. The notification has no completeness or add/remove marker; it is not treated as a complete friend snapshot or a relationship-change notice. V2/detail/nickname/remark callbacks still have unknown native payloads and are not projected. CLI `watch --events all` includes this event alongside messages, recalls, friend/group requests and group metadata. Synthetic callback, installed-package, request-isolation and close tests pass; real callback delivery remains unverified.

Unpublished source adds `message.recalled` with typed `MessageRecall`: `{peer,messageId,sequence,recallTime}`. IDs, sequence and the native recall timestamp remain exact decimal strings; the timestamp unit and operator are unverified. This is a passive metadata update that may arrive during synchronization. It preserves no raw payload, uses a bounded 10,000-entry per-Session replay window, and stops after close. The existing raw `message-recalled` event remains available. `watch --events normalized` uses seven business-event envelopes, substituting this typed recall event for the legacy raw event; `message` and `all` modes keep their prior behavior. Compiled synthetic callback/CLI tests pass; real delivery of this new projection remains unverified.

Unpublished source now resolves received UID-only mentions through the native `UixConvert.getUin` map in live messages, `getMessage`, history and merged-history reads. Positive decimal IDs retain their exact strings; signed int32 mention IDs convert without Number precision loss. Unsupported mention kinds and failed mappings retain the native element as `unknown` instead of inventing `0`/`undefined` targets or ordinary text. A callback batch uses one deduplicated UID query with a ten-second deadline; live deliveries keep batch/callback order, replays avoid another query, and close cancels waiting without another lookup. Routing/mention fields are captured before the await. Synthetic compiled checks pass; real UID-only mention observation remains unverified.

Unpublished sending now validates and captures the complete element batch before recipient/mention UID lookup, reply queries or media staging. Sparse batches and malformed later elements reject before preparation. A send requires both native acceptance and a matching successful callback; receipt IDs remain exact decimal strings and time must convert safely. The deadline and close signal remain active until both conditions finish, including when callback success precedes a stalled native return. Duplicate native correlation IDs reject before another submission. A timeout or close after submission can leave delivery unknown; the SDK does not retry automatically. These changes have synthetic installed-consumer evidence; earlier real sends used older SDK revisions.

Unpublished receiving and history reads now validate message metadata and resolve missing private-peer/sender QQ numbers from the exact native UID map, sharing one deduplicated lookup with mentions. Group numbers and existing valid QQ numbers do not need conversion. Required identity failures reject queried results; live failures emit bounded diagnostics while valid neighboring messages continue. Captured routing, IDs and media paths remain stable during lookups; unknown elements and `raw` retain original evidence. Real account identity conversion on this revision is still unverified.

Unpublished `getMessages(peer, ids)` queries 1–100 unique numeric-string IDs in one native call. The returned array follows requested order; an ID absent from the successful response has an explicit `undefined` slot. This is SDK alignment policy, not proof of remote deletion or native ordering. Input is captured before asynchronous work; malformed results, duplicate/unrequested IDs and mismatched conversations reject the whole batch. Closing rejects late results without retry. CLI `messages --config qq.json --kind private --target 8596238 --message-ids ID,ID` emits `null` for missing slots. Batch lookup has offline contract coverage; the earlier real single-message receipt does not validate this new operation.

Unpublished `getHistory()` requires native success and validates the complete response's message IDs/conversation/elements. Successful empty histories remain `[]`, native ordering is preserved, and closing rejects a pending history result. History and single-message queries reject sparse element arrays. These corrections have synthetic installed-package coverage; earlier account receipts apply to their recorded revisions.

Unpublished `listGroups()` validates complete callback records, including sparse-array rejection, decimal-string IDs, names and nonnegative safe integer counts. Malformed complete results reject and retire the Session's uncorrelated list query. Empty lists and long IDs remain supported; partial metadata events keep their separate contract. This has synthetic coverage, with new real-account validation pending.

Unpublished `listFriends()` now requires native `getBuddyListV2` success (`result: 0`) before reading profiles. A failed response with empty data rejects instead of appearing as a successful empty list; explicit rejection codes are preserved. Missing or invalid result codes also reject, without profile reads or retries. Sparse category/UID arrays also reject before profile lookup, and a later invalid profile cannot leave partial UID cache entries. Required profile UID/UIN/remark fields must already be strings, the profile UID must match the requested UID, and optional nicknames cannot have another type. These corrections have synthetic installed-package coverage and have not repeated real account queries.

`setNickname(name)` (`nickname --name TEXT` CLI) changes the current account nickname. Unpublished working source also provides `setSignature(text)` and `signature --config FILE --text TEXT` for the account's personal signature text; `--text ''` explicitly clears it. Each update first reads the current profile and preserves the other field, sex and birthday in the native payload. Missing preservation fields reject; query failure invalidates further self-profile queries until Session recreation. Close/disconnect cancels pending lookup. These are contract-tested interfaces; no real profile was changed. Personal signature text is separate from the unresolved native security-signing mechanism.

Multi-version preparation: [architecture and mirror plan](../multi-version-and-mirror.md), [macOS samples](../version-research-macos.md), and [Windows/Linux samples](../version-research-platforms.md). These reports distinguish static inspection from actual runtime support; the future catalog/driver schema is a design, not a replacement for the current v1 API.

## Client APIs and CLI

Call read/send APIs after `await client.login(...)`. `client.state` reports idle, connecting, online, disconnected, closing, closed or failed. `client.account` is available while online. A native worker crash rejects outstanding requests and emits `terminated`; an intentional close does not report a crash.

```ts
const friends = await client.listFriends();
const groups = await client.listGroups();
// Unpublished source: find one message in a specific conversation (undefined if absent).
// const message = await client.getMessage({ type: 'group', groupId }, messageId);
client.on('message.private', (message) => {
  /* incoming private message */
});
client.on('message.group', (message) => {
  /* incoming group message */
});
// These methods send only when explicitly called by your application:
// await client.sendPrivateMessage(userId, 'hello');
// await client.sendGroupMessage(groupId, [{ type: 'text', text: 'hello' }]);
// Unpublished source also supports standard QQ faces in mixed messages:
// await client.sendPrivateMessage(userId, [{ type: 'text', text: 'hello' }, { type: 'face', id: 14 }]);
```

The working source accepts `{type:'face',id:number}` for private/group sends and CLI `--message-file` JSON. It bundles 329 known IDs in an 8 KB metadata table, including classic, extended and animated faces. Unknown or invalid IDs reject before message submission. This addition is not in the published `0.0.1`; it has local contract verification only until a separately authorized account send confirms delivery. Dice and rock-paper-scissors use their standard face metadata, without a requested outcome. [Pinned contract and evidence](../acceptance-history.md#standard-qq-face-sending-unpublished-source-2026-10-09).

Working source also provides `getMessage(peer,messageId)` and `message --config FILE --kind private|group --target ID --message-id ID`. IDs remain decimal strings, including values beyond JavaScript's safe integer range. The API returns `undefined` only for a successful empty query; the CLI prints `null`. Native errors and malformed or wrong-conversation records reject. Reply construction uses the same checked lookup. This unpublished addition passed contract/packaging checks and a separately authorized macOS arm64 installed-consumer account test: restore, one historical message and an exact single-message lookup all succeeded. Reply delivery and other platforms' account queries remain unverified.

The npm package exposes the `qq-native-client` executable. `--help` lists configuration, login, contacts, groups, members, history, watch and explicit send commands. Configuration creation does not overwrite existing files. CLI read commands restore prior authorization; QR login is explicit. `watch` prints incoming message JSON and keeps the client running until a termination signal.

`scripts/verify-sdk-readonly.ts` exercises an already authorized account without sending or changing groups. It saves capability flags and counts, never contact identifiers or message bodies. A successful observation window without messages is not evidence that reception works.

## Signing investigation priority

Native security signing authenticity remains unverified. Functional login and message acknowledgements do not establish signing integrity or long-term account safety. See [signing integrity](../signing-integrity.md) and [community evidence](../signing-community-evidence.md). The SDK does not fabricate security signatures or replace detector results.

Group applications and invitations are available through `listGroupRequests({ doubt?, limit?, before? })`, which returns `{ requests, next }`, and the `request.group` event. Types distinguish invitation (1), invitation requiring administrator approval (5), and join application (7). `handleGroupRequest(request, accept, reason?)` is explicit; its completion means native dispatch, not confirmed approval. CLI equivalents are `group-requests` and `group-request`. A failed list query invalidates that Session's query channel to avoid assigning a delayed result to a later page; reconnect explicitly before querying again. These operations have local contract tests; real-account approval has not been tested.

`rememberPassword?: boolean` explicitly applies the native password-retention setting before connecting; omission preserves the native default. It does not guarantee QR account restoration. Each worker owns a data-directory lock, so separate clients require separate data directories. `nativeCallbackAudit` contains bounded callback names, argument types and counts from initialization, without argument payloads.

Local MP4 video input uses `{ type: 'video', file: '/absolute/video.mp4' }`. Set `videoCodecPath: '/absolute/video-codec.node'` (or a local JS module) to obtain measured metadata and a thumbnail inside ordinary Node without external FFmpeg executables. The module must export `getVideoInfo(filePath)` returning `{ width, height, duration, format, image }`; `duration` is seconds, `format` describes the thumbnail (`jpg`, `jpeg`, `png`, `bmp`, or `bmp24`), and `image` is a Buffer. An explicit codec takes precedence over `mediaTools`; its errors never trigger a CLI fallback. Without a codec, the existing explicit `mediaTools: { ffmpeg: '/absolute/ffmpeg', ffprobe: '/absolute/ffprobe' }` path remains available. A native bundle may declare `videoCodec` in its verified manifest; `createClient` then selects the included component automatically. `videoCodecPath` overrides that selection; explicitly configured `mediaTools` also take precedence over a bundle default. The current npm 0.0.1 bundles do not include it; the 0.0.2 source producer now builds codec-bearing candidates. External executables are not downloaded automatically. See [video codec contract](../video-codec.md) for validation and lifecycle, and [source-built codec](../video-native-source.md) for the owned native producer and evidence limits.

`downloadAttachment(peer, messageId, elementId, destination)` captures inputs before UID resolution, checks both native completion codes, and exclusively publishes the returned local/cache file. [Download contract and acceptance limits](../attachment-download.md).

`getForwardMessages(peer, rootMessageId, parentMessageId?)` reads an existing merged-forward message using exact native IDs. `forwardMessages(source, destination, messageIds)` submits existing messages for native forwarding. Both use exact existing native messages. CLI equivalents are forward-history and forward. The unpublished source also provides `sendMergedForward(peer, nodes, options?)` and `send-forward` to compose explicit text author/time nodes. It validates the entire input before upload, uploads once, then submits one ARK card through the normal checked send path. Its receipt includes the uploaded `resourceId`. Failures retain partial progress and never retry automatically. Media and nested nodes are unsupported. [Public contract, CLI example and evidence limits](../merged-forward.md). First-level reads default parentMessageId to rootMessageId. Received ARK/MULTIFORWARD cards expose receive-only resource references and previews across events and message queries; normalization does not fetch their contents. [Received-card contract](../received-forward.md). The unpublished `getForwardResource(resourceId)` / `forward-resource` reads an explicit resource through one bounded SSO request and returns observed records (text, reserve mentions and standard/extended faces) plus opaque bytes, without synthetic native message identities or implicit media/nested fetches. [Resource reader](../forward-resource-decoding.md). All three operations still require native-account acceptance.

Local voice input uses `{ type: 'record', file: '/absolute/audio-file' }`. By default the built-in silk-wasm 3.7.1 codec accepts supported PCM16 WAV and Tencent SILK, validates frame boundaries, decodes to verify actual duration, and rejects files over 32 MiB or audio over 300 seconds. An optional `recordCodecPath: '/absolute/codec-module.mjs'` overrides it. The explicitly supplied module must export `getDuration(filePath): Promise<number>` in seconds; non-SILK inputs also require `convertToNTSilkTct(inputPath, outputPath): Promise<void>`. Named exports or a default codec object are accepted. The worker loads this module as executable consumer-supplied code; no codec is downloaded automatically. Outgoing SILK headers and measured duration are validated before native staging. WAV/PCM cannot be relabeled as SILK. Real local WAV→SILK→PCM conversion and message preparation are verified; QQ voice upload and peer receipt remain unverified.

Current unpublished source fixes history input capture, pending read shutdown, online identity returned by `waitForLogin()`, object-form CLI watch reconnect policy, and npm CLI symlink startup. [Lifecycle contracts and evidence limits](../history-lifecycle.md).

Current source also rejects missing or mismatched native identities in profile queries and validates entire group-request notification batches before emitting events. [Contact/group query contracts](../contact-group-query.md) record the installed-package checks and their account/CI limits. These later fixes are not present in the original `npm-v0.0.2-ci-38005239931` archive.

Default native selection: `createClient({dataDir:'/account'})` first uses the matching-device auxiliary package installed by npm, after checking its manifest and every native file. Without that package, it resolves the latest numeric client version matching `process.platform` and `process.arch` through the GitHub catalog. Supplying a different full `version` selects that version through the catalog; an explicit `catalogUrl` also bypasses installed auxiliary selection. A valid installed auxiliary pins the kernel version and does not trigger a catalog update check. `catalogUrl` can override the HTTPS catalog. Explicit `manifestUrl` still requires `manifestSha256`. Local `wrapperPath` may omit `version` when its adjacent schema-1 manifest matches the current device and wrapper. The default GitHub mirror is published at https://github.com/lc-cn/qq-native-mirror; the accelerated default catalog path has passed installed-consumer initialization with cached contents; cold direct GitHub download terminated with TimeoutError; cold accelerated default download passed in 304 seconds. The installer uses four bounded downloads and downloads identical SHA-256 contents once, preserving every path with hardlinks. Catalog trust does not establish vendor signature authenticity.

For GitHub download acceleration, supply trusted proxy prefixes in order:

```ts
const client = await createClient({
  dataDir: './account',
  downloadMirrors: ['https://gh-proxy.com/'],
});
```

Each prefix is prepended to the original native file URL. A failed download or SHA-256 mismatch tries the next prefix, then the original URL. Catalog and manifest requests still use their original addresses. Completed content is cached by SHA-256 and reused after interrupted installations; partial individual files are not resumed. Prefixes must use HTTPS, end in `/`, and contain no credentials, query or fragment. At most eight are accepted. No third-party accelerator is enabled by default.

The installed CLI can generate a default-catalog configuration without a local QQ installation or manually entered version metadata:

```sh
qq-native-client init --config ./qq.json --data-dir ./account --download-mirror https://gh-proxy.com/
qq-native-client config --config ./qq.json
qq-native-client login --config ./qq.json --method qr --qr-file ./qrcode.png
```

`init` and `config` are local-only and do not load native code or log in. `login` downloads the selected native package and starts an explicit QR login. Omit `--download-mirror` for direct downloads; `--catalog` selects a custom HTTPS catalog. A local `--wrapper` may omit version metadata when an adjacent trusted manifest supplies it. When specifying version fields manually, supply all three: `--client-version`, `--app-id`, and `--qua`. Existing config files are never overwritten by `init`.

Mirror manifests optionally support gzip transport: each compressed entry adds `encoding: "gzip"` and `downloadSha256` while keeping `sha256` bound to the original runtime bytes. The installer checks both hashes and limits decompression size. Existing raw-file mirrors continue to work. See [bundle reduction evidence](../native-size-reduction.md).

A separate compressed native catalog is available for explicit opt-in with the current SDK:

```ts
const client = await createClient({
  dataDir: './account',
  catalogUrl: 'https://raw.githubusercontent.com/lc-cn/qq-native-mirror/main/catalog-gzip-v1.json',
  downloadMirrors: ['https://gh-proxy.com/'],
});
```

The legacy opt-in catalog covers macOS arm64 and Linux x64/arm64 and remains available. The current default catalog covers all six devices with verified compressed native files and the owned video codec. The unpublished 0.0.2 main passed actual default selection, cold initialization/close, three video decodes and zero-payload cache reuse on all six targets in [CI 37969129032](https://github.com/lc-cn/qq-native-mirror/actions/runs/37969129032). Published 0.0.1 auxiliary packages retain their original codec-free bytes. A SHA-named complete [previous catalog](https://raw.githubusercontent.com/lc-cn/qq-native-mirror/main/catalog-backups/29fd6b763a1323ddcb9a71b1b369188fdc2bf8d7bc4133c19dcc41de8bd60ee7.json) is available for explicit rollback. See [bound evidence](../evidence/codec-default-ci-37969129032.json).

### 分平台 npm 原生包

主包使用固定版本的 optionalDependencies，覆盖 `qq-native-client-{darwin,linux,win32}-{x64,arm64}` 六个辅包。npm 根据 os/cpu（Linux 还要求 glibc）安装对应辅包；无需 postinstall 脚本。默认 createClient 优先加载辅包，每个原生文件通过 SHA-256 校验。显式 wrapperPath、manifestUrl 或 catalogUrl 优先；指定不同内核版本或省略 optional dependencies 时，仍使用镜像目录下载。

内核版本写在辅包 manifest 中，npm 包版本独立管理。更新主包时固定辅包版本，避免同一主包在不同时间安装到不同内核。完整目标为 Windows/Linux/macOS × x64/arm64，共六个辅包。GitHub Actions 在各架构 runner 上构建注册适配层、校验并打包厂商内核，再进行无账号消费者初始化；缺少素材或验证失败的平台不发布占位包。六个平台已通过安装主包、自动选择辅包、初始化与关闭的 CI 验收。Windows 当前要求官方 Node `24.20.0`，并校验运行时配置；Windows 账号登录及业务 API 尚未实测。

首发使用 GitHub Actions 在六个平台验收通过后汇总的 `npm-release` 产物：本地验证并依次发布六个辅包和主包，由维护者完成 npm 登录与发布验证。首发完成后再为七个包配置 Trusted Publisher。详见 [本地首发流程](../npm-first-publish.md)。

Working source now adds `listFriendCategories()`, `setGroupRemark(groupId, remark)` and `group-info-updated`, with CLI commands and complete worker routing. [Friend/category/group coverage](../contacts-groups.md) records the remaining action and event contracts. These additions postdate source `a0b879e` and are not covered by its six-platform CI or the published `0.0.1`.

Working-source group additions include `getGroupInfo(groupId)` and `group-membership` with finite known classification, raw unknown codes and optional native UIDs. CLI adds `group-info`; normalized/all watch includes membership events. See [friends and groups coverage](../contacts-groups.md) for source-backed contracts, 628 local regressions and the installed-consumer evidence limits. These additions are not published `0.0.1` features.

Working source also exposes `group-admin` and `group-mute` events plus `listGroupMutedMembers(groupId)`/CLI `group-muted`. These use explicit native branches and gray-tip enums, retain seconds as strings and preserve the mute list's opaque native time. The [coverage and evidence](../contacts-groups.md) distinguish 641 local regressions/installed-consumer checks from live account delivery.

The next candidate also exposes `addFriendCategory(name)` and CLI `friend-category-add`, using six independently inspected default binary profiles. Unknown binaries reject before dispatch. See [category contract and coverage](../contacts-groups.md) for the version matrix and the distinction between local tests, native ABI inspection and real account acceptance.

Working source adds `friend-added` with `{uid,messageId,userId?}` from the explicit private gray-tip branch. Native account IDs stay strings; no identity lookup or operation cause is inferred. Cached/offline notices are delivered, with bounded Session deduplication and close suppression. [Contracts and evidence](../contacts-groups.md) record 666 regressions and installed-consumer verification; real native event delivery remains unverified.

## 开发与架构

模块职责、依赖方向、原生边界和生命周期约束见 [架构说明](../architecture.md)。
维护时使用 Node 24 和 npm：`npm ci --ignore-scripts`，修改后执行 `npm run format` 与
`npm run check`。门禁包含格式、零 warning lint、源码与测试类型检查、确定性回归、
清理旧产物后的构建，以及新打包安装的消费者验证。账号验收独立进行。

Working source exposes `deleteGroupFolder(groupId, folderId)` and CLI
`group-folder-delete --config ./qq.json --group-id 123456 --folder-id opaque-folder-id`.
The method preserves an opaque folder ID and acknowledges only a native response
with two explicit zero status fields. [Contract and limits](../contacts-groups.md#group-file-folder-deletion)
bind the six inspected default binaries; real remote deletion remains unverified.
