# Development guide

Start with [Architecture and maintenance contracts](architecture.md). The package
root is the application interface; internal file paths are not extension points.
Use `npm run check` before submitting a change. The same checks run in SDK quality
CI, including installation of a newly packed archive. A passing fixture test does
not establish interoperability with QQ or prove an account operation succeeded.

Run `npm run check:architecture` while choosing or changing module ownership. It
checks source placement, exact dependency permissions, type and runtime cycles,
pure input closures and formatter coverage without loading QQ. It also runs as
part of the full test gate; passing it alone does not replace `npm run check`.

Historical read-only account batches use `scripts/readonly-sdk-acceptance.ts`
for package integrity checks, exclusive execution reservation and the fixed
restore/read/close sequence. Their versioned entry scripts contain only immutable
batch facts. Review mode verifies artifacts without importing the installed runtime
or using an account. Execution requires a separately authorized batch and
`--execute-approved`; the flag itself is not authorization. Runtime acquisition
uses a narrow injected port so controlled regressions exercise the same execution
owner without QQ or credentials. Receipts contain counts and fixed error categories,
not contact or message contents. Do not copy this executor into another versioned
script or weaken a historical plan to make it pass against newer artifacts.

## Choose the owner before writing the code

| Change                                                                             | Owner                                                                                     |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Public data shape or event payload                                                 | Relevant `src/contracts/` domain; compose event tuples in `events.ts`                     |
| Public client method or callback presentation                                      | `src/client/qq-client.ts`; `index.ts` remains a reexport-only entry                       |
| Client initialization transaction and worker bootstrap                             | `src/client/create-client.ts`                                                             |
| Shared account/group identifier rules                                              | `src/validation/identifiers.ts`; preserve string IDs and operation-specific native limits |
| Pure validation and input snapshots                                                | Feature input module, shared by facade and worker                                         |
| Native callback projection or operation                                            | Relevant `src/features/` domain                                                           |
| Recall intent, recipient resolution and callback/ACK completion                    | `src/features/messages/recall-operation.ts`; share pure `recall-input.ts` with the facade |
| Attachment input, peer resolution, staging and download cancellation               | `src/features/media/attachment-downloads.ts`; composition only delegates                  |
| Request correlation, shutdown or account ownership                                 | Existing `src/runtime/` lifetime owner                                                    |
| Bundle source selection and source-specific runtime policy                         | `src/native/native-package.ts`                                                            |
| Pure source options, manifest paths, version/runtime metadata and content identity | `src/native/native-manifest.ts`; CLI preflight uses this owner directly                   |
| Integrity of an already selected local/npm directory                               | `src/native/native-directory-verification.ts`; no download, installation or cache repair  |
| Mirror installation transaction and content cache                                  | `src/native/native-bundle-installer.ts`; package locking stays in `src/storage/`          |
| Worker initialization state and candidate ownership                                | `src/worker/native-bootstrap.ts`; reserve initialization before any await                 |
| Bind Node addon loading, codecs and account-directory locking                      | `src/worker/bootstrap.ts`; `worker.ts` remains the IPC entry                              |
| Prepare local engine/login configuration                                           | `src/runtime/kernel-environment.ts`; no connection or authentication                      |
| Capture preparation/startup methods and retain their native receiver               | `src/runtime/kernel-method.ts`; the calling owner supplies its lifecycle check            |
| Compose an authenticated Session and feature adapters                              | `kernel.ts` and `native-services.ts`                                                      |
| CLI command flags and action planning                                              | `src/cli/commands/` by domain; `command-plan.ts` composes definitions and captures flags  |
| CLI argument parsing and client execution                                          | `src/cli/command-input.ts` and `client-command.ts`; executable entry remains `cli.ts`     |

Follow the change through its owners:

Native source options use `undefined` to mean omitted. Explicit `null`, boolean,
empty string or incomplete version metadata must fail in the shared pure preflight,
before bundle lookup, download, cache creation or worker startup. CLI configuration
and initialization use the same rules as `createClient`; do not duplicate version
or source checks in another entry point. Preflight does not choose source precedence
or replace directory verification. Existing local wrappers, trusted manifests,
fixed-version offline selection and default latest selection keep their own policies.

