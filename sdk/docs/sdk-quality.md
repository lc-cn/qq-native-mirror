# SDK quality acceptance

The target is an ordinary-Node QQ SDK with the usability and maintainability of
oicq/icqq. A successful native login is one part of that target. Everyday bot code
must also be straightforward to write, typed accurately, and safe to stop and
restart. The [full capability checklist](sdk-acceptance.md) remains the functional
scope; this document defines the implementation order and how quality is accepted.

## Acceptance criteria

| Area               | Required behavior                                                                                                                                                                                 | Acceptance                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public API         | Select a friend, group or member once; send, query and manage through that object. Incoming messages offer `reply`. IDs and result types stay consistent with client methods.                     | A consumer imports only the package root, compiles with strict TypeScript, and exercises private/group routing, errors and retained-object lifetime.                                                           |
| Account lifecycle  | QR login, restoration, explicit quick login, reconnect and close have documented outcomes. Readiness events permit business calls. Old sessions cannot act through retained messages or contacts. | Controlled workers cover ordering, overlapping calls, disconnect, worker replacement and shutdown; separately authorized accounts verify restoration and reconnect on supported native profiles.               |
| Messages           | Private/group text, media, history, exact queries, recall and forwarding compose without raw IPC. Validation happens before dispatch; mutation failures are not automatically replayed.           | Exercise message construction through the public client, including errors, timeouts, cancellation and missing history; real accounts establish delivery and recall separately.                                 |
| Friends and groups | Queries, categories, requests, membership, moderation and relevant events have explicit result semantics. Acknowledgement, submission and observed remote effect are distinguished.               | The [contact/group matrix](contacts-groups.md) records each action/event and supported profile. Tests cover malformed responses, correlation and account replacement; live acceptance verifies remote effects. |
| Distribution       | An installation on Windows/Linux/macOS x64/arm64 selects matching native resources without a local QQ installation. Explicit versions, complete-bundle fallback, integrity and cache reuse work.  | Clean installed consumers and host CI cover all six targets and supported versions. Published registry artifacts are verified independently of local builds.                                                   |
| Maintainability    | The facade exposes a small coherent API; feature owners contain protocol rules; lifecycle owns session identity. Type declarations, comments, examples and errors describe the same contract.     | Architecture dependency checks, strict source/test/script typing, zero-warning lint, Prettier, behavioral regressions, clean build and packed/installed consumer checks pass.                                  |

Test count, class count and file count are not completion criteria. Inheritance is
used where behavior is actually shared, such as friend/group conversations;
group membership is a separate capability. New abstractions must remove repeated
caller work or enforce a concrete invariant.

## Delivery order

1. **Contact objects and readiness.** Add `pickFriend`, `pickGroup`, `pickMember`
   and group member selection; reuse existing input validation and operation
   dispatch. Bind each object to the selecting session. Capture message aliases
   before observer callbacks. Make the documented `login` readiness guarantee
   executable in a listener. Accept through both source tests and an installed
   package consumer.
2. **Event and message ergonomics.** Review private/group event types, message
   construction, request handling and common bot examples against the local
   icqq public API. Fill concrete gaps without introducing a second protocol API
   or claiming compatibility with every icqq method name.
3. **Complete contact/group workflows.** Close the remaining action/event gaps
   in the capability matrix, including category operations and group resources.
   Add methods to contact objects as their native contracts become supported;
   keep lower-level client operations available.
4. **Account and platform acceptance.** Validate the same consumer workflows on
   declared native profiles, including restoration, reconnect, multi-account
   isolation and shutdown. Preserve the remaining signing/provider investigation;
   successful login does not establish signing authenticity.
5. **Release acceptance.** Build the main and six native packages in CI, install
   the actual release artifacts, verify documented examples, and complete the
   authorized npm publication flow. A source change is not a published feature.

Each iteration should close a concrete behavior gap and update its documentation
and regression coverage. Native research is driven by a blocked workflow or an
unverified platform contract. Local implementation continues while unrelated
account or publication checks await user participation.

## Implementation and acceptance record

