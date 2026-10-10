# QQ native SDK capability and acceptance checklist

The target is a complete ordinary-Node TypeScript/npm QQ client for account
lifecycle, contacts, groups, messaging, media, management and CLI use. Consumers
must not need an installed QQ application, Electron, a UI or Docker. Completion
requires the entire capability and platform matrix below.

## Evidence levels

- **Implemented**: the public method/event, IPC routing and native adaptation exist.
- **Controlled-tested**: deterministic services or workers verify SDK contracts.
- **Packaged-tested**: a real packed and installed consumer verifies files,
  imports, declarations, CLI and controlled contracts.
- **Native-runtime-tested**: actual native code initializes or runs a codec on the
  specified OS, architecture, Node version and bundle; an account is not required.
- **Native-account-tested**: a separately authorized account operation produces
  the intended server/client outcome, with peer confirmation where required.

Each result records source revision, package/bundle digest, platform, architecture,
Node/native version, operation and proof level. Keep credentials, complete contact
or message data, account directories and login images private.

## Required capabilities

| Capability                 | Public surface / intended behavior                                                               | Real acceptance standard                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native preparation         | `createClient(options)` with local bundle or manifest/digest                                     | Clean consumer loads bundle without launching QQ/Electron; missing dependency and incompatible registration fail clearly                                                        |
| Mirror/cache               | Trusted manifest and per-file SHA-256; relative dependency paths                                 | Fresh fetch, valid cache reuse, corruption repair, four separate process contenders, dead installation owner recovery                                                           |
| QR login                   | `login({method:'qr'})`, `qrcode`, `authenticated`, `ready`                                       | User scans generated image; readiness comes only after account Session initialization                                                                                           |
| Account restore            | `login({method:'restore',uin?})`                                                                 | Restart Node with same data directory and regain ready Session; ambiguous records require explicit account                                                                      |
| Quick login                | `login({method:'quick',uin})`                                                                    | Explicit account reaches readiness; expiry/error yields actionable failure                                                                                                      |
| Lifecycle                  | `close()`, disconnect/logout/termination events                                                  | Native worker exits on close; pending requests fail on crash; shutdown does not erase account credentials                                                                       |
| Friend list                | `listFriends()`                                                                                  | Authorized account returns identifiable friends; empty list remains distinguishable from operation failure                                                                      |
| Group list                 | `listGroups()`                                                                                   | Authorized account returns joined groups with consistent IDs and names                                                                                                          |
| Group members              | `getGroupMembers(groupId)`                                                                       | Known group returns matching membership, handles paging/completion and rejects unavailable group                                                                                |
| Incoming messages          | `message` event and normalized elements                                                          | Explicitly authorized peer sends private and group messages; SDK emits sender, target, message ID, time and content; history/local notifications do not duplicate live delivery |
| Private send               | `sendPrivateMessage(userId,message)`                                                             | Explicit human instruction names recipient and content; successful native result and peer receipt agree                                                                         |
| Group send                 | `sendGroupMessage(groupId,message)`                                                              | Explicit human instruction names group and content; successful native result and visible receipt agree                                                                          |
| Text / mention             | String or text/at elements                                                                       | Plain text and group mention preserve order, Unicode, target and returned message identifiers                                                                                   |
| Image / reply              | Image/reply elements                                                                             | Local image is uploaded and visible; reply references the actual originating message; invalid paths/IDs reject clearly                                                          |
| History                    | `getHistory(...)`                                                                                | Retrieve known messages with bounded limit/cursor; stable order, target and pagination; no invented placeholder records                                                         |
| Recall                     | `recallMessage(...)`                                                                             | Explicitly authorized recall removes a known own message; permission/time-window failures surface                                                                               |
| Files and rich content     | File/audio/video/forward elements or dedicated APIs                                              | Upload/download can be checked against hashes; type-specific metadata and native error behavior verified individually                                                           |
| Group management           | Mute, kick, settings and notices as explicit methods                                             | Only explicit human-authorized actions; permission errors are surfaced; never exercised automatically by smoke tests                                                            |
| Friend/group requests      | Request events and explicit accept/reject methods                                                | Real pending request reaches SDK; chosen action matches explicit authorization; no implicit approval                                                                            |
| Profile/contact operations | Profile lookup, nickname/card changes, relationship actions                                      | Read APIs agree with account; mutations separately authorized and verified                                                                                                      |
| Multi-account              | Separate clients and data directories                                                            | Two authorized accounts run concurrently with isolated sessions/events/cache; no credentials cross account boundary                                                             |
| Native security signing    | Authentic provider initialization, explicit missing-environment failures, preserved kick reasons | Vendor provenance and provider/host contract demonstrated separately from login success; no fabricated signatures, success responses or detector outcomes                       |
| Version/platform drivers   | Compatibility declaration and driver selection                                                   | Each declared kernel/platform loads, logs in and repeats message/contact acceptance; static export inspection is insufficient                                                   |

The complete target also includes category delete/rename/reorder/member moves and
the remaining friend/group actions and events in [contacts and groups](contacts-groups.md).
The smaller implemented API surface does not reduce these requirements.

## Source and package baseline

