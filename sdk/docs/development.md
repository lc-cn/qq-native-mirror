# Development guide

Start with [Architecture and maintenance contracts](architecture.md). The package
root is the application interface; internal file paths are not extension points.
Use `npm run check` before submitting a change. The same checks run in SDK quality
CI, including installation of a newly packed archive. A passing fixture test does
not establish interoperability with QQ or prove an account operation succeeded.

## Choose the owner before writing the code

| Change                                                | Owner                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| Public data shape or event payload                    | Relevant `src/contracts/` domain; compose event tuples in `events.ts` |
| Pure validation and input snapshots                   | Feature input module, shared by facade and worker                     |
| Native callback projection or operation               | Relevant `src/features/` domain                                       |
| Request correlation, shutdown or account ownership    | Existing `src/runtime/` lifetime owner                                |
| Platform archive selection, provenance or cache       | `src/native/`; locking remains in `src/storage/`                      |
| Compose an authenticated Session and feature adapters | `kernel.ts` and `native-services.ts`                                  |
| CLI flags and client execution                        | `src/cli/`; executable entry remains `cli.ts`                         |

Avoid a catch-all `utils`, `common` or base class for unrelated operations. A helper
belongs next to the invariant it protects. Share it when callers actually have
that same invariant, not because their code happens to look similar.

The TypeScript dependency gate includes type-only edges. Cross-feature cooperation
requires an exact module pair with a reason in `test/helpers/dependency-policy.ts`.
Changing the policy should explain the real ownership relationship; granting an
entire directory access to another one makes future coupling invisible.

## Design a small interface with explicit lifetime

Keep state private to its owner. Request IDs, pending maps, credentials, timers and
native handles must not escape as mutable configuration. Prefer a named context
for dependencies and return projected DTOs. A feature should not recreate worker
ownership or add another callback listener for an existing shared channel.

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
archive. Always rebuild from clean `dist`; source tests cannot detect obsolete
emitted modules left in a package.
