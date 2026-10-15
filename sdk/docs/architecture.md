# Architecture and maintenance contracts

The package exposes `createClient`, `QQClient`, contact objects, public DTOs and a CLI. The native
kernel runs in an isolated Node child process. Platform bundles supply the QQ
binaries; the public API does not require an installed QQ application.

## Responsibilities and dependency direction

The process flow below shows runtime calls and ownership, not import permissions.

```text
Parent process                           Isolated Node worker
createClient -> QQClient                 worker.ts -> Node bootstrap
                |                                      |
         ClientLifecycle                 NativeWorkerBootstrap
                |                                      |
         WorkerRpcChannel --- IPC ---> kernel.ts
                                           | composes
                       +-------------------+-------------------+
                       |                   |                   |
                KernelEnvironment   AuthenticationAttempt  AccountSessionLifecycle
                 local preparation     login attempt        authenticated lifetime
                                                                |
                                              injected createServices callback
                                                                |
                                                     native-services.ts
                                                                |
                                              contacts/groups/messages/media/forward
```

Allowed source dependencies have a separate meaning. Composition roots assemble
lower modules; injected callbacks let lower owners use implementations without
importing the composition root.

```text
Public entry -> client facade/factory -> reviewed input and lifecycle modules
Worker entry -> Node bootstrap -> initialization owner + kernel composition
Kernel composition -> preparation + authentication + account lifetime + native composition
Native composition -> domain adapters + shared request/event lifetime
Domain adapters -> same domain + exact reviewed cross-domain pairs + typed ports
Bundle management -> native modules + storage
Storage -> storage + public primitives
Public contracts -> exact reviewed type-only contract dependencies
```

The executable dependency policy includes type-only edges. Every source file must
also belong to a reviewed layer or business domain, even when it has no imports.
The diagrams are navigation aids; the exact permissions live in
`test/helpers/dependency-policy.ts`.

The source inventory is closed to regular `.ts` files and directories; unreviewed
formats and links fail instead of bypassing the graph. Service composition binds
only exact reviewed domain factories, ingress/history owners and context types.
New business files do not inherit permission to be imported by the composition
root. Both runtime and explicit type permissions must match its observed imports.

A module's location follows the responsibility it owns. Domain modules own
validation, projection and operation ordering; composition roots bind their
ports and route calls. Runtime modules own lifetimes and transport, while public
contracts remain independent of implementations. Review these responsibilities
before adding a file or dependency. Moving code without transferring ownership
does not improve the structure.

Use inheritance where callers depend on substitutable behavior, as with the
public `EventEmitter` client. Use composed ports for actual platform, codec and
transport differences. A new base class or generic helper needs a shared invariant
and real callers; similar method names alone do not establish that need.

