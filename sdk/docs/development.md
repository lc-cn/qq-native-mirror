# Development guide

Start with [Architecture and maintenance contracts](architecture.md). The package
root is the application interface; internal file paths are private. Detailed
module contracts live in [Encapsulation and variation points](architecture/encapsulation.md),
and cancellation/error ordering lives in [Lifecycle and errors](architecture/lifecycle.md).
This guide describes the change workflow instead of repeating each implementation.

## Choose the owner before writing code

| Change                                | Owner                                                       | Constraint                                                                                    |
| ------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Public DTO, option or event           | Relevant `src/contracts/` domain                            | Declarations only; domain types cannot depend on implementations or the event table.          |
| Client method or event presentation   | `src/client/qq-client.ts` or `client-event-presentation.ts` | Preserve the public interface; do not acquire native services or bundle files here.           |
| Bundle selection and worker creation  | `src/client/create-client.ts`, `src/native/`                | Validate options before IO; keep selection, integrity verification and installation separate. |
| Worker/account/request lifetime       | Existing owner in `src/runtime/`                            | One owner for state, timers, pending work and retirement.                                     |
| Node acquisition and IPC              | `src/worker/bootstrap.ts`, `src/worker.ts`                  | Bootstrap binds resources; the worker entry routes IPC.                                       |
| Native operation, projection or input | Relevant `src/features/` domain                             | Pure input capture is shared by facade and worker; native results start as `unknown`.         |
| Account composition                   | `src/kernel.ts`, `src/native-services.ts`                   | Bind narrow ports, register cleanup and route calls; business rules stay in their domains.    |
| Shared identity or storage invariant  | `src/validation/`, `src/storage/`                           | Share a real invariant; operation-specific native widths stay with the operation.             |
| CLI command                           | `src/cli/commands/`                                         | Define flags and a captured action together; validate before creating a client.               |
| Package build/release                 | `scripts/` and repository `tools/`                          | Keep production tooling outside client startup and reusable consumer contracts.               |

Before adding a module, name its responsibility, state it owns, callers and
actual variation point. Reuse an existing owner when those facts have not changed.
A file move, thin forwarding wrapper or new base class alone does not improve the
architecture. A generic module must remove repeated knowledge from real callers.

The source inventory is closed to regular `.ts` files. Every file needs a reviewed
layer or domain, including modules without imports. Dependency permissions include
type-only imports and must stay acyclic. Exact cross-domain pairs and composition
imports live in `test/helpers/dependency-policy.ts`; exact IO and third-party
owners live in `test/helpers/external-dependencies.ts`. Update permissions only to
express the actual ownership relationship, and remove obsolete grants with imports.
New files do not inherit loader, transport or composition exceptions.

Run `npm run check:architecture` while changing ownership. It reads source syntax
without importing the SDK. Passing it does not replace the full package gate.

## Design the interface and lifetime together

Keep credentials, native handles, pending maps, timers and request IDs private.
Accept named dependencies with only the methods the module uses. Production and
controlled tests should cross that same interface. Use composed ports for real
transport, codec and platform variation. Inheritance serves the public
`EventEmitter` client and error hierarchy; unrelated native operations do not
become substitutable because they share method names.

Capture caller-owned input before IPC, IO or UID resolution. Reuse the pure
feature input module in the facade, worker and CLI. Preserve omitted versus
explicit values, string identifiers and the operation's native field limits.
Capture a method once, preserve its original receiver, and recheck retirement
after every fallible acquisition or native-field inspection. Check retirement
when an inspection throws too; an active native error cannot overwrite an
already established cancellation reason.

The account composition derives `NativeServicePorts` from existing domain getter
contracts. Extend the domain port before wiring a method. Use its typed `callPort`
for known business calls; proprietary Session acquisition and listener registration
retain the reviewed dynamic seam. Do not assert results as public DTOs or duplicate
an aggregate native ABI. Capability decisions require independent binary evidence.