Architecture revision `9ab5949` passed 753 deterministic tests, formatting,
zero-warning lint, strict source/test typing, a clean build and an actual
packed/installed consumer. Its [SDK quality CI](https://github.com/lc-cn/qq-native-mirror/actions/runs/38030149184)
passed. The independent local candidate contained 144 emitted files matching both
the archive and installed tree. These checks used no QQ account; this working
`0.0.2` candidate has not been published to npm.

Earlier revision `e5d840a` passed [six-platform CI](https://github.com/lc-cn/qq-native-mirror/actions/runs/38026966907).
The [bounded actual-artifact audit](evidence/architecture-native-ci-38026966907.json)
matched 134 emitted files to that revision, bound seven consumer receipts and six
video reports with three inputs each, and checked six prepare/close receipts
without login. It did not read all six auxiliary tarballs, re-read remote native
caches, verify the complete ZIP digest or establish account business behavior.
Newer revisions require their own native artifact audit.

The published npm `0.0.1`, working `0.0.2` candidate and each native mirror are
separate artifacts. Push builds do not publish npm releases. See [first publication
and trusted publishing](npm-first-publish.md).

## Capability gaps and next acceptance

| Area               | Implemented contract                                                                                                                                                     | Remaining requirements                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native delivery    | Six OS/architecture auxiliary packages; local bundle, installed auxiliary and catalog/manifest paths                                                                     | Current-candidate installation/runtime acceptance on every declared platform/version; retain complete-bundle fallback alongside pruned bundles                     |
| Default selection  | Compatible installed auxiliary first; otherwise numeric latest catalog version for the actual device; explicit catalog bypasses installed selection                      | Independent version-specific consumer/server evidence; [mirror design](multi-version-and-mirror.md)                                                                |
| Account lifecycle  | QR, restore, quick login, readiness, restart, close and explicit reconnect policy                                                                                        | Current-source account acceptance, quick login, concurrent two-account acceptance and unverified platform/version account cells                                    |
| Messaging          | Text/face/media inputs, reception, bounded replay handling, history, lookups, recall and forwarding                                                                      | Current private/group delivery, rich-content download/hash checks, group sends and unresolved [file recall](file-recall-investigation.md)                          |
| Friends/categories | Reads, remarks, deletion, request handling, empty category creation and list/add notifications                                                                           | Category rename/delete/reorder/member moves and friend applications; connect mutation selectors to list/create identifiers before exposing them                    |
| Groups             | Reads, membership/admin/mute metadata, bounded requests, explicit management/notices and essence add/remove with two-layer acknowledgement and HTTP pages/full traversal | Create/search/join/invite, titles, live essence pagination and add/remove events, group files, remaining event classification and real mutation/request acceptance |
| Security signing   | Native provenance and bounded host/provider investigation                                                                                                                | Authentic provider/host contract and unresolved detection propagation; login does not establish signature authenticity                                             |
| Architecture/CLI   | Owned lifetimes, typed operation vocabulary, dependency gates, planning before native work, watch before login and teardown                                              | Preserve these contracts while implementing all remaining client capabilities; [architecture](architecture.md)                                                     |

Detailed limitations in [contacts and groups](contacts-groups.md),
[signing integrity](signing-integrity.md), [Linux runtime](linux-runtime.md) and
[multi-version research](multi-version-and-mirror.md) remain part of the full
target. They are not exclusions from completion.

## Account and platform baseline

Historical macOS arm64 evidence covers QR/readiness, restore, contacts/groups,
bounded history, reception and authorized private send/recall. Linux arm64 and
x64 have version-specific QR/readiness evidence; their read/restore outcomes
differ. Windows and macOS x64 account business behavior is unverified. See the
[README platform matrix](../README.md) and [historical records](acceptance-history.md).
These results do not establish current-source or cross-platform account support.
Signing authenticity remains unresolved on every platform.

A new account validation names the immutable candidate, bundle/version,
account/data directory, bounded operations and intended peer/group where relevant.
Historical batches do not authorize a new login, restore, send or modification.
Mutations need explicit scope and appropriate receipt/readback. Uncertain remote
outcomes remain uncertain and are not automatically retried.

## CLI contract

`src/cli.ts` retains the executable path, help and configuration. The command
planner validates flags and captures message/file inputs before client creation.
Account commands await their selected login; QR is used only when requested.
Watches attach before login. Execution owns QR/login/watch/signal listeners and
one close attempt; shutdown prevents later dispatch/output and retains signal
exit code 130. `init` exclusively creates private configuration; `config` and
`--help` do no native work. Run the installed binary with `--help` for the full
implemented command list.

## Required quality and installed-consumer checks

```sh
npm ci --ignore-scripts
npm run check
```

The gate checks formatting, lint, strict source/test types, deterministic
contracts, a clean build and a newly packed/installed consumer. Offline consumer
installation uses the locked `silk-wasm@3.7.1` tarball from a populated npm cache;
no private `.local/artifacts` tarball is required. Bridge build prerequisites are
in [development](../README.md#development). These checks do not log in or establish
QQ server acceptance.

## Completion rule

Every required capability needs current-version evidence for its promised scope.
Every declared platform/version must repeat the required account/message/contact
acceptance. Missing or indirect proof leaves the full goal unfinished.
[Acceptance history](acceptance-history.md) preserves earlier implementation and
verification notes; counts and environment requirements there describe their own
snapshots.
