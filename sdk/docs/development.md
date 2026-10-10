# Development guide

Start with [Architecture and maintenance contracts](architecture.md). The package
root is the application interface; internal file paths are not extension points.
Use `npm run check` before submitting a change. The same checks run in SDK quality
CI, including installation of a newly packed archive. A passing fixture test does
not establish interoperability with QQ or prove an account operation succeeded.

## Choose the owner before writing the code

| Change                                                        | Owner                                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Public data shape or event payload                            | Relevant `src/contracts/` domain; compose event tuples in `events.ts`                     |
| Public client method or callback presentation                 | `src/client/qq-client.ts`; `index.ts` remains a reexport-only entry                       |
| Native bundle selection and worker bootstrap                  | `src/client/create-client.ts`                                                             |
| Shared account/group identifier rules                         | `src/validation/identifiers.ts`; preserve string IDs and operation-specific native limits |
| Pure validation and input snapshots                           | Feature input module, shared by facade and worker                                         |
| Native callback projection or operation                       | Relevant `src/features/` domain                                                           |
| Request correlation, shutdown or account ownership            | Existing `src/runtime/` lifetime owner                                                    |
| Bundle source selection and manifest constraints              | `src/native/native-package.ts`                                                            |
| Mirror installation transaction and content cache             | `src/native/native-bundle-installer.ts`; package locking stays in `src/storage/`          |
| Worker initialization state and candidate ownership           | `src/worker/native-bootstrap.ts`; reserve initialization before any await                 |
| Bind Node addon loading, codecs and account-directory locking | `src/worker/bootstrap.ts`; `worker.ts` remains the IPC entry                              |
| Prepare local engine/login configuration                      | `src/runtime/kernel-environment.ts`; no connection or authentication                      |
| Compose an authenticated Session and feature adapters         | `kernel.ts` and `native-services.ts`                                                      |
| CLI flags and client execution                                | `src/cli/`; executable entry remains `cli.ts`                                             |

Follow the change through its owners:

- A new operation starts in its domain contract and pure input capture. Add the
  facade method and closed operation name, then the domain adapter and exhaustive
  native dispatch. The CLI calls the public client. Validate the native contract
  before enabling a platform capability.
- A received callback starts in the domain projector. Route it through the
  existing event/request owner and public event contract; test delivery, late
  callbacks and close through that owner. Do not add a parallel native listener.
- A bundle/bootstrap change starts in native selection or the worker acquisition
  binding. Test the transaction owner, the real binding semantics and the packed
  worker. Platform initialization CI checks the actual addon separately.

Avoid a catch-all `utils`, `common` or base class for unrelated operations. A helper
belongs next to the invariant it protects. Share it when callers actually have
that same invariant, not because their code happens to look similar.

`features/groups/group-web-reads.ts` owns the three account-bound HTTP read
operations. It combines the request and account signals, checks the account and
awaits the complete operation. Inject ticket/domain-key methods and the account
wait port there; keep endpoint exchange, pagination and DTO validation in their
existing group modules. The composition root only supplies ports and routes.

Native callback wrappers belong to `runtime/native-listener-owner`; business
callback definitions and registration order belong to composition. Supply a
captured registration function instead of a Session or service locator. Keep
listener references for the worker lifetime until a removal ABI is verified;
account close is not proof that the native kernel released a callback pointer.

Every source file must have a reviewed layer or domain, including files without
imports. The TypeScript dependency gate includes type-only edges and TypeScript
`import = require()` declarations. Cross-feature cooperation
requires an exact module pair with a reason in `test/helpers/dependency-policy.ts`.
Computed imports and CommonJS loaders need a reviewed owner and exact loading
form; new files do not inherit an existing loader exception. Features may use
narrow typed ports but cannot depend on the account composition context.
Changing the policy should explain the real ownership relationship; granting an
entire directory access to another one makes future coupling invisible.

All source dependencies, including erased type imports, must remain acyclic.
External IO and third-party imports require an exact source owner and import kind
in `test/helpers/external-dependencies.ts`; removing an import also removes its
permission. Computed `createRequire` namespace access does not bypass review.

## Design a small interface with explicit lifetime

Keep state private to its owner. Request IDs, pending maps, credentials, timers and
native handles must not escape as mutable configuration. Prefer a named context
for dependencies and return projected DTOs. A feature should not recreate worker
ownership or add another callback listener for an existing shared channel.

Inject only the methods a module actually uses, rather than a full Session or a
string-based service locator. Keep proprietary return values `unknown` at that
interface, acquire methods lazily and preserve their native receiver. A getter may
synchronously close or abort the owner: check lifetime after acquisition and
before dispatch. Compile-only negative contracts keep these ports narrow.

Use composition for domain operations. Interfaces support polymorphism where an
implementation actually varies: the worker transport and bundled/custom media
codecs already have production and controlled-test adapters. Inheritance is
appropriate for the existing `EventEmitter` client contract and error classes;
sharing a superclass does not make different native operations interchangeable.

Factories acquire resources transactionally. Register cleanup as each resource is
acquired, unwind on construction failure, and release all resources on close even
if an earlier cleanup throws. Close must detach owned state before invoking
fallible external cleanup. Async work rechecks lifetime before publishing or
dispatching another operation. Do not retry an already dispatched mutation.

Cancellation must have an owner at both ends of IPC. Capture the original worker
when sending, detach the pending entry before signalling it, and propagate the
request's signal through each cancellable await and dispatch. Only classify an
operation as cancellable after its implementation cooperates with that signal.
Keep request cleanup separate from account shutdown; observe a losing native
promise even when it cannot be undone.

## Preserve the public contract

Place new declarations in the relevant contract domain. Internal implementations
import that file directly; `types.ts` remains a compatibility export surface.
Contracts contain no executable code, and their type graph must stay acyclic.
Keep internal Session and codec ports in their implementation layers.

Adding or changing an exported type requires updating
`test/fixtures/public-type-names.json` and installed-consumer expectations when
appropriate. Keep existing aliases and discriminated unions precise. Native
unknown values enter through adapter validation rather than spreading `any` into
the application interface. Capture caller-owned input before awaiting IO.

Document ordering, cancellation, error fields and evidence limits when they affect
the caller. Comments explain the native constraint or ownership decision; avoid
comments that repeat a method's name or narrate each line.

## Verify through the same interface callers use

Exercise useful behavior: failure after an early callback, close during a wait,
late completion, wrong correlation, invalid rows, partial acquisition and cleanup
failure. Prefer an injected adapter at an existing substitution point to modifying
private state for a test. Use a reproducer for a lifecycle bug before fixing it.

The package gate checks the actual archive, imports its public root, compiles its
declarations and exercises its worker routing with controlled services. It also
rejects missing declaration dependencies and private/development files in the
archive. The shared worker-bootstrap consumer also verifies compiled IPC and
real directory-lock ownership with replacement native/kernel ports. Changes to
the platform consumer orchestrator trigger SDK quality as well as native CI.
Always rebuild from clean `dist`; source tests cannot detect obsolete
emitted modules left in a package.
