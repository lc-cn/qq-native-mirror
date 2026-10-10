# Architecture and maintenance contracts

The package exposes `createClient`, `QQClient`, public DTOs and a CLI. The native
kernel runs in an isolated Node child process. Platform bundles supply the QQ
binaries; the public API does not require an installed QQ application.

## Responsibilities and dependency direction

```text
Application / CLI
        |
index.ts (public exports) -> client/create-client.ts (bundle and worker bootstrap)
        |
QQClient (public events and typed operations)
        |
ClientLifecycle (account state and worker generations)
        |
WorkerRpcChannel (request correlation and settlement)
        |
worker.ts (IPC boundary) -> kernel.ts (authentication composition)
                                |
                     KernelEnvironment (local preparation)
                                |
                     AccountSessionLifecycle
                                |
                   NativeServiceContext / native-services.ts
                                |
                contacts | groups | messages | media | forward
                                |
                    proprietary native services
```

| Location                                  | Responsibility                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                            | Public exports only; preserves the package interface without acquiring resources.                        |
| `src/client/qq-client.ts`                 | Public client facade, callback presentation and typed operations.                                        |
| `src/client/create-client.ts`             | Native bundle selection, worker bootstrap and transactional initialization.                              |
| `src/cli.ts`, `src/worker.ts`             | Executable entry points. Their emitted URLs are runtime contracts.                                       |
| `src/cli/`                                | Command planning and ownership of client execution, QR output, watches and process signals.              |
| `src/kernel.ts`, `src/native-services.ts` | Compose one native session and domain adapters. They are composition roots, not public extension points. |
| `src/runtime/`                            | Account/worker ownership, request/callback lifetimes and composition dependencies.                       |
| `src/features/contacts/`, `groups/`       | Friend, category, group and request actions/events.                                                      |
| `src/features/messages/`                  | Message input capture, native projection, querying and recall.                                           |
| `src/features/media/`, `forward/`         | Media codecs and forward-resource transports.                                                            |
| `src/native/`                             | Bundle resolution, provenance, storage and native contract checks.                                       |
| `src/storage/`                            | Process/account-directory ownership and locking.                                                         |
| `src/validation/`                         | Shared pure identity rules; native field-width limits remain with the specific operation.                |
| `src/contracts/`                          | Public DTOs owned by client, contacts, groups, messages, forward, native and event domains.              |
| `src/types.ts`, `src/errors.ts`           | Compatibility type exports and public errors. Contracts do not import implementation modules.            |
| `test/`                                   | Deterministic regression fixtures, including worker substitution.                                        |
| `scripts/`                                | Build tools, installed-consumer checks and separately authorized acceptance executors.                   |

The parent facade and CLI import pure input modules (`query-input`,
`download-input`, `merged-forward-input`, `send-input`, `face-input`, and
contact-category projection/validation).
Native operation modules reuse that implementation and retain internal reexports
for existing contract consumers. Input capture therefore does not require the
parent to depend on native querying, media-file writes or forward submission.

`src/runtime/operations.ts` owns the closed business-operation vocabulary. The
public facade constrains its private operation dispatcher to that union, the
worker derives its classifier from it, and native dispatch handles the same union
exhaustively. The low-level public `request(string, ...)` remains compatible. Adding a name without a corresponding native branch fails type
checking; the worker no longer maintains a second handwritten allowlist.

Shared account/group identifier rules belong to `validation/identifiers`, not
to message sending. Group inputs import that pure owner directly; the original
message input exports remain compatible. Transport-specific uint64 limits stay
with the request that requires them, rather than silently narrowing all group
operations. The dependency gate forbids these group inputs from reaching back
into message-send validation.

Feature modules may depend on public contracts and narrow native/runtime ports.
They do not import the public Client or compose other account sessions. Relative
internal paths are private; only the package root and CLI are public entry points.

Each public type has one declaration in `src/contracts/`. Internal modules import
their needed domains directly; `types.ts` only reexports them for compatibility
through the package root. The event table composes domain DTOs, and domains never
depend back on that table. Forward submission receipts depend on message receipts;
received forward elements belong to the message contract, avoiding a type cycle.
Only the client contract depends on native bundle version metadata. These exact
type dependencies are checked rather than opening all contract domains to each other.

Contracts contain only interfaces, type aliases and type-only imports/exports.
They do not create objects, load native code, execute IO or define concrete classes.
Internal Session, transport and codec ports stay in their existing ownership layers;
public native manifest data is distinct from the proprietary native service types.

## Encapsulation and variation points

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

The three composition roots have different import permissions. The worker owns
IPC and reviewed native bootstrap dependencies. Authentication may compose the
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

`createNativeServices` receives one `NativeServiceContext`: session, version,
event sink, authenticated identity, media implementations and measured binary
provenance. Optional dependencies are named rather than encoded by argument
positions. The record/video codecs and worker transport are actual substitution
points used by platform implementations and controlled tests. Domain adapters use
composition; a shared superclass would couple unrelated native contracts.

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