The working source adds `FriendContact`, `GroupContact` and `GroupMemberContact`.
Selection validates a positive decimal QQ ID and requires an online client; it
does not query native services or prove friendship/membership. Objects retain
immutable IDs and expire on disconnect, reconnect, account replacement or close.
Callers select fresh objects after the next login. Returned profile/history data
remains a snapshot, without hidden refreshes.

The iteration also fixes mutable message alias routing and the readiness event
boundary. Its acceptance is deterministic public-client behavior plus strict
installed declarations and packed consumer execution. These checks use controlled
workers and do not establish new real-account, six-platform or npm-release proof.
See the README for the usable API; historical native evidence remains in the
full capability checklist with its original revision and platform scope.

Local acceptance on 2026-10-15 passed 2,377 SDK tests, 85 build/mirror tool tests,
formatting, zero-warning lint, strict source/test/script typing and a clean build.
The packed archive was installed offline; its public declarations and contact
selection, dispatch, readiness and retired-session behavior passed. The installed
check is also wired into the platform CI consumer; that wiring has passed local
checks and has not yet been run by remote CI for these changes.

The second iteration implements accurate private/group event types backed by
immutable captured routing, typed `segment` constructors and composable inputs,
and request-event `approve()` capabilities. The friend callback-to-public-event
path is part of acceptance: a fixture that begins with an already-normalized
event cannot establish that the actual adapter emits the correct event name.
The Buddy callback now emits `request.friend`; the old `friend-request` remains
a public compatibility alias. A cross-layer regression follows the real feature
callback through controlled IPC into `QQClient` and back through approval.

The combined local `npm run check` passed on 2026-10-15: 2,409 SDK tests, 85 tool
tests, all formatting/lint/type gates, clean build and a packed/installed consumer.
That consumer verified precise event declarations, immutable message routing,
mixed input on client/contact/reply entry points and request approval lifetime.
These are controlled SDK checks, not new native-account or release evidence.

The third iteration provides `group.files`, `group.notices` and `group.essence`,
plus selected-conversation forwarding, merged-forward composition and attachment
downloads. These objects share the original online session and reuse the same
domain validation as direct client methods. Notice inputs are captured before
IPC and revalidated in the worker; invalid text/options fail before acquiring a
ticket or uploading an image. The installed consumer exercises the package-root
classes, payloads, results, errors and separately retained resource lifetimes.

The event producer audit verified the documented friend/group/recall names and
found a malformed friend-list callback could leak a projection exception. That
path now captures own data and emits a fixed diagnostic without swallowing user
observer exceptions. A regression begins at the actual registered Buddy listener.

The same audit found that `offline` was forwarded before parent-side account
retirement. The lifecycle now retires on that first notification. An internal
worker-envelope sequence correlates subsequent `disconnected`/`kicked` aliases,
so they cannot cancel a new login started inside an offline listener. A later
independent transition still cancels it. The public installed-consumer contract
covers both outcomes and asserts that old contact, resource and reply actions
cannot dispatch from an offline observer.

The full local `npm run check` passed on 2026-10-15 with 2,449 SDK tests and 85
tool tests, formatting, lint, strict types, clean build and packed/installed
consumers. The installed checks exercised group resources, conversation resource
operations and offline-observer login ownership. The lifecycle regression also
traversed the actual worker IPC path with simulated native services. No real QQ
native library, account login, remote mutation or npm publication was exercised
by this acceptance. These installed contracts are wired into the existing host
CI consumer; remote execution for this revision remains outstanding.

Native capability gaps, cross-platform account acceptance, signing authenticity
and publication retain their separate completion requirements above.

The fourth iteration makes received messages directly usable in bot handlers:
`text` captures ordered text elements, `conversation` exposes the selected peer,
and private/group aliases add `friend` or `group`/`member`. These identities and
capabilities are immutable and share the receiving session. DTO mutations cannot
redirect them; a session replacement during descriptor inspection still retires
all captured actions. Capabilities stay out of JSON, while `text` is enumerable.
The keyword demo consumes captured text and preserves deduplication, cooldown and
its online window across repeated readiness for the same account. A real offline
transition or changed account starts a fresh window.

