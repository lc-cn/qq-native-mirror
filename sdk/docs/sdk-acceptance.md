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

Revision `e2e6d75bd8e6f21509256224a4651bf6625801b3` passed 1336 deterministic
tests, formatting, zero-warning lint, strict source/test/governed-script typing,
a clean build and a newly packed/installed consumer. Its
[SDK quality CI](https://github.com/lc-cn/qq-native-mirror/actions/runs/38077440237)
passed. This working `0.0.2` candidate has not been published to npm.

The same revision passed the
[six-platform current-source default mirror workflow](https://github.com/lc-cn/qq-native-mirror/actions/runs/38077459948),
attempt 1. Each actual host installed only its main archive, selected the default
catalog entry without a wrapper/version/manifest override, prepared and closed
two empty account clients, downloaded native payload on the first call, made zero
payload requests on the second, and checked three real video fixtures. Runner
receipts independently hash checked all declared cache files. Parent and
independent archive audits verified each actual main's size, SHA-256, npm SHA-512
and exact source/run identity; all 212 emitted files on each of six hosts matched
the frozen build byte for byte, including Windows CLI text. These parent audits
did not download the native cache files again or execute an account operation.
Initialization, cache and codec success does not prove login, business behavior
or signing authenticity. Newer revisions require their own runtime evidence.

Revision `a0b615c405ef2f1714bd1628af9fc1689a06c2e6` subsequently passed 1443
local tests and [quality CI](https://github.com/lc-cn/qq-native-mirror/actions/runs/38098487215).
Its [six-platform default mirror CI](https://github.com/lc-cn/qq-native-mirror/actions/runs/38098519850),
attempt 1, also succeeded. [Two independent artifact audits](evidence/default-latest-six-ci-38098519850.json)
read all six actual main archives (3392661 bytes) and matched all 228 emitted files
per host to the frozen build. Manifest/codecs, exact source/run/attempt and package
SHA-256/npm SHA-512 bindings agree. Cold payload downloads were positive, warm
payload downloads were zero, and each host prepared/closed two empty clients and
checked three real video inputs. Large native cache files were hash checked on
runners, not downloaded again by the parent auditors. This records main-only
latest selection; installed-auxiliary reuse has its separate controlled contract.
No account or signing authenticity evidence follows from these checks. Later
category-reordering additions require their own runtime/account acceptance.

Revision `ade32ed28860f1d7da4bb80f3dc76533248372ad` passed 1451 local tests,
[quality CI](https://github.com/lc-cn/qq-native-mirror/actions/runs/38099643298)
and [six-platform default mirror CI](https://github.com/lc-cn/qq-native-mirror/actions/runs/38099684245),
attempt 1. [Independent archive audits](evidence/category-reorder-six-ci-38099684245.json)
read 3439680 bytes across six actual main archives and matched all 1368 compiled
files to the frozen build. Exact source/package/catalog/manifest/codec bindings,
cold download, zero-payload warm reuse, empty preparation/close and three real
video inputs per host agree. Category reorder is covered by controlled and
installed-consumer contracts only; these native initialization checks do not
execute it or establish account, remote ordering or signing behavior.

The published npm `0.0.1`, working `0.0.2` candidate and each native mirror are
separate artifacts. Push builds do not publish npm releases. See [first publication
and trusted publishing](npm-first-publish.md).

## Capability gaps and next acceptance

| Area               | Implemented contract                                                                                                                                                                                                                                                          | Remaining requirements                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native delivery    | Six OS/architecture auxiliary packages; local bundle, installed auxiliary and catalog/manifest paths                                                                                                                                                                          | Current-candidate installation/runtime acceptance on every declared platform/version; retain complete-bundle fallback alongside pruned bundles                                  |
| Default selection  | Default device latest resolves from catalog before complete-content auxiliary reuse; pinned matching versions work offline; explicit catalog/manifest bypass auxiliary selection                                                                                              | Independent version-specific consumer/server evidence; [mirror design](multi-version-and-mirror.md)                                                                             |
| Account lifecycle  | QR, restore, quick login, readiness, restart, close and explicit reconnect policy                                                                                                                                                                                             | Current-source account acceptance, quick login, concurrent two-account acceptance and unverified platform/version account cells                                                 |
| Messaging          | Text/face/media inputs, reception, bounded replay handling, history, lookups, recall and forwarding                                                                                                                                                                           | Current private/group delivery, rich-content download/hash checks, group sends and unresolved [file recall](file-recall-investigation.md)                                       |
| Friends/categories | Reads, remarks, deletion, request handling, empty category creation, exact-binary rename on four profiles, category deletion on macOS ARM64 and both Linux architectures, explicit-snapshot reorder on Linux x64, plus list/add notifications                                 | Rename/delete/reorder account acceptance and remaining binary profiles; member moves and friend applications; prove each remaining selector namespace                           |
| Groups             | Reads, membership/admin/mute metadata, bounded requests, explicit management/notices and essence add/remove with two-layer acknowledgement, HTTP pages/full traversal, folder actions/file count, exact-binary file pages and folder traversal, and gated group-number search | Create/join/invite, titles, live essence pagination and add/remove events, remaining group file operations, remaining event classification and real mutation/request acceptance |
| Security signing   | Native provenance and bounded host/provider investigation                                                                                                                                                                                                                     | Authentic provider/host contract and unresolved detection propagation; login does not establish signature authenticity                                                          |
| Architecture/CLI   | Owned lifetimes, typed operation vocabulary, dependency gates, planning before native work, watch before login and teardown                                                                                                                                                   | Preserve these contracts while implementing all remaining client capabilities; [architecture](architecture.md)                                                                  |

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

[Current source mirror acceptance](current-source-mirror.md) describes the
six-platform no-account workflow for a main archive built from the chosen source
commit. Its native initialization/cache/codec evidence is separate from the
account and business acceptance below.

Every required capability needs current-version evidence for its promised scope.
Every declared platform/version must repeat the required account/message/contact
acceptance. Missing or indirect proof leaves the full goal unfinished.
[Acceptance history](acceptance-history.md) preserves earlier implementation and
verification notes; counts and environment requirements there describe their own
snapshots.