`qun-web-read` owns the QQ group HTTP read transport shared by notices and essence
pages: native ticket acquisition, cookie exchange, redirect validation, timeout,
abort and cookie hashing. Its named worker context and two fixed read endpoints
keep transport ownership independent of feature DTO validation. Credentials stay
local to each request. A feature does not retry or switch protocols after dispatch.

`NativeServiceLifetime` owns the Session's dispatch guard, abort signal, native
waits and resource ledger. Composition acquires modules in order and registers
their cleanup with this owner. Close marks the Session inert, aborts waits and
detaches the ledger before attempting every cleanup once. Retained service handles
preserve native receiver identity; listener removal remains available for teardown,
while other methods cannot dispatch after close. A native Promise that rejects
after close is still observed, including synchronous close during argument
evaluation. This owner does not cancel an already issued native operation.

`runtime/media-contracts` owns the codec/tool ports independently of module
loading, media-file preparation and native submission. Bundled and supplied
codecs implement the same interfaces. Existing media-module type reexports and
public `VideoCodec`/`VideoInfo` exports remain compatible; `RecordCodec` has one
definition instead of separate loader and preparation declarations.

`NativeEventChannel` is generic over callback arguments and projected results.
It correlates native callbacks and method completion without assuming that a
callback alone means success. An invocation rejection overrides an earlier
success callback. Timeout, abort and close interrupt pending work, and late
callbacks cannot settle a removed waiter. It never retries a mutation.

`terminateWorker` owns a single retirement attempt: exit observation, SIGKILL
escalation and the exit deadline. All terminal paths remove its listener and
timers, including synchronous failures from either kill call. Close and reconnect
reuse this mechanism while retaining their own generation and account policies;
a failed retirement never silently starts a replacement worker.

`IncomingMessageDelivery` owns callback snapshots, ordered delivery, the bounded
message deduplication cache and cancellation. Its interface is `receive` and
`close`; native lookup and projection are injected ports. Closing interrupts its
own wait, signals the resolver, and suppresses late messages and callbacks without
claiming to cancel a dispatched native operation. The session composition keeps
system-message processing and native callback registration in their original
order. Queried history does not share live-delivery deduplication state.

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

`GroupQueries` owns full-list selection, per-group query coalescing, failed-channel
quarantine and complete member-result validation. The query port exposes only the four verified Group read methods; native method
returns stay `unknown` until their receiving validator checks them. Service and
method acquisition remain lazy, methods are captured once, and their original
receiver is retained. Close or abort during either getter prevents dispatch.
The callback reads use the Session's shared channel and do not register listeners. Detail/mute
callers receive separate DTO copies; full-list callers retain the existing shared
result semantics. Member results update the account's UID cache through one
commit hook only after the whole batch validates and the Session remains alive.
Closing invalidates the module and clears its query bookkeeping; the owning
Session first aborts pending callbacks and native waits.

`createGroupSearch` owns the group-number search queue, same-keyword coalescing,
whole-batch projection and failed-channel quarantine. Its narrow lazy port exposes
only `searchGroup`, returning unknown data. The facade and CLI share a pure uint64
input capture module; composition checks the measured binary contract before
acquiring Search or registering its one retained listener. Native callback objects
remain retained until worker exit. The shared callback channel accepts a local
abort signal, so feature close retires its waiter without closing sibling reads.
The callback has no nonce: a matching unsolicited snapshot may satisfy a read;
failure prevents another dispatch in that Session. Successful callers receive
separate DTOs, and incomplete empty pages never become an absence result. This
module performs no automatic paging, retries, account-ID conversion or mutations.

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

`createContactOperations` and `createGroupOperations` receive separate mutation
ports, not a Session or arbitrary service locator. The contact module owns profile
lookup, remark and deletion validation; the group module owns its eight management
actions. Each group method is paired with its native argument tuple by a type
union, so adding a branch cannot silently mix another method's parameters.
Both modules validate and capture input before UID lookup, retain the selected
native receiver and acquire each method once. They use the Session's signal and
wait owner: close interrupts pending lookups/completions and suppresses subsequent
dispatch, while late native failures remain observed. They never retry a mutation.
The existing per-method completion policy remains local to each domain; void
confirms submission only, and result-bearing methods require a validated success
code. These internal ports do not add types to the public package interface.

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
success alone cannot complete a list; a failed query invalidates listing while
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

The proprietary `.node` surface has no stable complete TypeScript declaration.
Its type erasure is centralized in `src/native/native-object.ts`. This internal
escape hatch is not proof of an ABI. Native results must pass adapter validation
before becoming public DTOs; public/IPC inputs start as `unknown`. Business dispatch receives a
`Record<string, unknown>` rather than inheriting the proprietary object escape
hatch; field validation belongs to the receiving operation. The existing
low-level `QQClient.request` default result type is retained for compatibility;
RPC storage and settlement use `unknown` internally.

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

## Lifecycle and error contracts

- One worker owns one account data directory. Locks prevent concurrent owners.
- Every pending IPC request settles once; timeout, reply, send failure, offline,
  exit and close all retire their corresponding map entries and timers.