A business CLI command has one domain definition containing both accepted flags
and its preparation function. The registry rejects duplicate names and owns lookup;
domain planners cannot import the registry, executable entry or client-acquisition
modules. Shared argument parsing lives below those definitions. Preparation captures
caller flags before asynchronous file reads and returns an action that uses the
public client only when invoked. Configuration, login and watch ownership stays in
the existing entry/execution modules. Add a command to its domain definition instead
of maintaining a second flag table or command switch.

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

Kernel preparation, account initialization and the selected startup strategy use
`runtime/kernel-method` for method capture. Capture each property once, retain
its original receiver and check the owning lifetime after acquisition and before
dispatch. Factory selection captures available methods before invoking one;
exceptions must never select a fallback or replay a call. The helper owns no
Session, state, IO or cleanup. Business adapters cannot import it: their narrow
typed ports remain the interface for native operations.

`features/groups/group-web-reads.ts` owns the three account-bound HTTP read
operations. It combines the request and account signals, checks the account and
awaits the complete operation. Inject ticket/domain-key methods and the account
wait port there; keep endpoint exchange, pagination and DTO validation in their
existing group modules. The composition root only supplies ports and routes.

`features/contacts/contact-operations.ts` captures public input and resolves the
UID before delegating to `user-profile-query.ts`. The query owns only lazy Profile
method acquisition, requested Map lookup and projection to the canonical public
`UserProfile`. Its port cannot resolve identifiers, mutate friends or retire the
account. Preserve valid native getters and Map overrides: capture each read once,
keep its receiver, and check retirement even when the read throws. A retired read
cannot validate or inspect another native field. `ContactProfile` and its old port
export remain compatibility aliases, rather than duplicate DTO definitions.

`features/groups/group-files.ts` owns file-count and folder dispatch policy. Supply
lazy, operation-specific native ports and decisions bound to the measured
binary profile. Input capture and rejection of unsupported operations happen there
before native acquisition. The composition root routes calls to this owner;
`group-file-count.ts` owns the boxed completion bridge, singleton arrays and
uint64 group correlation. `group-folder-operations.ts` owns creation snapshots
and deletion acknowledgements. `group-file-operations.ts` only preserves old
consumer exports; SDK implementation modules import the owned protocols directly.
Their shared `group-file-result.ts` captures own data fields and checks action
retirement after descriptor inspection, including thrown traps. Each protocol
retains its response shape and status rules; closing during capture stops error
interpretation and every subsequent native-field read.
Listing callbacks are captured by `group-file-page-codec.ts`; page correlation,
deadline and traversal belong to `group-file-pages.ts`. Pass only its listing
method and worker-owned token history. The existing Msg listener routes callbacks,
and account/request signals retire waits. Do not introduce another account lifetime
or release worker token reservations during account replacement.

Message envelope capture and mention resolution accept opaque element batches.
Keep the captured envelope's metadata closed and its element bodies `unknown`;
only the element projector interprets native variant fields. Do not widen a queue
or resolution port to accommodate an undocumented element.

New feature modules cannot import the dynamic `NativeObject` escape hatch. Use
`unknown` for untrusted results and narrow typed ports for callable methods.
Existing legacy adapters and native projectors have exact ownership entries with
reasons in the dependency policy; remove an entry when its import disappears.
Contact directory reads validate unknown Buddy, Profile and UID conversion results.
Keep their shared profile projection in the contact domain; flat friend queries
must not acquire the complete category metadata contract. Commit identity caches
only after the complete batch validates and the account is still alive.

`features/contacts/friend-category-mutations.ts` owns category creation, rename and deletion.
Keep their argument tuples paired with their operation through a discriminated
union. Inject independently measured capability decisions and a lazy Buddy port;
validate input and reject unsupported binaries before acquiring it. This owner
shares ACK validation, timeout and cancellation because those invariants are the
same for both writes. Native ACK does not establish the remote category state.
Creation retains its separate `CreatedFriendCategory` receipt and explicit
`addCategoryV2(name, undefined)` argument pair. Capture each method once with its
receiver and check the lifetime after acquisition and receipt projection; even
a native property trap can retire the account. The composition root cannot import
category input validation or creation completion directly.

`features/messages/message-resolution.ts` owns peer conversion and the identity
lookup needed by live delivery, queries and forwarding. Supply only user-ID
resolution, the native UIN lookup method, cancellation and diagnostics. Native
identity results remain `unknown` until `native-identities` validates and copies
the requested map entries; do not assert a typed map in composition. Message
snapshotting and projection retain their existing owners and happen before awaits.
Live delivery accepts opaque `unknown` records and uses
`captureIncomingNativeMessage` for both conversation selection and metadata
capture. Do not add an outer `chatType` property read: native accessors must be
captured once inside the error boundary. Queries use the strict capture path;
unsupported live conversations are skipped without reading their bodies.

