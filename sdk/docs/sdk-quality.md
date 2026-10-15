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

## Current iteration

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

Next, complete contact-object access to already implemented group resources and
audit the remaining documented business events against their actual producers.
Native capability gaps, cross-platform account acceptance, signing authenticity
and publication retain their separate completion requirements above.