Live event declarations now belong to `client/events.ts`; passive contracts and
`contracts/diagnostics.ts` have no dependency on client implementations. Public
names remain available from the package root. Architecture checks cover type-only
edges and cycles, and the installed declaration consumer verifies precise alias
contacts, readonly fields and the passive history-message contract.

The final local `npm run check` passed on 2026-10-15: 2,459 SDK tests, 88 tool
tests, formatting, zero-warning lint, strict typing, clean build and the actual
packed/installed consumer. Its new `installedMessageContacts` and
`installedCapturedMessageText` checks passed alongside the existing lifecycle,
resource, CLI and public-type checks. This iteration also integrates the pinned
Linux video-codec CI build baseline and measured ELF requirements. The build
container is a CI dependency, not an SDK runtime requirement; the changed workflow
has local tool-test coverage but no new remote build or published artifact proof.
No real-account login, native message send or management operation was performed.

The fifth iteration adds `client.setGroupAvatar()` and `group.setAvatar()`, with
the same domain input contract available through the `group-avatar` CLI command.
The worker checks the exact measured native profile before reading a file or
acquiring the native Group service. The supported contract is currently limited
to Darwin arm64 7.0.2-53644 and its pinned wrapper hash. Unsupported binaries fail
explicitly. Input validation, file access, native dispatch and acknowledgement
have separate ownership; account retirement prevents further dispatch. A five
second native response deadline releases waiting resources, reports an unknown
remote effect and never retries a write. Late results remain observed.

The local `npm run check` passed on 2026-10-15 with 2,503 SDK tests and 88 tool
tests, formatting, zero-warning lint, strict typing, clean build and the actual
packed/installed consumer. The installed checks cover exact public payloads,
validation before IPC, native error propagation, retired group objects and CLI
preflight. The native contract has an independently replayed static evidence
chain; no native avatar call or real-account mutation was made. Image limits,
permissions and the remote avatar effect remain unverified, as do the other five
platform profiles. These changes are local and have not been published to npm.

The sixth iteration fixes the Windows development build path. The SDK build
compiles TypeScript on Windows and leaves registration to the version-bound
adapter supplied by the verified native bundle. It no longer attempts the Unix
bridge compiler there. Local package verification and CI share one Node/npm CLI
pair and execute it without a shell or Windows command shim. The helper remains
inside the SDK tooling boundary, with one exact consumer-module permission; CI
reexports it. The Linux codec baseline test now derives mount source paths from
the host while retaining its offline, read-only and ABI-budget assertions.

The seventh iteration admits the exact Linux ARM64 3.2.32-52194 wrapper for group
avatars. Independent static review binds the actual Node Session lookup to its
Group receiver, argument conversion and normal acknowledgement callback. Both
admitted profiles exercise the same implementation. Composition tests verify
each receiver and lifetime, and reject the other four known profiles or missing
and inconsistent identity fields before service acquisition. No platform-specific
business implementation or automatic retry was introduced. The static evidence
does not establish a Linux avatar mutation, image constraints or remote effects.

Combined local acceptance on 2026-10-15 passed the full `npm run check`: 2,529 SDK
tests, 88 build/mirror tool tests, formatting, zero-warning lint, strict types,
clean build and the packed/installed consumer. The negative tooling fixtures
follow the actual npm wrapper and still require invalid command, argument and
working-directory types to fail. Windows entrypoint branch tests run in isolated
child processes; they do not establish an actual Windows build. These two later
iterations have local evidence only, independent of the authorized remote CI
candidate `f6b5a652a090d45adb9303b4a6bb3d7589fa733e`.

That authorized candidate subsequently passed remote SDK quality, all six default
mirror hosts and six Linux version/catalog cases. The [downloaded artifact audit](evidence/bot-api-ci-f6b5a65.json)
checks all twelve main archives against receipt size, SHA-256 and SHA-512, exact
source/run bindings and common package contents. Host receipts confirm cold
downloads, zero native-payload warm fetches, unchanged warm cache files and actual
native preparation/close. They do not establish account operations or avatar
effects. The archived avatar admission is Darwin ARM64 only; later Linux avatar
and Windows tooling changes remain outside this remote evidence. Separate native
package rebuilding and npm publication are not conclusions of this audit.

