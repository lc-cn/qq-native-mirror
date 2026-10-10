# Architecture and maintenance contracts

The package exposes `createClient`, `QQClient`, public DTOs and a CLI. The native
kernel runs in an isolated Node child process. Platform bundles supply the QQ
binaries; the public API does not require an installed QQ application.

## Responsibilities and dependency direction

```text
Application / CLI
        |
QQClient (public events and typed operations)
        |
ClientLifecycle (account state and worker generations)
        |
WorkerRpcChannel (request correlation and settlement)
        |
worker.ts (IPC boundary) -> kernel.ts (native session composition)
                                |
                   NativeServiceContext / native-services.ts
                                |
                contacts | groups | messages | media | forward
                                |
                    proprietary native services
```

| Location                                  | Responsibility                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                            | Public API facade, callback presentation and typed operations.                                           |
| `src/cli.ts`, `src/worker.ts`             | Executable entry points. Their emitted URLs are runtime contracts.                                       |
| `src/kernel.ts`, `src/native-services.ts` | Compose one native session and domain adapters. They are composition roots, not public extension points. |
| `src/runtime/`                            | Account/worker ownership, request/callback lifetimes and composition dependencies.                       |
| `src/features/contacts/`, `groups/`       | Friend, category, group and request actions/events.                                                      |
| `src/features/messages/`                  | Message input capture, native projection, querying and recall.                                           |
| `src/features/media/`, `forward/`         | Media codecs and forward-resource transports.                                                            |
| `src/native/`                             | Bundle resolution, provenance, storage and native contract checks.                                       |
| `src/storage/`                            | Process/account-directory ownership and locking.                                                         |
| `src/types.ts`, `src/errors.ts`           | Public data/error contracts. DTOs do not import implementation modules.                                  |
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

Feature modules may depend on public contracts and narrow native/runtime ports.
They do not import the public Client or compose other account sessions. Relative
internal paths are private; only the package root and CLI are public entry points.

## Encapsulation and variation points

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
subscription order. Construction performs no native work. A callback success still
waits for native completion, failed IDs remain reserved until teardown, and an
operation is never replayed. The Session aborts pending work before closing the
sender; deferred preparation cannot dispatch after shutdown.

`GroupQueries` owns full-list selection, per-group query coalescing, failed-channel
quarantine and complete member-result validation. The four read methods use the
Session's shared callback channel and do not register listeners. Detail/mute
callers receive separate DTO copies; full-list callers retain the existing shared
result semantics. Member results update the account's UID cache through one
commit hook only after the whole batch validates and the Session remains alive.
Closing invalidates the module and clears its query bookkeeping; the owning
Session first aborts pending callbacks and native waits.

`ContactDirectory` owns the account's UID cache, recipient resolution and validated
friend/category reads. It receives whole validated member batches from
`GroupQueries`; no cache reference escapes. Buddy/profile queries commit only after
the complete result validates and the Session remains alive. Categorized results
retain their separate counts and duplicate membership semantics. Single conversion
misses remain uncached, preserving the existing policy. Construction does no native
work, and close prevents cache hits, late commits and subsequent dispatch.

The proprietary `.node` surface has no stable complete TypeScript declaration.
Its type erasure is centralized in `src/native/native-object.ts`. This internal
escape hatch is not proof of an ABI. Native results must pass adapter validation
before becoming public DTOs; public/IPC inputs start as `unknown`. The existing
low-level `QQClient.request` default result type is retained for compatibility;
RPC storage and settlement use `unknown` internally.

## Lifecycle and error contracts

- One worker owns one account data directory. Locks prevent concurrent owners.
- Every pending IPC request settles once; timeout, reply, send failure, offline,
  exit and close all retire their corresponding map entries and timers.
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
- Error serialization includes only explicitly supported fields. Native objects,
  tickets, arbitrary causes and stacks are not part of the IPC error DTO.
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

The `SDK quality` GitHub workflow runs these gates independently of platform
bundle and video-native CI. Runtime output is recreated from a clean `dist`
directory so obsolete emitted modules cannot make a packaging check pass.

Static architecture tests require every TypeScript source module to participate
in the formatting gate. Binary-directory ignores are anchored to the package root
so `src/native/` remains checked. They also reject runtime dependency cycles, missing internal
modules, implementation imports from public contracts, and transitive native/IO
dependencies in pure input modules. They protect these boundaries during later
feature work; renaming directories alone does not establish them.

Comments should explain constraints, ownership, ABI evidence or decisions that
are not evident from the code. Keep native provenance references next to the
adapter contract. Avoid restating method names or adding a pattern without a real
variation point. Add tests for lifetime, correlation and input/projection
boundaries; do not mirror implementation line by line.
