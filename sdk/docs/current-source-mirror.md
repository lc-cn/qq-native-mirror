# Current SDK default mirror acceptance

The `Current SDK default mirror consumers` workflow builds the main npm archive
from its own immutable checkout. Its six jobs run on Linux, macOS and Windows,
each with x64 and ARM64 Node 24.20.0. It reuses the public native catalog and
verified mirror files; it does not rebuild QQ binaries or publish npm packages.

Use the manual workflow against a chosen source commit. Each job binds the
archive's size, SHA-256 and npm SHA-512 integrity to that exact repository, commit,
run ID and attempt before installation. The existing multi-version Linux workflow
uses the same main builder, with its independent old-version selection checks.

The consumer installs only the main archive with optional packages and lifecycle
scripts omitted. It asserts that all six native auxiliary packages are absent.
Unix jobs compile their host registration bridge into the archive. Windows jobs
compile the TypeScript SDK and use the verified internal-ABI adapter declared by
the downloaded native bundle, rather than compiling the Unix bridge.

The real public `createClient` receives a new empty account directory, one empty
native cache and the explicit download accelerator. `wrapperPath`, `version`,
`manifestUrl`, `manifestSha256` and `catalogUrl` remain absent. Its HTTP observation
checks the actual default catalog against the exact source commit's Git object bytes and the
selected manifest against its trusted digest. This deliberately rejects catalog
changes during the run rather than assigning their outcome to the wrong source
snapshot.

The expected catalog is read with `git show <source-commit>:catalog.json`. Windows
checkout filters can convert LF into CRLF; hashing that transformed working copy
would reject the unchanged public catalog. Network and native file bytes are
never normalized to make a digest match.

Repository attributes also keep SDK text sources in LF on all hosts. This matters
for multiline TypeScript string literals, whose contents retain source line
endings in emitted JavaScript. Native binaries and media fixtures remain binary.

The first factory call must download native payload bytes and then close its
worker. After that retirement, the consumer discovers the bundled video codec
from the same cache and checks three real local video fixtures through the
installed SDK. The second factory call uses a separate empty account directory
and the same native cache. It must prepare and close without any payload network
request. Every declared native file is then independently reread and hash checked.
The no-symlink policy applies to both factory workers and the codec child.

The artifact records the host device, Node version, main archive identity,
catalog/manifest hashes, selected QQ version, transfer counts, verified file count,
codec result and close result. Successful deterministic tests prove the verifier's
failure handling; successful workflow jobs supply actual host/runtime evidence.
Neither proves account login, contact/message interoperability, proprietary
signature authenticity or the effectiveness of any account mutation.

The reusable verification owner is
`scripts/consumers/mirror-consumer-contract.mjs`. It keeps the public factory contract typed,
owns its temporary cache and client retirement, and runs in a dedicated consumer
process because HTTP observation temporarily replaces that process's `fetch`.
The workflow driver owns archive acquisition/installation and evidence output.
Keep those responsibilities separate when changing platform or mirror checks.
