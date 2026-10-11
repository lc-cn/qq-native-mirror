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

`npm run check:native-storage` checks the repository's native storage producer and consumer verifier with
the same pinned Prettier and zero-warning ESLint dependencies, then runs its closed
inventory, platform metadata, asynchronous input ownership and packed SDK identity regressions. It is
part of `check` and the SDK quality workflow. `tools/check-native-storage.mjs` lists
the covered producer, planner, pure source identity check, consumer verifier,
tests and gate/configuration files explicitly;
unrelated historical research tools are not included. These JavaScript build tools
have formatting and lint coverage, without a claim of TypeScript type checking.
The platform candidate workflow also runs the same producer regressions before
building. The consumer verifier shares one packed-module inspection between SDK
binding and receipt verification; its portable tar fixtures reject obsolete-only
loader paths and unrelated package identities. None of these deterministic tests
loads QQ or uses an account.

Source identity regressions require an independent manifest digest, reject missing
or malformed trust roots and mismatched seven-package cohorts, and preserve owned
nested metadata after caller mutation. Producer and consumer option regressions
capture the source digest once and reject explicit `null`; omission alone selects
the frozen historical source. Future package versions retain their original version
metadata without weakening the measured native export or Windows ABI requirements.

The npm `pretest` and `preverify:package` hooks first run
`check:consumer-modules`. This static preflight shares
`consumer-module-policy.ts` with the CI module-path gate. It permits the
consumer directory and exact orchestration files, with no directory-wide access
to account acceptance or publication executors. It checks syntax and relative
module roles without executing helpers. Before a build it does not require `dist`;
the post-build CI gate additionally requires every referenced compiled module.

| Tool scope                               | Static coverage                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| SDK source and TypeScript scripts        | Formatting, lint and strict type checking; source and governed scripts also use typed Promise lint.                       |
| `scripts/consumers/` JavaScript helpers  | All have formatting, strict types, typed Promise lint and consumer-role graph checks. New helpers inherit the same gates. |
| CI/version orchestration                 | Exact files in the consumer graph have syntax/reference checks. The SDK lint/type project does not cover every CI tool.   |
| Account acceptance and publication tools | Explicit execution entry points; outside the reusable consumer directory and consumer-role permissions.                   |

These role checks constrain visible module imports, not arbitrary JavaScript
execution. JavaScript orchestration and account executors outside the consumer
directory have their separately documented coverage.

Generated worker hooks remain string data to this strict project. Their runtime
behavior is covered by the controlled worker checks; generated public-type
consumers are compiled by their declaration-contract checks. Directory-wide
checking does not establish static type coverage for every generated hook body.

`npm run check:architecture` exposes the source architecture checks separately
for module placement and dependency changes. They still run in the full `test`
gate. Kernel method capture has exactly three permitted owners: kernel
composition, environment preparation and account startup. It cannot acquire
resources or depend on a lifecycle implementation. Regression tests verify
single method acquisition, original receivers, retirement during getters and
no fallback after native dispatch failure with controlled objects.

The architecture runner is `test/architecture.test.ts`. It loads five focused
suites in `test/architecture/`: dependency direction, module ownership,
composition, contracts and resources. `test/helpers/source-graph.ts` reads the
source inventory once and supplies the same graph to each suite; it never imports
the SDK. Add a rule to its owning suite. A new suite must be wired into the runner,
so standalone and full test commands exercise the same assertions.

