# Quality gates

Use Node 24 and npm. `package-lock.json` fixes the development dependency tree.
TypeScript is pinned to a version supported by the installed type-aware ESLint
parser; upgrades must update both and pass the gates together.

```sh
npm ci --ignore-scripts
npm run format
npm run check
```

`check` runs formatting, zero-warning ESLint, strict source/test type checking,
strict checking of the governed consumer tooling,
deterministic tests, a clean build and verification of a newly packed/installed
consumer. The package consumer uses fake services and an isolated replacement
kernel; this command does not log into an account. Codec dependencies are packed
from npm's populated cache for the offline consumer installation.

Architecture checks cover ambient `fetch` acquisition as well as import edges.
Only the catalog, manifest download and group HTTP transport owners may acquire
the global implementation. TypeScript symbol resolution detects direct access,
literal property access (including constant keys), destructuring and alias capture; local methods named
`fetch` and type-only transport declarations do not count as network access.
The check prevents this visible responsibility drift; it is not a sandbox or a
proof against arbitrary JavaScript evaluation or computed runtime property names.

The installed-consumer gate also checks the complete compatibility type inventory and
every relative dependency in the actual packed declaration graph. Positive and
negative consumers preserve peer/login discrimination, event payload types,
received versus sendable elements, receipt inheritance and notice aliases.
Updating the public type inventory is an intentional interface change; moving a
declaration between owned domains must not change its name or shape.

The `SDK quality` GitHub workflow runs these gates independently of platform
bundle and video-native CI. Runtime output is recreated from a clean `dist`
directory so obsolete emitted modules cannot make a packaging check pass.

`tsconfig.scripts.json` governs all TypeScript scripts, the client-factory, shared worker-delivery, face,
group-search, group-essence, group-file page, element-preparation and mirror consumers, and the module-reference
collector. Checked consumers bind dynamic installed imports to their source
contracts. The client-factory consumer types its public
factory, captured worker options and initialization payloads while running the
actual worker with a replacement kernel and addon loader. Invalid source-option
fixtures cross an explicitly opaque input seam; ordinary calls keep the real
`ClientOptions` contract. Compiler and lint fixtures reject missing factory awaits,
incorrect options and ignored verification Promises without executing workers.
The platform-package verifier runs the same client-factory check and records it
under `clientFactoryChecks`, separately from real native preparation and codec
results. Its replacement loader and kernel establish factory/IPC behavior only.
The face consumer returns a valid synthetic send receipt through the
installed Client and controlled IPC. The group-search CLI action uses the same
controlled worker and returns a complete `GroupSearchMatch`. Group essence
traversal keeps its synthetic ticket/HTTP adapter and verifies page completion,
overlap rejection and credential projection. Its installed CLI action uses the
actual Client and controlled worker, returning complete `GroupEssenceMessage`
DTOs rather than the numeric result of a fixture array push. Element preparation
uses narrow media-staging and message-ID ports; its checked constructors preserve
receivers, input variants and asynchronous results. The mirror consumer accepts a
narrow client factory and verifies cold/warm downloads, exact metadata and native
file bytes, and retirement of each client. Its deterministic tests substitute the
factory; the separate current-source workflow exercises real platform bundles
without an account.

Type-aware lint in TypeScript source and governed consumer tooling rejects
unobserved Promises even when prefixed with `void`. Source gate fixtures replace
an actual observed background invocation with bare and `void` invocations and
require lint failure without executing either mutation. Isolated subprocess tests
cover connection, authentication polling and Session startup observer failures;
they preserve Node's default fatal exception handling and also test the `warn`
unhandled-rejection setting. These tests use controlled services, never an account.
Source `no-misused-promises` also rejects asynchronous EventEmitter callbacks whose
returned Promise would be discarded. Its negative fixture substitutes the actual
IPC message handler without running it. Shared worker-delivery checks run against
the source entry and newly installed compiled entry with a controlled bootstrap
and failing sender. They verify one business invocation, one reply attempt, fatal
exit for result/error/close-ack delivery failure, the exit release hook and normal
acknowledged close. They do not initialize a native addon or prove real lock release;
bootstrap lock ownership has its separate controlled acquisition tests.
Negative gate fixtures prove that missing preparation/action awaits, invalid
receipts and missing video thumbnail guards fail without executing those
fixtures. Other JavaScript acceptance helpers still receive syntax lint; strict
JavaScript checking remains an explicit migration.

The module-reference collector reads the local packed verifier and platform
consumer helper closures without executing them. It checks supported static
installed-module paths, including reviewed local loader calls and split path
joins. Computed fixture paths require exact reviewed exceptions. This protects
file references in the current build; exports, archive inclusion, generated
fixture code and native behavior remain covered by their separate executable
checks. All `ci/` changes now trigger SDK quality as well as platform CI.

Static architecture tests require every TypeScript source module to participate
in the formatting gate. Binary-directory ignores are anchored to the package root
so `src/native/` remains checked. They also reject source dependency cycles including erased type imports, missing internal
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

`features/messages/recall-operation` owns recall correlation and completion:
chat type, native peer UID and message ID must all match, and a matching update
still waits for the native invocation to succeed. Composition injects peer
resolution, the shared callback channel and only `recallMsg`; it does not retain
the predicate or acquire a second listener. Close and late failure observation
remain with the shared channel and Session lifetime.

Every source module's external imports are checked against exact resource owners
in `test/helpers/external-dependencies.ts`, including the runtime/type-only kind.
A new feature cannot acquire filesystem, process or third-party dependencies by
inheriting its directory's permissions. Obsolete ownership entries fail the check.
The loader extractor detects computed namespace factories and aliases; reviewed
codec loading forms remain limited to their exact owner and syntax.

Comments should explain constraints, ownership, ABI evidence or decisions that
are not evident from the code. Keep native provenance references next to the
adapter contract. Avoid restating method names or adding a pattern without a real
variation point. Add tests for lifetime, correlation and input/projection
boundaries; do not mirror implementation line by line.

Installed action checks exercise the compiled contact/group adapters and the real
Session lifetime with controlled services. Their consumer helper has its own
module in `scripts/`, rather than embedding action behavior in the packaging
orchestrator. No native addon or account is used by these checks.

See [Development guide](../development.md) for the workflow and module placement rules.

[Architecture overview](../architecture.md) · [Development guide](../development.md)
