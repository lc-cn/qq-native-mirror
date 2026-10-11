# Encapsulation and variation points

[Composition, client and account ownership](#composition-client-and-account-ownership) · [Worker initialization and retirement](#worker-initialization-and-retirement) · [Shared lifetimes and native callback ownership](#shared-lifetimes-and-native-callback-ownership) · [Message delivery, queries and sending](#message-delivery-queries-and-sending) · [Forward resources and media preparation](#forward-resources-and-media-preparation) · [Contact and group domain operations](#contact-and-group-domain-operations) · [Group announcements and HTTP reads](#group-announcements-and-http-reads) · [Native bundle selection and capability evidence](#native-bundle-selection-and-capability-evidence) · [CLI execution](#cli-execution)

## Composition, client and account ownership

The three composition roots have different import permissions. The worker owns
IPC and imports its bootstrap factory. The Node binding owns reviewed loader,
codec, provenance and account-lock dependencies; the bootstrap owner accepts
those ports without importing filesystem or feature implementations. Authentication may compose the
environment and account lifetime, but cannot import feature implementations or
bundle storage. Service composition assembles domain adapters and its reviewed
runtime ports; it cannot acquire bundles, account locks or authentication owners.
The environment accepts callbacks without importing the kernel or interpreting
its state. Architecture tests check these constraints for runtime and type edges,
including each owner's Node IO dependencies.

The package entry only reexports its public interface. `createClient` selects and
validates a bundle, resolves package-relative worker/bridge paths, and releases
the worker if initialization fails. It constructs the same `QQClient` class
exported from the root. The facade does not import bundle preparation or file IO;
its lifecycle owns process requests and retirement. Composition and lower layers
cannot import `src/client/`. New files in that directory do not inherit these
modules' dependency permissions. Both relative and external imports are checked.

`QQClient` inherits from `EventEmitter` to implement the public event contract.
`WorkerRpcChannel` owns its pending map, IDs, timer cleanup and settlement. It
accepts a transport and a failure policy; callers cannot mutate pending state.
`ClientLifecycle` owns account state, login/restore coalescing, worker generations,
automatic restore policy and shutdown. Its interface exposes state/account snapshots
and request/login/reconnect/close; no pending maps or worker handles escape. Its named
context supplies the worker factory, event sink and native-export update hook.
`QQClient` keeps the existing `EventEmitter` API, QR/error presentation, callback audit
and message aliases. State transitions still happen before their public events, and
facade methods return the lifecycle's login/reconnect/close Promises directly so
coalesced callers retain the same Promise identity.

`runtime/operation-contracts` binds each internal business command to its SDK
payload and result using domain DTOs. Discriminated call tuples keep the association
for literal and union callers; payload-free commands cannot receive arbitrary
objects. Missing or orphan contracts fail compilation against the closed routing
vocabulary. The facade infers the return type from the command instead of choosing
an unrelated result generic. The public low-level `request<T>` remains compatible.
This module contains declarations only: it neither asserts a native ABI nor
validates received IPC. Domain owners still validate runtime input and native
results. Compiler fixtures mutate actual facade calls in memory and never execute
the invalid business bodies.

`createNativeServices` receives one `NativeServiceContext`: session, version,
event sink, authenticated identity, media implementations and measured binary
provenance. Optional dependencies are named rather than encoded by argument
positions. The record/video codecs and worker transport are actual substitution
points used by platform implementations and controlled tests. Domain adapters use
composition; a shared superclass would couple unrelated native contracts.

`KernelEnvironment` owns one cached preparation promise, local directories, device
configuration, Session factory selection and engine/login initialization. It does
not connect or authenticate. `AuthenticationAttempt` owns one captured login request, account matching,
connection request, QR/restore/quick dispatch, polling and the original login
deadline. Its Promise resolves only at account Session readiness. Its login port
contains only the methods that authentication uses; it cannot start Sessions or
load bundles. The Kernel owns the current attempt reference, account generation,
identity and offline transitions. Acquired handles become
visible to that state machine before engine initialization and listener
registration: native calls can synchronously invoke callbacks. A rejected
preparation is retained rather than replaying native initialization; factory
selection occurs before invocation, never by catching a failure and trying
another signature. Login failure notifications treat arbitrary native arguments
as opaque and use a fixed public error, so serialization cannot interrupt pending
settlement or disclose the payload.

`kernel.ts` owns one account-retirement transaction. It advances the generation,
detaches the Session, clears the identity and invalidates/detaches the pending
attempt before fallible cleanup. Login failure, offline and logout publish their
own events after that transaction. Explicit close rejects the pending login before
cleanup and propagates its original cleanup error without publishing diagnostics;
native notifications combine primary and cleanup failures before settlement and
diagnostics. The ordering relies on `AuthenticationAttempt.invalidate/reject`
remaining internal timer/Promise operations without synchronous external callbacks.

`AccountSessionLifecycle` owns startup for one authenticated account, retained
Session callbacks, the native-readiness/start-completion gates and the acquired
business adapter. Its interface is `begin`, `invokeOperation` and `close`; it does
not expose services, readiness flags or callback handles. A named context supplies
the already selected native start strategy, business adapter factory and account
transition hooks. The factory is a real variation point: production composes the
native services; controlled tests supply an adapter through the same interface.
The authentication attempt retains login/restore selection, account matching,
request deadlines and terminal settlement. The Kernel retains account generations
and interpretation of offline notifications. Invalidation stops authentication
work before account teardown; failure/offline settlement retains cleanup errors.
Close retains its distinct contracts: pending login rejects with the closing
error, while cleanup failure rejects close with its original value. Raw Session
instances are prepared before LoginService initialization because native versions
may depend on them; they are not a second business-service owner.

The Session owner buffers early readiness until native start succeeds, and never
falls back after a dispatched start fails. Close detaches its business adapter
before fallible cleanup; retained callbacks cannot publish after close or generation
replacement. A business adapter returned after reentrant close is released once,
including its cleanup error, rather than retained as an online Session. Reentrant
readiness during construction cannot allocate a second adapter. Native singleton
threads still require worker exit: this module does not invent a Session destructor.

## Worker initialization and retirement

`NativeWorkerBootstrap` owns initialization for exactly one Node worker. It
reserves initialization synchronously before creating the data directory, keeps
its candidate kernel private and permits login/business dispatch only after
`prepare` succeeds. Same-directory and different-directory duplicate requests
cannot acquire a second lock, load the addon again or replace the candidate.
An initialization failure is terminal for that worker; the parent owns worker
retirement rather than replaying native singleton initialization.

Close retires initialization before closing its candidate once. Every resumed
acquisition stage checks that initialization is still active. A candidate returned
after reentrant close is retired without preparation, and a late prepare result
cannot publish readiness. Kernel callbacks after failure or close are suppressed.
Primary initialization failures retain cleanup failures rather than replacing
them. Native loading can leave process-owned threads; once loading is attempted,
the account-directory lock remains owned until the synchronous process-exit hook.
Directory-only failures release their acquisition once. Close does not invent a
native addon unload or a QQ Session destructor.

`worker/bootstrap` binds the actual Node ports: directory creation and locking,
RTLD_GLOBAL bridge loading, default Linux library preload, measured wrapper
provenance, codecs and kernel creation. `worker.ts` presents events, correlates
IPC requests, propagates read cancellation and exits the process. These owners
have separate exact dependency permissions; a new file in `worker/` inherits
none of them. Controlled checks exercise both the owner interface and the actual
compiled IPC entry, with addon loading and kernel behavior substituted. Installed worker checks cover same/different-directory
initialization races, preparation gates, native-touched failure locks, orderly
close, disconnect, directory reuse and close during pending initialization. They
run against the packed archive locally and on all six native-package CI hosts;
fake loading does not establish QQ addon or account interoperability.

`terminateWorker` owns a single retirement attempt: exit observation, SIGKILL
escalation and the exit deadline. All terminal paths remove its listener and
timers, including synchronous failures from either kill call. After a successful
close acknowledgement, the parent waits for voluntary exit before the existing
SIGKILL deadline; an immediate SIGTERM could interrupt the worker's synchronous
exit cleanup. Unacknowledged shutdown and reconnect retain immediate termination.
Close resolves only after observed process exit, not the acknowledgement. A failed
retirement never silently starts a replacement worker. Installed IPC checks hold
fake exit cleanup briefly to prove the parent does not preempt lock release.

## Shared lifetimes and native callback ownership

`FeatureLifetime` owns cancellation and pending completion for one local feature.
Contact directory reads and group-file actions share this implementation through
named `assertOpen`, `wait`, `signal` and `close` operations. The account wait port
receives local cancellation and retains account-level errors; a local fallback
also retires waits when a substituted port only observes account closure. Late
completion remains observed and local listeners are released on every exit.
This module cannot acquire native services, domain implementations or IO. Cache
clearing, page history and mutation acknowledgements stay with their domain owners.

Friend and group request owners also use `FeatureLifetime` for native completion;
their account-abort retirement passes through the original cancellation reason.
Listener removal, callback quarantine, request correlation and pending list
rejection remain domain-owned. Group member queries and self-profile lookup retain
their distinct parent-cancellation policies and pass local signals into the account
wait. Local close therefore releases both waits before native completion; it does
not leave an account abort listener retaining a retired feature.

The group-file owner retires its count, creation and deletion actions separately
from the account lifetime. Its action signal guards capability checks, service
acquisition and captured methods; the account wait also receives that local
signal. Closing the owner ends pending waits and observes late native completion
without replaying the action or closing sibling account services. Page correlation
retains its separate owner and history.

`NativeServiceLifetime` owns the Session's dispatch guard, abort signal, native
waits and resource ledger. Composition acquires modules in order and registers
their cleanup with this owner. Its bound `call` port captures a native method once,
checks retirement again after property acquisition and invokes that captured method
with its original receiver. Composition uses this port rather than checking one
method and reading another to dispatch. Results remain `unknown`; domain adapters
own receipt validation and completion policy. Close marks the Session inert, aborts waits and
detaches the ledger before attempting every cleanup once. Retained service handles
preserve native receiver identity; listener removal remains available for teardown,
while other methods cannot dispatch after close. A native Promise that rejects
after close is still observed, including synchronous close during argument
evaluation. This owner does not cancel an already issued native operation.

`NativeEventChannel` is generic over callback arguments and projected results.
It correlates native callbacks and method completion without assuming that a
callback alone means success. An invocation rejection overrides an earlier
success callback. Timeout, abort and close interrupt pending work, and late
callbacks cannot settle a removed waiter. It never retries a mutation.

`runtime/native-listener-owner` owns callback proxy caching, shape-only audit,
unknown callback dispatch and strong references. Composition supplies each native
registration call and its business overrides; the owner cannot acquire services
or authenticate. Registration runs once, preserving the Search before-add and
Msg/Group after-add retention rules. Close suppresses callback execution through
the account lifetime but does not clear references or guess a listener-removal
ABI. Audit exceptions and synchronous reentrancy retain their existing behavior.

The proprietary `.node` surface has no stable complete TypeScript declaration.
Its type erasure is centralized in `src/native/native-object.ts`. This internal
escape hatch is not proof of an ABI. Native results must pass adapter validation
before becoming public DTOs; public/IPC inputs start as `unknown`. Business dispatch receives a
`Record<string, unknown>` rather than inheriting the proprietary object escape
hatch; field validation belongs to the receiving operation. The existing
low-level `QQClient.request` default result type is retained for compatibility;
RPC storage and settlement use `unknown` internally.

Feature access to `native/native-object` is denied by default, including type-only
imports. Only the existing native projectors and legacy interop adapters have
explicit permissions with ownership reasons. The gate rejects new input and
operation modules and detects obsolete permissions when an import is removed.
This keeps the proprietary dynamic escape hatch from becoming a general feature
dependency.

## Message delivery, queries and sending

Message-update ingress belongs to `features/messages/recall-events`, including
batch filtering, invalid-batch diagnostics, callback correlation ordering and
normalized/legacy recall delivery. `createMessageUpdateEvents` requires named
event, dispatch and lifetime ports; it does not acquire a Session or register a
second listener. Service composition wires the existing native listener directly
to this owner. Correlation precedes normalized recall projection and legacy raw
delivery. Normalized replay suppression does not suppress legacy notifications;
close retires the account's replay window. The existing single-record projector
remains available to internal consumers without an optional batch configuration.

`IncomingMessageDelivery` owns callback snapshots, ordered delivery, the bounded
message deduplication cache and cancellation. Its interface is `receive` and
`close`; native lookup and projection are injected ports. Closing interrupts its
own wait, signals the resolver, and suppresses late messages and callbacks without
claiming to cancel a dispatched native operation. The session composition keeps
system-message processing and native callback registration in their original
order. Queried history does not share live-delivery deduplication state.

`captureIncomingNativeMessage` supplies the live delivery ports with a typed receipt
snapshot. Its single discriminator read is part of the same guarded capture as
the remaining metadata; unsupported conversations are skipped before their bodies
are read. `captureNativeMessage` uses the same snapshot implementation for queries
and forward results, where unsupported conversations remain a failure.
It reads the fields required for projection once, validates those captured values
and copies the known element bodies before lookup can yield. Projection and the
deduplication key use that same snapshot, rather than reading the original record
again. Unrelated enumerable properties are not evaluated or carried into the
snapshot; applications still receive the original `Message.raw`. Unknown element
payloads retain their original object identity. Group messages do not acquire the
unused private `peerUin` field. Delivery carries original records as `unknown`,
uses typed snapshots for identity and ordering, and has no permission to import
the dynamic native-object type. The envelope projector and mention-resolution
owner also have no dynamic-object permission. Captured metadata has a closed
interface, and its element bodies remain `unknown[]`. Only the element projector
interprets version-dependent native members after checking each element carrier;
projection, identity resolution and delivery callers do not inherit that escape
hatch. Capturing an envelope does not validate the contents of an element.
The snapshot does not define a new proprietary
ABI. Source and installed-consumer checks cover controlled accessor side effects
and queued mutation, without claiming such accessors occur in QQ callbacks.

`createMessageQueries` owns peer capture, exact/batch/history reads, asynchronous record
projection and batch reordering through injected native-read and resolver ports. The query port exposes only
`getMsgsByMsgId` and `getMsgsIncludeSelf`; returned values remain `unknown` until
the response validator checks status and the complete message batch, then narrows
them to validated message records. ID queries retain service-before-peer ordering;
history retains peer-before-service ordering. Method capture preserves the native
receiver and checks retirement before dispatch. Cancellation interrupts resolver
and decode waits and prevents a final success; it does not undo an issued query.
The composition root binds those ports and selects a method; it does not implement
query control flow. Whole-batch validation precedes asynchronous projection, and
the existing Session lifetime observes pending work and blocks dispatch after close.

`features/messages/message-resolution` combines peer conversion with the message
projection used by live delivery, queries and forwarding. Composition supplies
one narrow UIN lookup port and its diagnostic/UID-resolution callbacks rather
than interpreting message fields. The dependency gate prevents composition from
importing receive projectors directly. Existing snapshot, identity deadline,
delivery ordering and account-close owners remain in place. Native UIN results
stay `unknown` until `native-identities` validates the Map and copies only positive
decimal identities for the requested UIDs; the lookup port does not promise a
verified native result shape.

`NativeMessageSender` owns element preparation, reserved correlation IDs and
terminal receipt selection behind `send`, `sendPrepared` and `close`. Normal text,
media and merged-forward cards use the same receipt path. It receives the Session's
callback channel rather than registering another listener, preserving send/recall
subscription order. Its narrow ports expose only message preparation/query/send and server time; it
cannot request arbitrary native services. Native responses stay `unknown` until
the receiving validator checks them. Media configuration depends on codec ports,
not the account composition context. Construction performs no native work. A callback success still
waits for native completion, failed IDs remain reserved until teardown, and an
operation is never replayed. The Session aborts pending work before closing the
sender; deferred preparation cannot dispatch after shutdown.

Ordinary private/group sends enter the existing message sender through captured
public intent. The facade and sender reuse `capturePrivateMessage` and
`captureGroupMessage`, so the complete element batch is copied before IPC,
recipient UID lookup or media preparation. `native-services` routes raw payloads
to this owner; the dependency gate forbids it from importing send-input policy.
Private recipient conversion, mention resolution, element preparation, unique-ID
reservation and callback correlation therefore have one implementation owner.

The sender combines its local lifetime with the account signal. UID and
preparation waits, generated IDs and the callback channel receive this signal;
closing just this sender cannot close the shared account event channel. Pending
work is observed and cannot publish a late send result or dispatch a new message.
Already issued writes are never replayed. Filesystem/codec work already in
progress may finish; this cancellation contract does not imply arbitrary native
calls or filesystem work can be undone.

`features/messages/recall-operation` owns recall intent through
`createMessageRecalls`. The public facade and worker owner use the same pure
`recall-input` capture: peer fields are own data properties and message IDs remain
exact numeric strings. Invalid input rejects before IPC or native acquisition;
getters and string coercion cannot replace a validated target during UID resolution.
Composition delegates raw operation payloads to this owner.

The recall owner combines local and account cancellation. UID waits use the
injected cancellable wait; closing this owner leaves the shared callback channel
and sibling operations alive. Native service/method acquisition is lazy, captured
once and preserves the receiver. A native recall is dispatched at most once.
Completion requires both an explicit numeric-zero native ACK and a callback for
the exact native conversation/message with a positive decimal recall timestamp.
The correlation target is captured separately from the mutable native argument;
vendor argument mutation cannot acknowledge another conversation.
An early callback does not replace the native ACK, and malformed/accessor fields
cannot acknowledge success. Closing after dispatch ends observation while the
remote effect remains unknown; it cannot cancel a vendor recall or authorize retry.
Controlled source and installed-package checks establish these SDK boundaries,
not a new real-account recall or signing-authenticity result.

`native/prepared-message-contracts` owns the exact text, image, file, record,
video, face and reply envelopes constructed by the SDK. Builders return their
specific variant, and ordinary sender preparation uses their discriminated union.
These data declarations have no dynamic native-object inheritance or index signature;
compile-only negative gates use the actual builder return types so widening them
back to `any` cannot silently pass. The same owner declares the independently
constructed ARK forward-card envelope. `PreparedSendElement` combines that envelope
with the ordinary builder union only at native submission; cards remain outside
ordinary public message input. The formatter preserves its former type reexport.
The sender captures the entire input batch before asynchronous preparation and
uses the closed prepared union instead of a dynamic native-object array. Invalid
later elements cannot start earlier UID or media work. This capture copies
validated fields; it does not establish descriptor-safe getter handling.
Reply fields still use their existing nonempty string checks before construction.
Video thumbnail lookup remains a typed Map lookup, including the possibility
that a requested key is absent. This internal model does not assert a complete
callback ABI: raw received elements retain their existing projection contracts.

`features/messages/inbound-elements` owns receive-only element projection and
mention interpretation. It has no filesystem or native-operation dependency;
its complete runtime closure is checked by the pure-module gate. Unknown native
elements retain their original objects. `outbound-elements` owns local image and
attachment preparation and validated reply references. It accepts only the shared media
staging and message-ID query ports, preserving their receivers and native request
shapes. `native-message-sender` composes these constructors and keeps concurrent
preparation, send correlation and account-close checks. Face construction belongs
to the shared pure `face-input` owner. Internal paths are private; the former mixed
module is removed from source and packed output without changing public exports.

## Forward resources and media preparation

`features/forward/forward-resource-owner` owns the Session's lazy upload and read
transports and their orchestration. Its SSO port contains one native method; the
composition root supplies peer resolution, prepared card sending and the account
signal. Read preflight precedes native service acquisition; merged sending still
captures input, resolves the destination, checks cancellation, then uploads and
sends the card. Two deferred cleanup entries retain the original upload/read order
and account cleanup error semantics. Construction never acquires native services.

`createForwardMessages` owns existing-message forwarding and merged-content reads.
Its narrow message port exposes only `getMultiMsg` and `forwardMsg`; peer resolution
and single/batch decoding are injected separately. It captures validated inputs
before asynchronous resolution, resolves source then destination, and preserves
the original native argument order and receiver. A merged read validates its
entire raw batch before decoding, allowing mixed source conversations. Local close
and Session abort stop pending resolution, native completion and decoding without
replaying an operation. Closing during a getter prevents the next dispatch or a
successful return; single decoding stops before another record is started. Late
promises remain observed and completed waits remove their abort subscriptions.
This module registers no native listeners. A successful forward result confirms
native acceptance only, with no new message IDs or destination delivery receipt.

`runtime/media-contracts` owns the codec/tool ports independently of module
loading, media-file preparation and native submission. Bundled and supplied
codecs implement the same interfaces. Existing media-module type reexports and
public `VideoCodec`/`VideoInfo` exports remain compatible; `RecordCodec` has one
definition instead of separate loader and preparation declarations.

`runtime/media-contracts` owns the one `MediaStagingPort` used by image, record,
video preparation and the message sender. Its native request retains the fixed
eight fields and its result stays unknown until each constructor validates the
cache path. It cannot send messages, query history or acquire services. Codec and
file lifetimes remain with the media constructors; video retains its existing
abort/deadline checks, while image and record retain the sender's completion
checks. The port shares the native method contract, not a new preparation policy.

`features/media/attachment-downloads` owns the captured download request, peer
resolution, lazy message port acquisition, callback completion and staging lifecycle.
`native-services` composes and delegates to this owner. The narrow
`AttachmentDownloadPort` exposes only the existing rich-media download request;
dependency and compile-only negative gates prohibit acquiring other native services
or submitting messages. Callback payloads and native return values remain `unknown`.
The method is captured once before filesystem IO and dispatched with its original
receiver. A successful callback waits for native invocation completion.

Account, local-owner and per-request cancellation cover UID and callback waits.
Closing this owner leaves the shared account channel available to sibling features.
An IPC timeout propagates cancellation to the worker, preventing late UID results
from starting a download. Late native failures remain observed. Cancellation cannot
undo native work or a filesystem copy already issued; a published destination is
retained. Staging cleanup is attempted once. When both the operation and cleanup
fail, an `AggregateError` preserves both original values through the shared pure
cleanup helper. This exact dependency permits no account/runtime composition.

## Contact and group domain operations

`ContactDirectory` owns the account's UID cache, recipient resolution and validated
friend/category reads. Its lazy Buddy, Profile and UID ports expose only the three native methods it
actually uses, returning `unknown`; it cannot acquire arbitrary native services.
A method is captured once with its original receiver, and close or abort during
acquisition prevents dispatch. It receives whole validated member batches from
`GroupQueries`; no cache reference escapes. Buddy/profile queries commit only after
the complete result validates and the Session remains alive. Categorized results
retain their separate counts and duplicate membership semantics. Single conversion
misses remain uncached, preserving the existing policy. Construction does no native
work, and close prevents cache hits, late commits and subsequent dispatch.
Buddy and UID conversion results remain unknown until their fields are validated.
Flat and categorized friend reads share one profile projector, while flat reads
require only category memberships. UID conversion requires a native Map entry for
the requested identifier; a map-shaped object cannot supply a recipient identity.
These owners have no permission to import the dynamic native-object escape hatch.

`contact-operation-input` and `group-operation-input` own pure preflight for the
three contact and eight group management actions. Each returns a closed captured
intent whose discriminator retains the exact payload type. The facade, domain
owner and CLI share these rules; only CLI flag parsing remains in command plans.
Captured options are new objects with populated defaults. Public option fields
remain optional, while internal IPC types require the captured flags and reason.
The existing decimal spelling and range policy is preserved; management IDs are
not silently converted to the positive query or uint64 file rules. Public group
remark keeps its existing additional positive-ID admission rule. Facade captures
run in async methods so validation failures remain rejected Promises.
These modules reference only their domain data contracts and cannot acquire
resources, resolve UIDs or import execution owners. Domain entry checks lifetime
both before and after capture; even a validated accessor can retire the account.

`createContactOperations` and `createGroupOperations` receive separate mutation
ports, not a Session or arbitrary service locator. The contact dispatcher owns
input capture, UID resolution, remark and deletion validation; the group module owns its eight management
actions. Each group method is paired with its native argument tuple by a type
union, so adding a branch cannot silently mix another method's parameters.
Both modules validate and capture input before UID lookup, retain the selected
native receiver and acquire each method once. They use the Session's signal and
wait owner: close interrupts pending lookups/completions and suppresses subsequent
dispatch, while late native failures remain observed. They never retry a mutation.
The existing per-method completion policy remains local to each domain; void
confirms submission only, and result-bearing methods require a validated success
code. These internal ports do not add types to the public package interface.

Deletion and kick options are captured once, including their individual flags and
texts, before UID lookup. Validation and dispatch use those same scalars, so
changing accessors or mutation during the lookup cannot replace validated input.
`user-profile-query` owns resolved contact lookup and projection, with only an
injected Profile port and the account wait/signal. It returns the canonical public
`UserProfile`; the old `ContactProfile` name is a type reexport. It cannot resolve
UIDs, mutate contacts or acquire another lifetime. Projection captures the requested
Map entry and each core field once; the original `raw` carrier retains identity. Map lookup overrides retain
their existing receiver and behavior. Retirement is checked before and after each
read, including a thrown getter or Map lookup; the exact close reason wins and no
subsequent native field is inspected. While active, thrown reads retain their
original error identity. Both domains capture the completion status
once and recheck retirement before accepting it. Rejection codes come from that
captured status, rather than a second read of the opaque native response.

The checked `contact-group-snapshot-consumer-contract.mjs` runs these contracts
against the installed compiled owners in local and platform consumers. It also
checks all eleven facade actions reject invalid JavaScript before controlled IPC,
that deletion options are detached, and that a prepared kick CLI plan retains its
original flags. The actual installed facade and CLI are used with a substituted
transport, not an authenticated worker. Its native
services are controlled fixtures; this evidence does not establish remote friend
or group mutation, profile interoperability, or account authentication.

`createSelfProfile` owns one temporary Profile listener and a serialized
nickname/signature update. Its four-method port preserves opaque registration
IDs. It captures the selected input before awaiting UID/detail, retains the
existing profile fields and requires both the matching callback and successful
fetch completion before modification. Registration may close synchronously;
the returned listener ID is still released once before settlement. Lookup state,
timers and cancellation hooks detach before fallible removal. A removal failure
settles the lookup and prevents mutation; combined operation/cleanup failures
retain both values. Undocumented removal promises are observed without waiting
or claiming remote completion. Its exact dependency on the pure runtime cleanup
helper grants no permission to compose accounts or acquire other runtime owners.

`createFriendRequests` owns its single Buddy listener, request deduplication and
uncorrelated list query. Its port contains only registration/removal, listing and
approval. Notifications validate a whole materialized batch before any event,
including sparse-array holes. Request/decision inputs are captured once. Native
notification carriers and each DTO scalar are also captured once as unknown and
validated before projection. Accessors cannot replace a checked value with a
different type during event publication. The original `raw` object remains opaque
and retains its identity for existing consumers; typed fields never reread it.
This owner has no dynamic native-object permission.
Native success alone cannot complete a list; a failed query invalidates listing while
unsolicited requests and explicit decisions remain available. Local close and
Session abort retire pending waits and callback publication before attempting
listener removal. Synchronous observer close stops the current batch; registration
that returns after abort releases the acquired ID once. Approval is never automatic
or replayed, and void completion still confirms dispatch only.
Each pending wait has a removable abort subscription. Completed queries do not
attach to a shared forever-pending Promise; an isolated installed-consumer check
verifies bounded Promise retention over repeated completed queries.

`createGroupRequests` owns its Group application listener, bounded deduplication
and the serialized page queue. Its four-method port can register/remove the
listener, read one notification page and submit one explicit decision. It cannot
query unrelated account data or change group membership. Page callbacks have no
request ID: calls remain serialized, match the requested `doubt` flag and require
both the page and successful native completion. Any failed dispatched query
quarantines further listing; unsolicited notifications and explicit decisions
remain available. Inputs are captured before queueing, including the caller's
cursor and decision reason. Local close and Session abort stop callbacks and
pending waits before listener removal, including queued cursors and unresolved
decision acknowledgements. Native calls already issued are observed without
replay. A callback observer that closes the module stops the remainder of the
batch. Undocumented removal promises are observed without waiting; a synchronous
cleanup failure retains its original value. A void decision completion confirms
dispatch only. The local and multi-platform installed-consumer checks share the
same controlled composition contract; they do not approve real group requests.

`GroupQueries` owns group-ID capture, refresh defaults, full-list selection, per-group query coalescing, failed-channel
quarantine and complete member-result validation. The query port exposes only the four verified Group read methods; native method
returns stay `unknown` until their receiving validator checks them. Service and
method acquisition remain lazy, methods are captured once, and their original
receiver is retained. Close or abort during either getter prevents dispatch.
Full-list and member rows remain unknown until their scalar fields have been
captured once and validated. DTO construction uses that captured data, so an
accessor cannot replace a validated string with another value. Member enumeration
uses the native Map's intrinsic entries rather than an instance override. These
rules live in the query owner; composition only supplies the port and commit hook.
The callback reads use the Session's shared channel and do not register listeners. Detail/mute
callers receive separate DTO copies; full-list callers retain the existing shared
result semantics. Member results update the account's UID cache through one
commit hook only after the whole batch validates and the Session remains alive.
The three ID-based entries validate before acquiring services, registering a
callback wait or consulting query state. Identifier spelling and existing refresh
semantics are preserved: list refresh remains opaque; member refresh is boolean
with a nullish default of false. Composition forwards input without revalidating
or supplying defaults.

Closing invalidates the module, aborts its local signal and clears bookkeeping.
Callback waits receive the combined account/local signal; member waits also race
local retirement, even when native completion is stalled. The shared channel and
account remain available to sibling owners. Already issued native failures stay
observed, and retired waits cannot publish results or repopulate quarantine state.
Member commit remains preceded by a lifetime check; a commit hook that retires the
owner prevents final result publication. Cancellation cannot undo an issued query
or roll back an external commit hook.

`createGroupEvents` owns partial group/member metadata projection. Each optional
field is captured once before validation; native role states and update kinds
retain their distinct meanings. Member enumeration reads the Map's intrinsic
storage. An invalid row or projection exception discards the whole batch and
emits a fixed diagnostic without its payload. Application emitter exceptions are
outside that projection guard and keep their original identity. Metadata event
projection and full-list query validation are separate contracts; neither implies
a verified join/kick action or successful native query.

`createGroupSearch` owns the group-number search queue, same-keyword coalescing,
whole-batch projection and failed-channel quarantine. Its narrow lazy port exposes
only `searchGroup`, returning unknown data. It captures the target and checks the
injected exact-binary capability before entering its queue or acquiring Search.
The facade and CLI share its pure uint64 input capture module. Composition binds
the capability predicate and registers one retained listener; input validation and
unsupported-contract policy stay with the search owner. Native callback objects
remain retained until worker exit. The shared callback channel accepts a local
abort signal, so feature close retires its waiter without closing sibling reads.
The callback has no nonce: a matching unsolicited snapshot may satisfy a read;
failure prevents another dispatch in that Session. Successful callers receive
separate DTOs, and incomplete empty pages never become an absence result. This
module performs no automatic paging, retries, account-ID conversion or mutations.

`createFriendCategoryMutations` owns category creation, rename and deletion through a narrow
Buddy port. Its discriminated request union binds each operation to its native
argument tuple. Input capture and independent binary capability checks precede
acquisition; each selected method keeps its receiver and dispatches once. Both
writes require an explicit int32 zero ACK, share the account signal and a local
five-second deadline, and observe late rejections. Closing after dispatch leaves
the remote effect unknown. This shared lifecycle does not grant deletion to a
binary whose rename contract alone is verified.
Creation has its own capability decision and receipt projector: it returns the
native category identity/name rather than a void ACK. Its native method is
captured once and invoked with the original receiver and an explicit second
`undefined` argument. Close during acquisition prevents dispatch; close during
receipt projection prevents a successful DTO from escaping. Composition only
injects the port and capability decisions, then routes these three actions.

Category reordering extends the existing `friend-category-mutations` owner.
It shares rename/delete acquisition, exact receiver, deadline, shutdown and ACK
validation; native field translation remains private to dispatch. Pure category
input capture is shared by facade, worker and CLI. The operation vocabulary binds
its payload and result, and the existing native composition injects the exact
binary capability. No additional listener, retry channel or transaction owner is
introduced. The installed mutation consumer is named for all category mutations
and separately tests each measured capability and unsupported profile.

Single-friend category assignment has a separate domain owner because its native
call requires UID resolution. It captures the caller's identity/category before
checking the exact binary capability, resolves UID once through the contact
directory, and checks its account/local lifetime before acquiring and invoking
the Buddy method. Closing during UID resolution cannot dispatch a late write.
The composition root binds these ports; it does not validate input or interpret
mutation receipts.

Rename, delete, reorder and assignment share the private
`friend-category-completion` module. It owns the signed-int32 ACK policy, bounded
wait, abort cleanup and unknown-effect errors after dispatch. Category creation
keeps its distinct identity receipt. The dependency gate permits only the two
mutation owners to import this completion module, and prevents it from acquiring
native services or identity modules. Public facade and CLI reuse pure category
capture; adding a feature does not grant them native execution dependencies.

Assignment is enabled only for the measured Linux x64 profile recorded in
`evidence/friend-category-assignment-contract.json`. Controlled installed-consumer
checks exercise the public method, worker routing, CLI planning and native adapter
with substituted services. These checks do not establish remote category changes
or support for other binaries.

`features/groups/group-files` owns file-count, folder and listing dispatch policy.
Composition injects lazy method-specific ports and measured-profile decisions,
then delegates named operations. The domain owner rejects unsupported contracts
before acquiring native methods; existing mutation/count adapters retain their
response validation, receiver handling and account cancellation. Composition cannot
import input, operation or listing-codec implementations.

`group-file-count` owns its boxed Promise bridge and correlated singleton arrays;
`group-folder-operations` owns the distinct creation and deletion carriers. The
old `group-file-operations` module reexports their functions and Context names for
existing consumers, without execution or state. `group-files` imports the owned
protocols directly. Creation checks the outer status before acquiring its nested
carrier and validates its own inner status without constructing a deletion-shaped
response.

`group-file-result` captures own data fields for those two protocols only. It
checks the action signal before and after descriptor inspection, with the final
check outside the catch that sanitizes malformed native results. A descriptor
trap may close the action even when it throws or returns a valid status. Retirement
therefore wins before status interpretation or another field read. Count array
selection applies the same ordering around length and element inspection; its
existing then bridge still observes already-dispatched completion after close.

`group-file-pages` owns the serialized page lane, early callback snapshots,
request deadlines and complete traversal. Timer wakeups recheck the monotonic
page deadline and rearm when early; they cannot retire an active query and free
the lane before its deadline. Queued requests retain their original deadlines. `group-file-page-codec` copies the
measured fields from unknown own-data properties without acquiring services or
interpreting selector values. The existing Msg listener forwards notifications;
no second native listener is registered. Composition supplies one
`GroupFilePageHistory` for the worker lifetime, while account owners retain their
own pending requests. Closing an account cancels its waits without releasing
token reservations. The ledger never evicts tokens and quarantines untrustworthy
dispatch or reuse until worker recreation. Cancellable IPC reads supply their
request signal through queue, dispatch, traversal and final publication.

## Group announcements and HTTP reads

`createGroupNotices` owns bulletin input capture, local image preparation, domain
ticket acquisition, upload and publication. Its injected ports expose only the
ticket method and three bulletin methods; they cannot acquire account services or
change group membership. Services and methods are acquired lazily and captured
once with their original receiver. Inputs are captured before asynchronous work,
so caller changes cannot replace validated options during ticket acquisition.
Image paths are canonicalized and checked before requesting a ticket; publication
requires both successful upload status and complete picture metadata. Local close
and Session abort settle pending file, ticket and mutation waits without issuing
the next step. Late native promises remain observed, and synchronous close during
method or result access prevents dispatch or successful completion. Cancellation
cannot undo a mutation already issued. Successful publication supplies no verified
notice ID or recipient receipt; void deletion confirms dispatch only. The shared
installed-package contract exercises these rules with controlled services and
does not request real tickets or modify group announcements.

`qun-web-read` owns the QQ group HTTP read transport shared by notices and essence
pages: native ticket acquisition, cookie exchange, redirect validation, timeout,
abort and cookie hashing. Its named worker context and two fixed read endpoints
keep transport ownership independent of feature DTO validation. Credentials stay
local to each request. A feature does not retry or switch protocols after dispatch.

`requestQunPage` owns the shared group HTTP read transport: client/domain ticket
acquisition, cookie exchange, redirect policy, BKN hashing and request cancellation.
Its two narrow ticket ports expose no account or message operations. Native service
and method acquisition is lazy, captured once and checked for cancellation before
dispatch. Acquisition and credential projection share a fixed-error boundary;
proprietary exceptions and sensitive URLs do not become caller diagnostics.
Query parameters are captured before acquiring a ticket, preserving duplicate
parameter order. The request lifetime covers HTTP completion, response cleanup and
JSON parsing, observes late failures and releases late responses after cancellation.
The fixed HTTPS QQ redirect policy and timeout remain with this transport. It does
not cache tickets or retry a read. `listWebGroupNotices` owns only the fixed notice
query and result projection through its injected page reader; it cannot request
native tickets or choose another endpoint. Its fixed query does not establish
complete pagination. Essence reads reuse the transport while retaining their
separate numbered-page, explicit-end-marker and overlap rules.

## Native bundle selection and capability evidence

`prepareNative` selects explicit, installed or catalog-backed bundles and checks the
manifest, device, version and Node constraints. `installVerifiedBundle` owns a
verified mirror bundle's cache validation, in-process queue, package lock, content
cache, bounded download workers, staging directory and publication. Its caller
receives only the installed root, never the queue or partially staged files. The
installer waits for every download worker before removing staging; a failed
installation releases its lock and cannot remove a later queue entry. Installed
npm object hydration retains its own format and verification policy. Both paths
use the storage-owned package lock; bundle storage does not depend on source
selection or business modules.

`native/native-contracts` owns only the pure capability registry and matching.
`native/native-contract-inspection` owns file hashing and actual host identity;
only the Node bootstrap imports that acquisition module. Service composition
imports the pure registry, so capability checks cannot acquire wrapper files.
Unknown versions still return without opening a file; known-version read failures
propagate, and callers cannot replace the measured digest with metadata.

The native contract registry stores each measured binary identity once, with an
explicit list of independently inspected capabilities. Matching requires OS,
architecture, client version and SHA-256 together; capability predicates never
infer support from a different operation. Worker inspection measures the bytes,
and service composition gates the operation before lazy native acquisition.
Adding a new profile requires its own capability list and evidence. Folder deletion
and creation use the same provenance check as category creation, file counts and group search.
Their input capture remains pure, their adapters receive only the required
RichMedia method and Session wait port, and native envelopes become copied public
DTOs only after validation. Public folder contracts expose no native service
objects or mutable Session ownership.

`native/native-manifest` owns pure manifest-relative paths, version/runtime
metadata, mirror-prefix options, codec membership, original content identity and
remote inventory rules.
The CLI uses it directly, so parameter preflight has no runtime dependency on
bundle acquisition, package locking or installation. Catalog numeric version
ordering remains a separate policy. The dependency gate checks this module's
complete runtime closure and forbids source selection and filesystem acquisition.

`native/native-directory-verification` owns the shared regular-file, canonical
containment and SHA-256 checks for selected local and installed inventories. It
returns the optional verified codec path; it cannot select a source, acquire a
package lock, write files, repair a cache or load an addon. Bundle preparation
retains the source policy and passes a canonical root. The legacy local codec
inventory preflight keeps its stricter scalar checks and original diagnostics.

`native/native-package` owns source selection, Node runtime compatibility and
trusted remote manifest acquisition. With no explicit source or version, it
first resolves device latest from the catalog and verifies the selected manifest.
Only then can it reuse an installed npm package with matching full version,
runtime constraints, wrapper, codec and every original file path/hash. Inventory
order and transport/storage representation do not affect original content;
declared sizes must agree when both representations include them. Matching npm
files or compressed objects still pass their existing integrity checks before
reuse. A valid different inventory selects the trusted mirror/cache, while a
corrupt matching package rejects. Metadata failures cannot establish latest and
therefore reject without stale-package fallback.

An explicit version may resolve a matching npm package offline; a mismatching
installed version falls back before runtime constraints. Explicit catalog or
manifest sources bypass npm selection. Catalog resolution binds selected version
metadata as well as the manifest digest; a caller's explicit version constraints
are preserved. A legacy
explicit wrapper with version may still lack an inventory; automatic local codec
discovery requires the complete verified inventory. Remote sources reject npm
object storage and validate the raw manifest digest before decoding it. Storage
restoration and mirror installation keep their distinct existing format, locking,
cache and repair policies. These differences are deliberately not hidden inside
a universal manifest parser.

The source and installed-archive factory checks exercise these selection policies
through `createClient`, with controlled metadata/payload responses and addon
loading. They verify default latest with installed packages, whole-inventory
reuse, matching corruption rejection, metadata failures, pinned offline resolution,
version fallback before runtime checks, explicit catalog/manifest precedence,
legacy wrappers and local codec inventory discovery. No account or real addon
interoperability is claimed by those fixtures.

## CLI execution

The CLI entry retains help, configuration, explicit login selection and entry-URL
handling. `command-plan` validates command flags and captures file-backed message
inputs before the client is created; its prepared actions never initiate login.
`runClientCommand` owns the client, QR save queue, watch subscriptions and process
signal handlers. Business listeners attach before login so readiness deliveries
are retained. A failed older QR save cannot prevent a later image from being
saved; the latest save still controls the post-login result. Signal shutdown
prevents later action dispatch and queued QR writes, shares one close attempt,
and preserves exit code 130. Teardown releases QR/login-error/watch/signal
listeners and attempts every cleanup before awaiting client close. An already
started file write is not cancellable; its completion cannot start another queued
write or emit an output after shutdown.

[Architecture overview](../architecture.md) · [Development guide](../development.md)