`features/forward/forward-resource-owner.ts` owns lazy resource upload/read
transports and merged card orchestration. Supply its narrow SSO, peer resolution
and prepared card ports; keep wire schemas inside the forward domain. Register
upload and read cleanup independently in the account ledger. The dependency gate
prevents composition from importing their transport or wire implementations.

Use `features/forward/forward-resource-input.ts` for resource-ID validation in
the facade, CLI and worker. Its strings are never coerced or trimmed; the limit
is 4096 UTF-8 bytes with valid surrogate pairs. Keep request encoding, response
decoding and decompression in `forward-resource-wire.ts`. Public input consumers
cannot import that wire implementation, even through type-only dependencies.
The old internal wire reexport remains compatible; new callers use the input owner.

Native callback wrappers belong to `runtime/native-listener-owner`; business
callback definitions and registration order belong to composition. Supply a
captured registration function instead of a Session or service locator. Keep
listener references for the worker lifetime until a removal ABI is verified;
account close is not proof that the native kernel released a callback pointer.
Each callback slot captures its override once. Subsequent property acquisition
returns the same wrapper without evaluating its getter, including unknown callback
slots. Ordinary non-function metadata remains uncached; if a captured slot becomes
non-configurable, non-writable data, its exact metadata value is returned to satisfy
Proxy invariants. Callback descriptors must remain configurable for wrapping;
frozen function slots retain the existing TypeError instead of exposing an unguarded
callback. Wrapper caching does not
change audit-before-handler ordering, registration retention or the invocation's
existing close guard.

Friend request notifications stay unknown until their carrier, row identities,
texts and flags have been captured and validated. Read each field once; checking
it and then rereading it when emitting a DTO permits a native accessor to change
its type. Validate the full batch before publication and check account retirement
after projection. Preserve opaque `raw` identity separately from those validated
scalars; this does not require a dynamic native-object port.

Friend deletion and member kick options follow that same single-read rule before
UID lookup. Keep native completion policies in each domain: void acknowledges
submission only, while a result-bearing completion needs numeric zero. Capture
the result code once, check retirement, and construct failures from the captured
value. Contact profile identity and DTO fields must come from one captured core
record, with another retirement check after projection. Preserve the original raw
carrier and Map lookup behavior. Installed controlled consumers verify these
rules separately from authorized real-account acceptance.

Contact and group management capture lives in `contact-operation-input.ts` and
`group-operation-input.ts`. Use these pure functions in the public facade, domain
owner and CLI plans; avoid duplicating business validation in any of those callers.
The captured intent discriminator carries the exact action payload. Capture before
IPC and UID lookup, copy options and populate defaults, and preserve Promise
rejections in public methods. The execution owner checks lifetime before and after
capture and still owns native completion and UID validation. Composition forwards
requests; it cannot import these input modules. Keep their imports limited to
their own domain data contracts, including type dependencies.

Friend and group request preflight belongs to `friend-request-input.ts` and
`group-request-input.ts`, shared by the facade, CLI and request execution owners.
Copy only actionable identity fields rather than the notification's raw carrier.
A missing list cursor stays absent through IPC, then native execution maps it to
an empty cursor; an explicitly empty input cursor remains invalid. This makes
capture idempotent across boundaries. Preserve the existing nullish limit default,
read order and omitted versus empty approval reason. Capture CLI reasons during
plan preparation. Listener registration, page serialization, deduplication,
failed-query quarantine and void acknowledgement semantics stay with execution.
Capture native request result codes once, then check owner lifetime before deciding
success or constructing an error. Error serialization must use that same captured
code. Lists require numeric zero; only approval dispatch accepts a void result.
Getter failures retain identity, and failed uncorrelated queries stay quarantined.

Group query envelopes and rows follow the same capture-before-validation rule.
Use intrinsic Map operations for native membership maps, and commit the complete
validated member batch only after checking Session retirement. Keep this policy
inside the group query owner rather than in service composition or the UID cache.

The group query owner also captures IDs and refresh defaults before native
acquisition or callback registration. Its local close aborts pending callback and
member waits without closing the account channel; preserve sibling operations and
observe late native failures. Composition only forwards payload fields. Retain
the existing opaque list refresh and boolean member refresh contracts rather than
introducing a new shared validation rule.

