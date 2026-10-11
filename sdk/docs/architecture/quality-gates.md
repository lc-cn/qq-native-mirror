# Quality gates

## Local verification

Use Node 24 and npm. `package-lock.json` fixes the development dependency tree.
TypeScript and the type-aware ESLint parser must be upgraded and checked together.

```sh
npm ci --ignore-scripts
npm run check:architecture
npm run check
```

`check` runs formatting, zero-warning lint, native-storage tooling checks, strict
types, deterministic tests, a clean build and verification of a newly packed and
installed consumer. `check:architecture` is a focused source-organization gate;
it also runs in the full tests. Codec dependencies for offline consumer installation
come from npm's populated cache.

The SDK quality workflow runs these gates independently of native-bundle and
video-native CI. Changes to `ci/` trigger SDK quality as well as platform CI. A
local pass and a CI pass are distinct evidence; record the actual command exit and
source revision rather than treating an unobserved process as successful.

## Static coverage

| Scope                                               | Coverage                                                                                                  | Limit                                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/**/*.ts`                                       | Prettier, strict TypeScript, zero-warning ESLint, typed Promise lint and architecture/resource rules      | Native result validation and binary interoperability need their own checks.                                          |
| TypeScript tests                                    | Prettier, ESLint and strict test project                                                                  | Controlled fixtures establish SDK behavior only.                                                                     |
| JavaScript test entry points                        | Prettier, strict checked JavaScript and typed Promise lint                                                | Generated worker hooks remain string data; their execution is checked separately.                                    |
| TypeScript scripts and `scripts/consumers/**/*.mjs` | Prettier, strict types and typed Promise lint                                                             | Type information for installed dynamic imports must be supplied faithfully.                                          |
| Packed-consumer orchestration                       | Strict checked JavaScript and typed Promise lint, in addition to syntax/reference checks                  | Passing static checks does not prove the archive was installed and exercised.                                        |
| Other SDK JavaScript scripts                        | Prettier and basic ESLint                                                                                 | They do not all belong to the strict tooling project.                                                                |
| Exact native-storage producer/consumer tooling      | Repository formatting, zero-warning lint and offline regressions through `check:native-storage`           | This gate does not claim TypeScript coverage for those JavaScript build tools.                                       |
| Exact CI consumer entry points                      | Prettier, strict checked JavaScript, typed Promise/spread lint, role graph and compiled-module references | Other CI tools retain their separately declared coverage; static checks do not execute platform-native entry points. |
| Account/publication executors                       | Separate explicit execution entry points and their documented checks                                      | Static approval flags and test passes are not authorization.                                                         |

Source and governed tooling reject floating Promises, including `void` prefixes,
non-thenable awaits and discarded asynchronous callbacks. Compiler and lint
regressions mutate real verification code in memory and require rejection without
executing the defective code. Use the same `CI=true` environment when checking
lint fixtures; their persistent parser program disables automatic single-run
inference so changed contents are reparsed.

`tsconfig.scripts.json` also includes `test/**/*.mjs` and the exact packed-consumer
and Node-license helper entries; TypeScript tests retain `tsconfig.test.json`.
New JavaScript tests inherit the strict project and typed Promise lint. The packed
orchestrator additionally rejects spreading a Promise into a verification receipt.

`tools/tsconfig.consumer-ci.json` strictly checks the exact platform and current-source
consumer entries, their imported source/manifest declarations and the consumer cleanup
owner. `check:native-storage` runs this project and its negative compiler/lint
regressions without executing those entries. Receipt variables use completed-result
types, so a Promise assigned to a named JSON field cannot masquerade as a finished check.

The strict consumer directory glob automatically covers new helpers. Do not
weaken verification with a whole-module `any`, unchecked fixture assertion or
broad suppression. Intentionally invalid runtime inputs should cross a clearly
opaque input seam; ordinary adapters retain the real DTO and callable contracts.

## Architecture and resource ownership

`test/architecture.test.ts` registers five focused suites: dependency direction,
module ownership, composition, contracts and resources. The shared source graph
reads syntax once and never imports SDK modules. A new suite must be registered
so standalone and full tests exercise the same rules.

The gate enforces:

- A closed inventory of regular `.ts` source files. Unknown formats, symbolic
  links and directory junctions fail before graph construction. An imported file
  can enter the compiler outside its root include list, so it cannot be ignored.
- Reviewed source placement, resolved relative imports and acyclic dependencies,
  including erased types and `import = require()` declarations.
- Exact composition factories/context types and exact cross-domain pairs. New
  files cannot inherit permissions; obsolete grants fail against observed edges.
- Declaration-only public contracts and native/IO-free input closures. Public
  types have one declaration and do not depend back on implementations.
- Exact Node/third-party resource owners, including runtime versus type imports.
  Symbol-based ambient checks also cover global `fetch` and builtin-module loading.
- Computed/CommonJS loading denied by default. Only exact codec-loader and
  installed-manifest resolver forms have reviewed exceptions; simple renamed
  aliases do not bypass extraction.
- Formatting coverage for every source file, including `src/native/`; binary
  directory ignores stay anchored to the package root.

These checks protect visible responsibilities and dependencies. They are not a
runtime sandbox or a proof against arbitrary JavaScript evaluation. Narrow native
ports constrain callers; they do not establish an undocumented ABI or safe
projection of every proprietary result.

## Deterministic behavior and package checks

Tests cross the existing owner interfaces using controlled adapters. They cover
input snapshots and rejection before acquisition, original method receivers,
callback correlation, early callback followed by invocation failure, malformed
results, close during native-field inspection, pending cancellation, late
rejection observation, account replacement and transactional cleanup. Domain
rules retain distinct void/ACK/two-layer completion semantics and never infer a
remote effect from a synthetic receipt.

The packed-consumer gate builds from clean `dist`, packs and installs that actual
archive, imports its public root and checks the full public type inventory and
relative declaration graph. Positive and negative consumers preserve discriminated
login/peer types, event payloads, sendable/received elements, aliases and receipt
contracts. It rejects private/development files and obsolete emitted modules.

Installed worker checks exercise the actual compiled IPC entry with substituted
bootstrap/kernel/native loading: request/reply routing, factory initialization,
close acknowledgment, fatal delivery failures, cancellation, generation filtering,
lock ownership and process retirement. Installed domain/CLI consumers exercise the
same exported methods and plans with controlled services. Friend/list and history query
contracts have one checked helper each, shared by local packing and platform CI;
their former generated-string copies no longer maintain separate assertions. Generated hook strings
have runtime coverage here rather than a claim of strict static type coverage.

`consumer-module-policy.ts` separates reusable helpers, exact orchestration glue,
build/release tooling and account executors. The npm `pretest` and
`preverify:package` hooks run the syntax/role preflight first. Direct `node` or
`--ignore-scripts` skips those hooks. CI additionally validates all referenced
compiled modules after building. Computed fixture paths require exact reviewed
exceptions with their expected module inventory. The collector does not execute
helpers or inspect unrelated account executors.

## Native-storage and evidence limits

`tools/check-native-storage.mjs` owns the exact repository tooling/config/test
inventory. Offline regressions validate closed archives, platform/ABI metadata,
independent source identity, asynchronous input capture, compressed/original
digests, path/reference closure, packed SDK identity, complete fallback retention
and candidate restoration. Synthetic native bytes are never executed.

Release receipts bind the exact main and auxiliary artifacts, manifest digests,
source cohort and platform consumer results. A rehashed receipt cannot replace
missing installation or restoration evidence. Codec byte identity does not
substitute for native runtime acceptance.

A deterministic or installed-consumer pass establishes SDK/tooling behavior with
substituted ports. Platform initialization establishes only the recorded native
version/host combination. Real account login, delivery, reads and mutations need
their own authorized evidence. None of these checks alone proves signature
authenticity or every declared platform/version.

See [SDK acceptance](../sdk-acceptance.md) for current capability/proof scope,
[Lifecycle and errors](lifecycle.md) for settlement ordering and
[Development guide](../development.md) for the change workflow.