- The channel captures the sending transport per request. The three reviewed HTTP
  reads use best-effort per-request cancellation on timeout, send failure and
  offline; it never targets a replacement worker. `WorkerReadRequests` owns their
  controllers, detaches before abort and observes late native completions. Its
  signal reaches the Session adapter, HTTP IO and next-page guard. Cancellation
  affects no sibling read, does not close the account, and cannot undo a native
  invocation or remote mutation. Delivery failure preserves the original error.
- Login timeout retires the worker generation before a replacement is allowed.
- Capture and validate a complete public operation before an asynchronous lookup
  or native mutation. Recheck session lifetime after asynchronous work.
- Native callbacks without a request nonce use coalescing or invalidation where
  required. A failed channel cannot safely accept a retry's late callback.
- Native composition is transactional: a failure stops callbacks and unwinds
  successfully acquired modules. Normal close is idempotent and attempts every
  cleanup. A single teardown error retains its identity/code; multiple failures
  retain their original values in an `AggregateError`. Cleanup never retries a
  native operation.
- Account state, generation, timers and pending settlement converge before
  fallible teardown. Offline/logout events still report the original transition.
  Cleanup diagnostics expose typed message/name/code records rather than native
  Error instances or arbitrary error properties.
- Error serialization includes only explicitly supported data fields. It never
  coerces an unknown object or invokes error accessors; invalid fields, trapping
  proxies and inaccessible progress records cannot prevent an RPC failure reply.
  Normal Error messages, names, finite numeric/string codes and validated merged
  progress retain their contracts. Callback failure paths share this projection
  and preserve ordinary Error identity. Error events retain their message-only
  payload. Native objects, tickets, arbitrary causes and stacks are not part of
  the IPC error DTO.
- Tests using controlled services prove SDK behavior, not real native/account
  interoperability. Account acceptance and platform CI evidence remain separate.

## Quality gates

Use Node 24 and npm. `package-lock.json` fixes the development dependency tree.
TypeScript is pinned to a version supported by the installed type-aware ESLint
parser; upgrades must update both and pass the gates together.

```sh
npm ci --ignore-scripts
npm run format
npm run check
```

`check` runs formatting, zero-warning ESLint, strict source/test type checking,
deterministic tests, a clean build and verification of a newly packed/installed
consumer. The package consumer uses fake services and an isolated replacement
kernel; this command does not log into an account. Codec dependencies are packed
from npm's populated cache for the offline consumer installation.

The installed-consumer gate also checks the complete compatibility type inventory and
every relative dependency in the actual packed declaration graph. Positive and
negative consumers preserve peer/login discrimination, event payload types,
received versus sendable elements, receipt inheritance and notice aliases.
Updating the public type inventory is an intentional interface change; moving a
declaration between owned domains must not change its name or shape.

The `SDK quality` GitHub workflow runs these gates independently of platform
bundle and video-native CI. Runtime output is recreated from a clean `dist`
directory so obsolete emitted modules cannot make a packaging check pass.

Static architecture tests require every TypeScript source module to participate
in the formatting gate. Binary-directory ignores are anchored to the package root
so `src/native/` remains checked. They also reject runtime dependency cycles, missing internal
modules, implementation imports from public contracts, and transitive native/IO
dependencies in pure input modules. They protect these boundaries during later
feature work; renaming directories alone does not establish them. Computed
imports and CommonJS loading are checked syntactically and denied by default;
only the exact local codec loaders and installed-manifest resolver have reviewed
exceptions. Renamed simple loaders remain checked. This gate protects source
organization, not arbitrary JavaScript evaluation.

The dependency policy in `test/helpers/dependency-policy.ts` checks type imports
as well as runtime imports. Storage depends on storage and public primitives;
native bundle management additionally depends on storage. Runtime depends on its
own modules, typed native contracts and the exact login-input validator. Features
depend on their domain, public primitives and typed runtime/native ports. Only
explicitly documented module pairs may collaborate across feature domains. The
facade and CLI use reviewed input capture modules rather than native business
operations. Native composition roots may assemble lower modules; lower modules
cannot import those roots or the public facade. Obsolete cross-feature exceptions
fail the gate rather than silently broadening access. Synthetic forbidden edges
verify that newly added modules do not inherit permission from existing names.
Compile-only negative domain-port contracts reject arbitrary service acquisition,
unrelated operations and property access on unchecked native results. Native
response field readers retain their existing domain rules; narrowing a port does
not establish descriptor-safe projection for every proprietary result.

Comments should explain constraints, ownership, ABI evidence or decisions that
are not evident from the code. Keep native provenance references next to the
adapter contract. Avoid restating method names or adding a pattern without a real
variation point. Add tests for lifetime, correlation and input/projection
boundaries; do not mirror implementation line by line.

Installed action checks exercise the compiled contact/group adapters and the real
Session lifetime with controlled services. Their consumer helper has its own
module in `scripts/`, rather than embedding action behavior in the packaging
orchestrator. No native addon or account is used by these checks.

See [Development guide](development.md) for the workflow and module placement rules.
