# Architecture and maintenance contracts

The package exposes `createClient`, `QQClient`, public DTOs and a CLI. The native
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

| Location                                         | Responsibility                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                   | Public exports only; preserves the package interface without acquiring resources.                          |
| `src/client/qq-client.ts`                        | Public client facade and typed operations; composes lifecycle and event presentation.                      |
| `src/client/client-event-presentation.ts`        | Worker event presentation and bounded callback shape audit; no lifecycle, transport or native acquisition. |
| `src/client/create-client.ts`                    | Native bundle selection, worker bootstrap and transactional initialization.                                |
| `src/cli.ts`, `src/worker.ts`                    | Executable entry points. Their emitted URLs are runtime contracts.                                         |
| `src/cli/`                                       | Command planning and ownership of client execution, QR output, watches and process signals.                |
| `src/cli/commands/`                              | Domain definitions pairing accepted flags with a captured public-client action plan.                       |
| `src/cli/command-plan.ts`                        | Compose the single command registry, reject duplicate names and capture flags before planning.             |
| `src/cli/command-input.ts`                       | Shared argument parsing and primitive flags; no command or client acquisition dependencies.                |
| `src/kernel.ts`, `src/native-services.ts`        | Compose one native session and domain adapters. They are composition roots, not public extension points.   |
| `src/worker/`                                    | Native initialization ownership and the Node acquisition binding; no business DTO or IPC presentation.     |
| `src/runtime/`                                   | Account/worker ownership, request/callback lifetimes and composition dependencies.                         |
| `src/runtime/kernel-method.ts`                   | Shared method capture for preparation/startup; lifecycle checks remain with the calling owner.             |
| `src/features/contacts/`, `src/features/groups/` | Friend, category, group and request actions/events.                                                        |
| `src/features/messages/`                         | Message input capture, native projection, querying and recall.                                             |
| `src/features/media/`, `src/features/forward/`   | Media codecs and forward-resource transports.                                                              |
| `src/native/`                                    | Bundle resolution, provenance, storage and native contract checks.                                         |
| `src/native/native-contracts.ts`                 | Pure binary capability registry and matching; no file or host acquisition.                                 |
| `src/native/native-contract-inspection.ts`       | Worker-owned hashing of the selected wrapper and capture of actual host provenance.                        |
| `src/native/native-manifest.ts`                  | Pure source-option and manifest rules shared by CLI preflight and preparation.                             |
| `src/native/native-directory-verification.ts`    | Read-only integrity verification of an already selected local/npm inventory.                               |
| `src/storage/`                                   | Process/account-directory ownership and locking.                                                           |
| `src/validation/`                                | Shared pure identity rules; native field-width limits remain with the specific operation.                  |
| `src/contracts/`                                 | Public DTOs owned by client, contacts, groups, messages, forward, native and event domains.                |
| `src/types.ts`, `src/errors.ts`                  | Compatibility type exports and public errors. Contracts do not import implementation modules.              |
| `test/`                                          | Deterministic regression fixtures, including worker substitution.                                          |
| `scripts/`                                       | Build/release entry points and separately authorized account acceptance executors.                         |
| `scripts/consumers/`                             | Shared consumer contracts used by local and CI verification; no account executor imports.                  |
| `scripts/consumer-module-policy.ts`              | The single reviewed consumer directory, exact glue files and computed-import exceptions.                   |

The parent facade and CLI import pure input modules (`query-input`,
`download-input`, `merged-forward-input`, `send-input`, `face-input`, and
contact-category projection/validation, `friend-request-input` and
`group-request-input`, `contact-operation-input`, `group-operation-input`, and
`forward-resource-input`).
Native operation modules reuse that implementation and retain internal reexports
for existing contract consumers. Input capture therefore does not require the
parent to depend on native querying, media-file writes, forward submission or
forward-resource protocol decoding. Resource-ID validation owns the exact UTF-8
byte and surrogate rules; the wire module imports those rules and keeps its
compression and schema implementation inside the worker domain.

`src/runtime/operations.ts` owns the closed business-operation vocabulary. The
public facade constrains its private operation dispatcher to that union, the
worker derives its classifier from it, and native dispatch handles the same union
exhaustively. The low-level public `request(string, ...)` remains compatible. Adding a name without a corresponding native branch fails type
checking; the worker no longer maintains a second handwritten allowlist.
`src/runtime/operation-contracts.ts` owns the type-only correlated SDK payload and
result tuples used by the facade; it does not validate native ABI or responses.

Shared account/group identifier rules belong to `validation/identifiers`, not
to message sending. Group inputs import that pure owner directly; the original
message input exports remain compatible. Transport-specific uint64 limits stay
with the request that requires them, rather than silently narrowing all group
operations. The dependency gate forbids these group inputs from reaching back
into message-send validation.

`client/client-event-presentation` owns the QR image conversion, login error
presentation, message aliases and bounded callback shape audit. The public facade
binds its event sink and exposes independent audit snapshots. The lifecycle owner
filters retired worker events before forwarding them; presentation neither
acquires a worker nor interprets authorization state. SDK-produced state/log/
termination events keep the lifecycle's correlated typed outlet.

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

## Native package build ownership

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

## Quality gates

[Quality gates and evidence](architecture/quality-gates.md) describes compiler,
lint, dependency, installed-consumer and CI checks, including their proof limits.
See the [Development guide](development.md) for the maintenance workflow.