| Location                                                   | Responsibility                                                                                                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                             | Public exports only; preserves the package interface without acquiring resources.                                                                           |
| `src/client/qq-client.ts`                                  | Public client facade and typed operations; composes lifecycle and event presentation.                                                                       |
| `src/client/contacts/`                                     | Session-scoped friend/group/member objects, shared conversation behavior and input capture; invokes an injected operation capability.                       |
| `src/client/client-event-presentation.ts`                  | Worker event presentation and bounded callback shape audit; no lifecycle, transport or native acquisition.                                                  |
| `src/client/create-client.ts`                              | Native bundle selection, registration bridge file preflight, worker bootstrap and transactional initialization.                                             |
| `src/cli.ts`, `src/worker.ts`                              | Executable entry points. Their emitted URLs are runtime contracts.                                                                                          |
| `src/cli/`                                                 | Command planning and ownership of client execution, QR output, watches and process signals.                                                                 |
| `src/cli/commands/`                                        | Domain definitions pairing accepted flags with a captured public-client action plan.                                                                        |
| `src/cli/command-plan.ts`                                  | Compose the single command registry, reject duplicate names and capture flags before planning.                                                              |
| `src/cli/command-input.ts`                                 | Shared argument parsing and primitive flags; no command or client acquisition dependencies.                                                                 |
| `src/kernel.ts`, `src/native-services.ts`                  | Compose one native session and domain adapters. They are composition roots, not public extension points.                                                    |
| `src/worker/`                                              | Native initialization ownership and the Node acquisition binding; no business DTO or IPC presentation.                                                      |
| `src/runtime/`                                             | Account/worker ownership, request/callback lifetimes and composition dependencies.                                                                          |
| `src/runtime/kernel-method.ts`                             | Shared method capture for preparation/startup; lifecycle checks remain with the calling owner.                                                              |
| `src/features/contacts/`, `src/features/groups/`           | Friend, category, group and request actions/events.                                                                                                         |
| `src/features/messages/`                                   | Message input capture, native projection, querying and recall.                                                                                              |
| `src/features/media/`, `src/features/forward/`             | Media codecs and forward-resource transports.                                                                                                               |
| `src/native/`                                              | Bundle resolution, provenance, storage and native contract checks.                                                                                          |
| `src/native/native-contracts.ts`                           | Pure binary capability registry and matching; no file or host acquisition.                                                                                  |
| `src/native/native-contract-inspection.ts`                 | Worker-owned hashing of the selected wrapper and capture of actual host provenance.                                                                         |
| `src/native/native-manifest.ts`                            | Pure source-option and manifest rules shared by CLI preflight and preparation.                                                                              |
| `src/native/native-directory-verification.ts`              | Read-only integrity verification of an already selected local/npm inventory.                                                                                |
| `src/storage/`                                             | Process/account-directory ownership and locking.                                                                                                            |
| `src/validation/`                                          | Shared pure identity rules; native field-width limits remain with the specific operation.                                                                   |
| `src/contracts/`                                           | Public DTOs owned by client, contacts, groups, messages, forward, native and event domains.                                                                 |
| `src/types.ts`, `src/errors.ts`                            | Compatibility type exports and public errors. Contracts do not import implementation modules.                                                               |
| `test/`                                                    | Deterministic regression fixtures, including worker substitution.                                                                                           |
| `scripts/`                                                 | Build/release entry points and separately authorized account acceptance executors.                                                                          |
| `scripts/consumers/`                                       | Shared consumer contracts used by local and CI verification; no account executor imports.                                                                   |
| `scripts/consumers/client-lifecycle-consumer-contract.mjs` | Controlled parent-client lifecycle verification using the actual source or installed client constructor; owns unspawned worker fixtures.                    |
| `scripts/consumers/worker-error-consumer-contract.mjs`     | Composes parent-client verification with actual worker IPC, synthetic kernel hooks and fatal subprocess checks; owns spawned processes and temporary files. |
| `scripts/consumer-module-policy.ts`                        | The single reviewed consumer directory, exact glue files and computed-import exceptions.                                                                    |

The parent facade and CLI import pure input modules (`query-input`,
`download-input`, `merged-forward-input`, `send-input`, `face-input`, and
`friend-category-input`, `friend-request-input` and
`group-request-input`, `contact-operation-input`, `group-operation-input`, and
`forward-resource-input`).
Native operation modules reuse that implementation and retain internal reexports
for existing contract consumers. Input capture therefore does not require the
parent to depend on native querying, media-file writes, forward submission or
forward-resource protocol decoding. Resource-ID validation owns the exact UTF-8
byte and surrogate rules; the wire module imports those rules and keeps its
compression and schema implementation inside the worker domain.

`friend-category-input` owns category names, uint32 selectors, ordered row capture
and account/category assignment input shared by the facade, CLI and mutation
adapters. `friend-categories` owns native buddy-query validation and public friend
and category projection, and only the contact directory imports it. Neither owner
imports the other. Adding a query field therefore does not change the public
input dependency closure; mutation completion stays with its operation owner.

`features/groups/files/` groups the collaborating group-file owners. `group-files`
binds capability and action lifetime; `group-file-pages` owns correlation and
paging; input and codec modules remain pure; count, deletion and folder protocols
retain their individual acknowledgement rules. Their compatibility barrel remains
reexports only. Public DTOs and account composition stay in their existing layers.

`src/runtime/operations.ts` owns the closed business-operation vocabulary. The
public facade constrains its private operation dispatcher to that union, the
worker derives its classifier from it, and native dispatch handles the same union
exhaustively. The low-level public `request(string, ...)` remains compatible. Adding a name without a corresponding native branch fails type
checking; the worker no longer maintains a second handwritten allowlist.
`src/runtime/operation-contracts.ts` owns the type-only correlated SDK payload and
result tuples used by the facade; it does not validate native ABI or responses.

`runtime/packet-transport` owns byte-request observation for the two forward
protocol adapters. Command admission, schema decoding and domain errors remain
with those callers. Its injected service is an SDK port, not an asserted raw QQ
ABI. See [Packet transport and native evidence](packet-transport.md) for the
measured string-carrier incompatibility and the remaining admission work.

Shared account/group identifier rules belong to `validation/identifiers`, not
to message sending. Group inputs import that pure owner directly; the original
message input exports remain compatible. Transport-specific uint64 limits stay
with the request that requires them, rather than silently narrowing all group
operations. The dependency gate forbids these group inputs from reaching back
into message-send validation.

`client/client-event-presentation` owns the QR image conversion, login error
presentation, message/request delivery, aliases and bounded callback shape audit. The public facade
binds its event sink and exposes independent audit snapshots. The lifecycle owner
filters retired worker events before forwarding them; presentation neither
acquires a worker nor interprets authorization state. SDK-produced state/log/
termination events keep the lifecycle's correlated typed outlet.