Resource checks also reject acquisition of Node's `process.getBuiltinModule`
loader. Builtins must use explicit imports subject to the exact owner policy.
Symbol resolution covers literal and constant keys, aliases and destructuring,
while local methods and type-only declarations do not acquire the loader. These
checks constrain visible resource acquisition; they do not establish a sandbox
against arbitrary JavaScript execution.

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
group-search, group-query owner, contact/group snapshot, group-essence, group-file page, element-preparation and mirror consumers, and the module-reference
collector. Checked consumers bind dynamic installed imports to their source
contracts. The group-query owner consumer uses the installed query module and
shared callback channel to check input rejection, local cancellation of stalled
queries and continued sibling operations. Its native services are controlled;
these results do not prove account queries or native interoperability.
The contact/group snapshot consumer imports the installed domain owners and
checks single-read mutation options, profile projection, captured error codes and
retirement during result access, including accessors that close and throw and
contact Proxy presence checks that retire before value access. Active thrown
errors keep their identity, and receipt reads and dispatches remain single-shot.
Both local and platform verifiers await it and
record `contactGroupSnapshotChecks`. Strict compiler and lint negative fixtures
reject invalid native ports and ignored mutation Promises without running them.
The same helper imports the installed facade and CLI to verify eleven management
preflight paths, detached options and captured command plans through a controlled
IPC transport. Source and compiler regressions require correlated action inputs
and populated internal IPC defaults without changing optional public options.
Both management input modules participate in the pure runtime-closure check;
dependency fixtures also forbid type imports from native execution or runtime
owners. These checks establish validation and routing, not account authorization
or remote management effects.
The client-factory consumer types its public
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
fixtures. JavaScript release and account executors outside the consumer directory
still receive basic lint; they do not inherit the consumer directory's strict project.

History/account-session and worker read/error consumers also retain their actual
SDK constructor, operation and lifecycle types. Compiler fixtures reject invalid
login and lifecycle arguments; typed lint rejects dropped login, preparation and
shutdown assertions. These negative fixtures parse modified source without
executing it. The platform installed-consumer entry calls the shared read/error
checks against the installed worker with controlled kernel hooks. Their receipts
are distinct from real native initialization and contain no account proof.

In-memory typed lint fixtures disable automatic single-run inference so their
changed contents are reparsed with a persistent program, including under
`CI=true`. Production ESLint configuration and promise rules stay unchanged.
Use the same CI environment when validating a lint fixture; a local negative
diagnostic alone does not establish that the CI fixture will behave identically.

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

The capability registry participates in the pure runtime-closure check. Exact
resource ownership gives hashing/file access only to the worker's binary
inspector, and dependency fixtures reject service, feature and newly added
native modules importing it. Controlled file tests preserve unknown-version
preflight, host/digest provenance and original read failures without loading an
addon or interpreting a new binary's capabilities.

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

Group-file source regressions close the actual domain owner during outer status,
inner status, creation fields and selected count-array descriptor inspection.
They require the close error, one native dispatch and no subsequent field reads.
The existing installed group-file action consumer verifies these ordering rules
with controlled ports, preserves sibling account waits and checks compatibility
export identity against the two emitted protocol modules. Both verification
entries await that helper; these results do not establish a remote file action.

Installed action checks exercise the compiled contact/group adapters and the real
Session lifetime with controlled services. Their consumer helper has its own
module in `scripts/`, rather than embedding action behavior in the packaging
orchestrator. No native addon or account is used by these checks.

See [Development guide](../development.md) for the workflow and module placement rules.

[Architecture overview](../architecture.md) · [Development guide](../development.md)

Friend/group request input gates cover the public facade before controlled IPC,
nested identity/options snapshots, selected getter reads, throw/close retirement,
and prepared CLI reason capture. Pure contract tests additionally prove capture
is idempotent at both boundaries without admitting an explicitly empty cursor.
The installed consumer repeats request preflight, detached friend identity,
default cursor options and CLI approval intent checks using installed code and a
controlled worker; these checks do not perform native approval or account login.

The installed request-result consumer checks single-read native status, matching
failure codes, retirement before result decisions, early notification failure,
query quarantine and listener removal with controlled ports. Source regressions
also cover getter throws, malformed codes and void list versus approval results.
Login-retirement fixtures prepare their local environment before starting the
login budget, so cold filesystem work cannot replace the targeted close failure.
Production login deadlines and exact retirement assertions are unchanged.
