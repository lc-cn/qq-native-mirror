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

| Location                                         | Responsibility                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                   | Public exports only; preserves the package interface without acquiring resources.                        |
| `src/client/qq-client.ts`                        | Public client facade, callback presentation and typed operations.                                        |
| `src/client/create-client.ts`                    | Native bundle selection, worker bootstrap and transactional initialization.                              |
| `src/cli.ts`, `src/worker.ts`                    | Executable entry points. Their emitted URLs are runtime contracts.                                       |
| `src/cli/`                                       | Command planning and ownership of client execution, QR output, watches and process signals.              |
| `src/kernel.ts`, `src/native-services.ts`        | Compose one native session and domain adapters. They are composition roots, not public extension points. |
| `src/worker/`                                    | Native initialization ownership and the Node acquisition binding; no business DTO or IPC presentation.   |
| `src/runtime/`                                   | Account/worker ownership, request/callback lifetimes and composition dependencies.                       |
| `src/features/contacts/`, `src/features/groups/` | Friend, category, group and request actions/events.                                                      |
| `src/features/messages/`                         | Message input capture, native projection, querying and recall.                                           |
| `src/features/media/`, `src/features/forward/`   | Media codecs and forward-resource transports.                                                            |
| `src/native/`                                    | Bundle resolution, provenance, storage and native contract checks.                                       |
| `src/storage/`                                   | Process/account-directory ownership and locking.                                                         |
| `src/validation/`                                | Shared pure identity rules; native field-width limits remain with the specific operation.                |
| `src/contracts/`                                 | Public DTOs owned by client, contacts, groups, messages, forward, native and event domains.              |
| `src/types.ts`, `src/errors.ts`                  | Compatibility type exports and public errors. Contracts do not import implementation modules.            |
| `test/`                                          | Deterministic regression fixtures, including worker substitution.                                        |
| `scripts/`                                       | Build tools, installed-consumer checks and separately authorized acceptance executors.                   |

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