`client/message-event` binds `MessageEvent.reply(content, quote = false)` to a
captured conversation and account-operation guard supplied by `QQClient`. It only
captures public send inputs and invokes injected operations; it owns no worker,
account acquisition or native transport. Primary and alias message events share
that reply capability, while worker and historical message DTOs remain data-only.

Message events replace only their peer with a detached immutable snapshot, so
the private/group event types and their reply destination stay consistent.
Malformed routing is diagnosed before either message event is emitted, and
worker-supplied private/group aliases cannot bypass this presentation boundary.
`client/message-segment` constructs typed element DTOs without validation or I/O;
the shared send input owner normalizes text, single elements and readonly mixed
arrays before any client, contact or event reply reaches transport.

`client/request-event` captures friend/group approval identities and binds a
non-enumerable `approve()` function through injected actions and an account guard.
It reuses the existing request input owners and does not perform decisions on
receipt. The request query DTOs remain data-only. The friend adapter emits the
canonical `request.friend`; presentation also accepts the older worker name and
provides its deprecated public alias. Both event names share one capability.

`client/contacts` binds immutable selected IDs to the same account-operation
guard. `ConversationContact<Peer>` shares message queries and recall between
`FriendContact` and `GroupContact`; `GroupMemberContact` owns group-member actions
without pretending to be a friend. `QQClient` injects a typed operation capability
and checks the captured session again after input validation, because caller
getters may retire the session while inputs are being read. The contact layer
imports neither `QQClient` nor its lifecycle, and selects no native services.
Selection performs no I/O; methods return existing operation results. These
objects have no implicit metadata cache or reconnect policy.

The lifecycle validates and commits an online identity before forwarding either
`login` or `ready`. Consecutive readiness notifications for the exact same UIN and
UID preserve that session's contact/reply capabilities. An intervening offline
transition, worker replacement or different identity retires them. Event
presentation captures private/group routing before observers run, so editing a
message view cannot redirect its alias or captured reply destination.

Feature modules may depend on public contracts and narrow native/runtime ports.
They do not import the public Client or compose other account sessions. Relative
internal paths are private; only the package root and CLI are public entry points.

Each public DTO has one declaration in `src/contracts/`. Internal modules import
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

## Native package build ownership

Isolated package tests use `test/helpers/native-package-fixture.ts` to copy the
native package entry's static runtime dependency closure from the architecture
graph. This single owner replaces per-test source inventories, so a new relative
runtime import enters every fixture automatically. Type-only dependencies are
not copied, and unresolved relative imports reject before any file is written.
The graph is inspected without importing SDK implementations. Installed platform
packages, fake native payloads and temporary-directory cleanup remain owned by
each test. This is a source-fixture guarantee, not native compatibility evidence;
reviewed computed loaders do not imply that their runtime targets are copied.

Native storage production lives outside the installed SDK in repository `tools/`.
`native-storage-plan.mjs` owns closed inventory validation, platform/ABI rules,
content deduplication and final package serialization. It reads the supplied archive
map synchronously and returns independently owned gzip and metadata buffers; it
performs no filesystem, process or network IO. Package and manifest metadata are
captured from the validated archive bytes, including nested values, before the
first asynchronous write.

`native-source-identity.mjs` owns the shared pure source identity check. It requires
an independently supplied digest of the complete release manifest bytes and captures
the seven matching package identities, repository, commit and CI run. It does not
validate archives, consumer receipts or codec materials; those remain with the
complete release validator.

`dedup-native-npm.mjs` stages that completed plan into a new directory. Its release
entry point separately verifies the complete source release, invokes npm packing and
reads back the actual packed objects to compare every restored native path.
`verify-dedup-consumer.mjs` checks the candidate and installed receipts against the
same independently bound source. Both entry points retain their frozen historical
source when the digest option is omitted; an explicit digest selects a separately
verified cohort. Explicit invalid values cannot fall back to the historical source.
The generic planner and staging function preserve the supplied package version
without importing a platform's historical release facts into the SDK.

The formal platform build uses `ci/native-package-distribution.mjs` to capture a
closed complete source directory, invoke offline npm packing, and compare actual
packed members before exposing output. Object mode uses the same pure storage
planner and retains a separate plain tarball under `full-native/`; it never mutates
the supplied complete directory. A failed object build fails the job.

`ci/aggregate-release.mjs` retains six full fallbacks and the exact main tarball
tested by each platform, bound to that build's CI identity. Release validation owns
`native-fallbacks.mjs`: it independently compares every original runtime path,
seal, license and byte, checks ABI/npm metadata, and closes both retained artifact
inventories. The final Linux consumer separately binds the final aggregate main.
The candidate downloader restores the declared twelve retained archives from a
closed sidecar before applying the same release checks; it does not install them.