The same exact candidate also passed the separate six-platform native npm build
and installed-consumer workflow. A [bounded artifact audit](evidence/bot-api-native-packages-ci-f6b5a65.json)
verified all six build/consumer source bindings and the actual aggregate main
archive's SHA-256/SHA-512. Runner receipts report platform-selected auxiliary
installation, native-file hashing and preparation/close. Only 1,362,262 bytes of
selected artifact content were downloaded; auxiliary tarball and manifest-body
hashes were compared as declarations rather than independently recomputed. The
aggregate consumer duplicates the Linux x64 receipt and is not a seventh run.
The publish job was skipped. No account, avatar effect, signing authenticity or
later local revision is established by this workflow.

The eighth iteration closes a measured packet-adapter incompatibility. The exact
Linux ARM64 3.2.32-52194 Msg binding converts its second argument through UTF-8
string coercion and resolves a string `rsp`, rather than the Buffer request and
`rspbuffer` response required by the adapter. Two independent static reviews
confirmed the registered binding and local callback contract. This profile now
shares the existing string-carrier rejection policy with the measured Darwin
ARM64 profile. Forward-resource reads fail before packet acquisition; merged
forwarding preserves its upload error and explicitly undispatched upload/card
state. The installed consumer checks that the SSO method is neither read nor
called. This prevents corrupted-byte dispatch; it does not add a working SSO
transport or establish a reversible encoding for either profile.

The full local `npm run check` passed on 2026-10-15: 2,531 SDK tests, 88 tool
tests, formatting, zero-warning lint, strict types, clean build and the actual
packed/installed consumer. Its `forwardStringCarrierRejectionContract` verifies
both public forwarding outcomes and zero incompatible packet dispatch. This
later change has local evidence only; it is not part of the remote `f6b5a65`
candidate and did not use a native account.

The ninth iteration exposes group-specific member information through
`getGroupMember()` and `member.getInfo()`, including members captured by live group
messages. Existing list methods now accept explicit refresh options; `member-info`
and `members --refresh` provide the same CLI workflow. All entry points share the
complete-list query owner. Missing members return `undefined` only after a
successful complete snapshot; malformed, partial and duplicate numeric identities
reject before identity-cache commit. Decimal matching preserves precision and
original ID spelling. No separate member protocol, implicit cache or synchronous
role getter was introduced. The current query cost scales with the group size,
and refresh does not establish an atomic server snapshot.

Local acceptance on 2026-10-15 passed 2,551 SDK tests, 88 tool tests, formatting,
zero-warning lint, strict source/test/script types and a clean build. The initial
installed check caught the new options type missing from the exact public export
inventory; after adding that expected export, the complete packed/installed
consumer passed. It verifies member information and refresh through client,
contact and live-event entry points, full-snapshot validation and retirement.
The actual CLI runner prints `null` for a successful missing-member query, preserves
read errors without a success record, and closes once. These are controlled SDK
and installed-package checks, not new native-account or remote CI evidence.

The tenth iteration supplies the participant identity missing from group-request
workflows. Pending joins and invitation approvals expose an optional applicant;
invitations to the current account expose an optional inviter. Each contains an
opaque native UID and optional nickname. The existing Group listener owns the
projection, shared by list results and live events. It captures passive display
data without profile lookup, omits malformed optional metadata, and retains the
whole-batch rule for required request fields. Processed statuses and unverified
roles remain absent. Approval continues to use the original captured request
tuple and account session. The fixed-source evidence explicitly distinguishes
the actual listener from an upstream synthetic invitation with reversed fields.

The complete local `npm run check` passed on 2026-10-15: 2,559 SDK tests, 88 tool
tests, formatting, zero-warning lint, strict types, clean build and packed/installed
consumers. The same composed consumer follows native-shaped callbacks through the
real feature owner and public client into list/event identities, explicit approval,
CLI JSON and normalized watch output. It checks missing optional identity, display
mutation and retired-session rejection. Installed declarations expose 77 public
types including `GroupRequestParticipant`. Transport and account boundaries remain
controlled in these tests; no real request, account login or approval was attempted.
This participant addition has local evidence only and is not part of the earlier
`7c8361c` CI candidate.