Metadata events retain their partial-field semantics. Capture optional fields
once, validate the whole batch and guard projection failures with a fixed
diagnostic. Keep the application emit call outside that guard so an application
listener error is not mislabeled as invalid native data. Use intrinsic Map
enumeration for member callbacks, matching the query owner's storage policy.

Ordinary private/group sends belong to `features/messages/native-message-sender`.
Use pure `capturePrivateMessage` / `captureGroupMessage` at the facade and domain
entry, before IPC and before UID lookup. Service composition only routes the
operation; it must not regain the input or recipient orchestration policy.
Sender close has a local signal so one owner can retire without closing the
shared account callback channel. Verify pending UID/preparation/callback waits
and late completion, as well as ordinary successful sends.

Element decoding belongs to `features/messages/inbound-elements`; add no file
preparation or native querying there. Local image/file staging and reply-reference
construction belong to `outbound-elements`, using the specific staging/query
ports. The sender owns orchestration and receipt correlation. Test element
projection independently of outbound filesystem setup; installed-consumer checks
exercise both from the fresh archive and reject the removed mixed module.

Keep SDK-constructed native envelopes in `native/prepared-message-contracts.ts`.
The sender accepts their closed `PreparedSendElement` union; the ordinary builder
union and the ARK forward-card variant stay separate. Capture the whole ordinary
input batch before preparing any element, including direct internal sender calls.
Do not restore a dynamic object array to accommodate a new envelope: declare its
actual constructed fields and test its submission through the existing sender.

Use `runtime/media-contracts.MediaStagingPort` for native cache allocation across
image, record and video constructors. Keep its result unknown until validating
the absolute path and retain the method receiver and existing acquisition timing.
Do not pass a complete MsgService to a constructor that only allocates a path.
Codec execution, temporary-file cleanup and cancellation keep their existing
owners; a shared type does not change those lifetimes.

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
Global `fetch` acquisition has its own exact transport owners in the same policy;
an import-free module is not necessarily pure. Inject a narrow transport port
into a consumer instead of acquiring HTTP capability in an input or DTO module.

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

The composition root binds native methods through `NativeServiceLifetime.call`.
Do not duplicate check-then-read invocation there: capture once, recheck retirement
and dispatch the captured method with its receiver. Feature adapters keep their
narrow domain ports; this dynamic binding is not a general service locator for them.

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

All TypeScript scripts and every JavaScript helper in `scripts/consumers/` share
the strict `tsconfig.scripts.json` project. Its directory glob and ESLint's matching
glob make new consumer helpers subject to the same checks automatically.
Give dynamic installed imports the corresponding module
types, retain faithful DTOs in controlled adapters and add type-aware Promise
lint. Do not silence errors by assigning the whole installed module or fake
client to `any`. Compiler/lint negative fixtures must reject broken verification
code without executing it. Use the face, group-search, group-essence,
element-preparation and mirror consumers as examples. Keep intentionally invalid
runtime inputs separate from faithful typed adapters; a whole-module assertion
must not conceal a broken fixture contract.

Keep reusable consumer contracts in `scripts/consumers/`. The root verifier,
CI orchestrators, build/release tools and account acceptance executors have separate
roles. Moving a helper must preserve installedRoot-derived paths; update its
source-type imports and `import.meta.url` fixture paths for the new location.
Historical evidence and approved account plans retain their original bindings.

`scripts/consumer-module-policy.ts` owns the shared permitted directory, exact
orchestration files and computed-import exceptions. New consumers do not inherit
access to neighboring account or publication executors. Both local npm hooks and
the CI path gate use this policy. `pretest` and `preverify:package` run
`check:consumer-modules` before executing consumer code, including standalone
`npm test` and `npm run verify:package` commands. This preflight reads syntax;
it does not import helpers or claim compiled modules already exist.

Use these npm commands for local verification. Invoking the verifier directly
with `node`, or passing `--ignore-scripts`, skips the npm preflight hook. CI runs
the module-path gate explicitly before its consumer entry points.

Keep static consumer references in forms accepted by
`scripts/consumer-module-references.ts`. A computed fixture path requires an exact
reviewed exception with a reason and its compiled module inventory. The collector
never executes a verifier or scans unrelated account executors. Run the separate
CI path gate after building, then the actual packed consumer; passing either one
does not establish the other.