The runtime consumer remains owned by `src/native/native-installed-storage.ts`;
producer tooling never becomes part of client startup. Compression changes delivery
storage, while every original runtime path and byte remains in the restored inventory.

Release-time archive inspection belongs to `scripts/native-package-members.mjs`.
Its per-validation cache reads a tarball once and retains only package/manifest
metadata, the codec and source provenance. `native-object-members.mjs` is the pure
packed-object inspector: it validates the closed archive, all compressed and
original digests/sizes, path references and resource bounds before returning owned
requested members. It performs no installation, native loading or cache hydration.
Plain archives retain their existing inspection path. These release tools are
separate from the installed runtime's filesystem and locking implementation.

`local-first-publish.mjs` owns release receipt policy. An object auxiliary requires
its own complete restoration and warm-cache evidence, exact auxiliary/manifest
digests and a recorded tested main digest. The aggregate receipt additionally binds
the final main archive. Permanent codec-material validation remains separate;
matching codec bytes cannot substitute for installed-storage acceptance.

## Encapsulation and variation points

[Module ownership and interfaces](architecture/encapsulation.md) describes the
implementation owners, injected ports, ordering constraints and native evidence
limits. Start there when changing a module or deciding where an interface belongs.

## Lifecycle and error contracts

[Lifecycle and errors](architecture/lifecycle.md) defines request settlement,
cancellation, account retirement, transactional cleanup and error projection.
These contracts also distinguish deterministic fixtures from native/account proof.

## Registration bridge preflight

The creation root owns registration bridge selection, without expanding the
bundle preparer's interface. An explicit bridge is checked before native
acquisition; Unix adjacent and package fallbacks are selected after bundle
preparation but before account-directory creation or worker fork. Only an absent
adjacent path permits fallback. Existing directories, dangling links or unreadable
files reject, while relative explicit paths preserve the worker's data-directory
base. Windows without an explicit bridge retains its existing internal-ABI path.

These failures are ordinary preflight errors with their filesystem cause retained,
not `KernelRequestError` responses from a worker that has not started. A readable
regular file can still be an incompatible binary: actual loading and its
transactional worker cleanup remain necessary.

Source `7f4e528` passed the complete local gate (2348 SDK tests and 83 tool tests)
and actual installed-package declarations and controlled workers. The same
706,558-byte package then initialized 104 native exports and closed on macOS
ARM64 / Node 24.19.0 / QQ 7.0.2-53644 using a copied verified cache, default public
metadata and a new empty account directory. Its missing-bridge negative case
performed zero metadata downloads and zero worker forks. The mapping probe found
the wrapper and registration bridge, with no QQ application or Electron Framework
images. This is initialization evidence; no login or business operation occurred.
At that earlier snapshot the change was an independent local candidate and
main had not yet been pushed. That gate started with existing compiled files;
the fresh-checkout evidence below supersedes its build-order scope. See the [bounded receipt](evidence/native-bridge-preflight-7f4e528-local.json).

## Fresh consumer and exited-worker repairs

Both noEmit tooling projects resolve the public self import to the source entry,
so examples retain their normal `qq-native-client` import before a build exists.
Production and installed declaration checks keep their independent module lookup.
The test pre-hook compiles the actual production entry after consumer-role checks;
full native build and installed-package checks still run afterwards.

Close skips its IPC request only when the worker already has an exit code or a
termination signal. It retains account retirement, pending-request rejection and
termination cleanup. A disconnected worker without confirmed exit still rejects
and follows the existing termination policy. Concurrent callers share the close
promise in both cases.

Candidate `17240b6` passed a complete check starting without `dist`: 2356 SDK tests,
83 tool tests, formatting, lint, strict types, build and installed consumers.
The exact 708,528-byte package initialized 104 native exports and closed on macOS
ARM64 in a new empty account directory, without login. Its installed public client
also closed the same pre-exited worker fixture that exposed the CI failure.
See the [bounded receipt](evidence/fresh-consumer-close-17240b6-local.json).

The approved main commit `3f8cc4b` was pushed. Its three GitHub workflows completed
with failure: fresh self-import resolution in SDK quality, pre-exited worker close
in all six native-package consumers, and a missing bridge in the old public Linux
ARM64 version row. All six video builds and the materials prerelease succeeded.
The local repairs have not been pushed or accepted by those workflows, and the
old public manifest still requires a separate bridge correction and validation.

## Quality gates

[Quality gates and evidence](architecture/quality-gates.md) describes compiler,
lint, dependency, installed-consumer and CI checks, including their proof limits.
See the [Development guide](development.md) for the maintenance workflow.