Acquire resources transactionally and register cleanup immediately. Close detaches
owned state before fallible cleanup, attempts every cleanup once, rejects pending
work and observes late completion. Preserve local-feature, request, account and
worker retirement as distinct lifetimes. Propagate cancellation across IPC through
its existing owner. Never replay a dispatched mutation, guess a native destructor
or clear callback references before their native release contract is known.

See the relevant [module contracts](architecture/encapsulation.md) for exact
callback correlation, ACK, cache commit, projection and ordering rules. Keep those
rules with their operation rather than introducing a universal native-result parser.

## Follow a change through its callers

1. Update the domain contract and pure input capture. Public type changes update
   `test/fixtures/public-type-names.json` and installed-consumer expectations.
2. Add the facade method and closed operation name in `runtime/operations.ts`.
   Bind its payload/result tuple in `runtime/operation-contracts.ts` and preserve
   exhaustive native dispatch. The public low-level `request` stays compatible.
3. Implement the domain behavior behind narrow ports. Composition only binds
   those ports and routes the call; the CLI invokes the public client.
4. For callbacks, extend the existing domain projector and event/request owner.
   Do not register a parallel listener for an existing shared channel.
5. Document caller-visible ordering, cancellation, errors and proof limits.
   Comments explain a constraint or ownership decision, not each statement.

New platform support needs an exact binary profile and reviewed native contract;
a name match, method count or another architecture's evidence is insufficient.
Bundle producer changes belong to repository `tools/`; the installed runtime
consumer remains in `src/native/`. Preserve complete-package fallback and original
runtime bytes. Historical receipts, source pins and account plans are immutable
references rather than inputs to silently rebind to current code.

## Verify behavior and the delivered package

Start with a focused reproducer and check the observable interface: callback before
failure, wrong correlation, malformed input/results, close during a wait or field
inspection, late rejection, partial acquisition and cleanup failure. Exercise
original receiver identity and no retry where those are part of the contract.
Use an injected adapter instead of editing private state. A test that merely
repeats implementation branches provides little protection.

```sh
npm ci --ignore-scripts
npm run check:architecture
npm run check
```

`check` runs Prettier, zero-warning ESLint, native-storage tooling checks, strict
types, deterministic tests, a clean build and a newly packed/installed consumer.
See [Quality gates](architecture/quality-gates.md) for exact static coverage and
limits. The consumer uses controlled services and a replacement kernel; it does
not load QQ or authenticate an account. Always rebuild from clean `dist` to catch
obsolete emitted files and declaration dependencies.

Keep reusable installed-consumer contracts in `scripts/consumers/`. They share a
strict checked-JavaScript project and typed Promise lint. New helpers inherit
those directory gates. Use faithful typed adapters and local declarations for
dynamic imports; do not conceal a broken verification contract with whole-module
`any`, unchecked assertions or broad lint/type suppressions. Negative compiler
and lint fixtures must reject defective verification code without executing it.

`scripts/consumer-module-policy.ts` separates consumer helpers, exact orchestration
files, build/release tools and account executors. `pretest` and `preverify:package`
run the syntax/role preflight before consumer execution. Use npm entry points;
direct `node` invocation and `--ignore-scripts` skip these hooks. The post-build CI
module-path gate additionally requires referenced compiled modules. Passing a
syntax/reference check does not establish type or runtime correctness.

## Keep account acceptance separate

Deterministic tests, installed-consumer checks, platform initialization and real
account acceptance establish different facts. Report the source revision, archive
and bundle digests, platform/version, actual check exit and remaining limits.
Never promote substituted worker behavior to native or real-account proof.

Historical read-only batches use `scripts/readonly-sdk-acceptance.ts`; versioned
entry scripts contain immutable batch facts. Review mode verifies hashes without
importing the installed SDK or using an account. Execution needs a separately
authorized batch and `--execute-approved`; the flag itself is not authorization.
Exclusive reservation precedes runtime acquisition and remains after uncertain
execution. Receipts contain counts and fixed error categories, not contact or
message contents. Do not copy the executor, change a historical plan to fit newer
artifacts or reuse a consumed account operation.
