# Offline Linux security-sign initialization evidence

Inspected on 2026-09-30 without executing QQ, loading an account, generating a signature, sending SSO requests, or editing native bytes. The private expert report about a fake-sign/detection marker is treated as a hypothesis requiring verification; absence of public documentation does not disprove it.

Binary: official Linux arm64 QQ 3.2.32-52194 wrapper.node, SHA-256 `c302361f52494de257044e912e43ed244bb29ee59f59345d25a8959327828337`. All addresses below are ELF virtual addresses before relocation for this exact binary. They are not portable version contracts.

## What static analysis can distinguish

The binary has distinct callback-null, signing-failure and signing-success control-flow branches. This is stronger evidence than isolated string presence. It does **not** identify which branch the current ordinary-Node process took, whether a returned result satisfies the server, or whether an environment/detection marker was included.

| Boundary | Address and directly observed instructions | Meaning and limit |
| --- | --- | --- |
| Callback setter | `0x40614e4`; stores incoming object/control pair at `0x8a036a0` and `0x8a036a8` via `0x4061514` / `0x4061518` | There is a native registration path for a shared callback object. Symbol names are stripped; exact high-level setter name is inferred from its use, not recovered |
| Setter wrapper | `0x4060ebc`; calls setter at `0x4060ee8` | Copies and reference-counts the incoming callback pair |
| Callback accessor | `0x4061564`; loads `0x8a036a0` / `0x8a036a8` and increments the control reference count | Supplies the object later tested by the signing routine |
| Signing routine entry | `0x40a6b94`; accessor call at `0x40a6bbc`, pointer `cbz` at `0x40a6bc4` | A null callback takes a separate branch |
| Callback dispatch | `0x40a6bd8` loads vtable; `0x40a6bdc` loads vtable slot `+0x10`; `0x40a6bf0` calls it | Native callback dispatch exists, with a result checked at `0x40a6bf4` |
| Null branch | references `Security sign callback is nullptr, will not sign!` at `0x40a6cd8`; clears return-result slot at `0x40a6cec` | Explicit no-signing fallback is implemented |
| Failure branch | callback return bit 0 clear jumps to `0x40a6cfc`; references `MSFSign is failed, will not sign! cmd:{} data size:{}` at `0x40a6d28` | Failed callback also has a no-signing branch |
| Success branch | references `MSFSign is success, cmd:{} data size:{}, {}` at `0x40a6c34`; allocates/copies a 72-byte result structure from `0x40a6c70` | This is local success handling; it does not prove server authenticity acceptance |

A second wrapper-level null message, `SendMsfRequestInternal security_sign_callback_ is null, cmd={} seq={}`, is referenced at `0x13a0154`. Its relationship to the global accessor above is not fully reconstructed.

## Native initialization links found

The bounded direct-branch scan found four call sites into the setter wrapper: `0x1379124`, `0x137a888`, `0x139cea4`, `0x139df1c`. Around `0x1379124`, the code allocates/initializes an object, stores a callback/control pair in an owning object at offset `0x88`, copies it and passes it to the setter wrapper. Around `0x139cea4`, a similar pair is stored at offset `0x70` and passed onward. This means callback registration is represented inside wrapper native initialization paths; it is not valid to conclude that a JS callback defaulting to no-op necessarily leaves the native security provider null.

The complete path from the npm SDK's `initWithDeskTopConfig` / account-session `init` to these native call sites has **not** been resolved. Nor has the actual initialized callback type/vtable been observed in a running ordinary-Node instance. The two owning-object layouts are not yet assigned authoritative class names.

## Callback implementation and provider candidate

The string/path cluster identifies `MSFSecuritySignCallback` and `wrapper/external/msf/msf_security_sign_callback.cc`. Code near its `MSFSign failed, module_id:{} data:{}` log references that string at `0x1375c4c`.

At `0x1375c14`, this region directly calls an in-wrapper routine at `0x42627dc`. The returned integer is tested: nonzero enters the failure-log path; zero follows output copying beginning at `0x1375c78`. The output buffer has three regions at offsets `0`, `0x100`, `0x200`. Their exact field semantics are not inferred from offsets alone.

The routine at `0x42627dc` calls `dladdr` at `0x4262840`, passing the caller return address derived from `x30`, and retains mapping information plus a success flag. Subsequent code has many arithmetic constants and complex control flow. This is concrete caller-image/environment introspection in a routine on the signing call chain. It could be relevant to the reported environment/detection concern, but its purpose, accepted contexts, branch semantics, and output effects remain unknown. No attempt was made to bypass it, provide fabricated inputs, or change the result.

An actual named dynamic export also exists: `MSF::MSFSDK::setAppSigned(bool)` at `0x412d448`. It checks a global initialization byte, masks its boolean argument, then dispatches through a native vtable. The bounded scan found no direct `bl` to this exact address; calls through PLT/vtables or other modules remain possible. Its name alone does not identify a fake-sign marker or establish whether any caller sets it true or false.

## Required modules and official-shell differences

The inspected official DEB inventory contains wrapper.node, major.node, IPC/audio/input modules, app libraries and the official QQ executable. It contains no separately named qqsign/signsdk provider library. Embedded provider candidate code above means that absence cannot establish that signing is missing. `SecuritySignManager`, `LoadSecuritySignType`, `SaveSecuritySignType`, `msfsecuritysign_type`, and `SSO_NEED_SIGNATURE_FLAG` are also present, but their configuration values and active runtime paths were not read.

The official QQ executable contains Electron embedded code and the QQ registration symbols. major.node contains an `electron_loader.cpp` path. The npm bridge supplies only a standard N-API registrar alias and explicit system-library loading. It does not recreate official shell initialization, linked Electron bindings or all native initialization inputs, and it does not implement its own signer. Loading GnuTLS fixes a libbugly ELF symbol dependency; it is not QQ transport signing.

Current JS session setup's generic/no-op callbacks identify an unverified integration boundary. They do not by themselves prove that the embedded native callback setter or provider did not initialize. A genuine provider may be embedded and reached without these callbacks, or some required initialization may remain absent; the static evidence does not select between those outcomes.

## Reproducible tools and remaining evidence

`scripts/linux-signing-static.py` maps selected null-terminated strings into ELF virtual addresses, checks nearby AArch64 ADRP/ADD references, and scans direct BL targets for the setter wrappers and provider candidate. `scripts/linux-signing-global-refs.py` searches bounded direct references to the callback globals. These are heuristic inventories, not complete disassembly or control-flow proofs. Private outputs and bounded disassembly snippets are under `.local/research/linux-signing-*`.

For manual verification, use the bundled `llvm-objdump -d --start-address=<address> --stop-address=<address>` on the exact extracted wrapper. Avoid relying on objdump's nearest exported symbol labels for stripped internal code; many labels are distant, unrelated exported symbols.

Remaining evidence needed to decide **genuine provider initialized versus null/default fallback**:

1. Resolve each setter caller's owning class and trace it from engine/session initialization, including required modules and default configuration.
2. Verify whether the actual process stores the statically identified `MSFSecuritySignCallback` vtable and reaches its provider call to `0x42627dc`; the static vtable identity is now resolved below.
3. Determine, without tampering, which null/failure/success branch is exercised in the actual Node initialization context; static code alone cannot establish live pointer state.
4. Understand caller-image checks and outputs sufficiently to distinguish locally successful signing from semantically degraded/marked output. A local success return is insufficient.
5. Obtain authorized official-client comparison evidence or authoritative protocol/provider contracts before assigning a server-visible marker or attributing account disconnection.

No active-account or signing execution was performed during this investigation. The available evidence leaves actual provider readiness and any fake-sign/detection output **unknown**.


## Follow-up: resolved callback RTTI and upstream MSF initialization

Additional offline relocation analysis resolves the previously candidate callback identity:

1. Each inspected construction sequence allocates a 184-byte shared object/control block, places its control vtable at `0x8718698`, reads a callback vtable base via GOT slot `0x89de348`, and writes callback address point `base + 0x10` into the constructed object at offset `0x18`.
2. The ELF dynamic relocation for GOT slot `0x89de348` is `R_AARCH64_RELATIVE + 0x8717300`. Thus the callback object's vtable address point is `0x8717310`.
3. Vtable RTTI slot `0x8717308` relocates to typeinfo `0x8717338`; its name pointer at `0x8717340` relocates to `0x677e8e0`, whose exact bytes are `N2nt8internal23MSFSecuritySignCallbackE`.
4. The sign-method slot at address point `+0x10`, `0x8717320`, relocates to `0x1375a78`. That routine contains the already verified direct provider call at `0x1375c14` to `0x42627dc`.

Consequently, the constructed-and-registered callback in these static initialization paths is specifically `nt::internal::MSFSecuritySignCallback`, not just a generic class inferred from a nearby string. Its registered virtual method connects to the embedded provider candidate routine. This still does not observe a running Node instance's pointer or provider outputs.

Upstream initialization context has also become more concrete:

- At `0x137a840` through `0x137a864`, native logs use source/function strings `MSFService`, `msf_service.cc`, `SessionInit`. From `0x137a79c`, the routine constructs the same callback, stores the callback/control pair in the owner at offset `0x88`, then registers it at `0x137a888`.
- Before the alternate registration at `0x139cea4`, the code calls `MSF::MSFSDK::sharedInstance` at `0x139cdb0`, its `init(... MSFGeneralConfigure ... IMSFCallback*)` PLT entry at `0x139cdcc`, and `setQIMEI36` at `0x139cde8`. It then constructs the same RTTI-identified callback, stores its pair at owner offset `0x70`, and registers it.
- The other two setter sites also construct the same callback rather than merely resetting it to null. No assertion is made that every error/early-return branch reaches construction; at least one path contains a `session not init` guard and returns before registration.

The unresolved boundary is now narrower: determine how engine/account-session initialization selects or reaches these native MSF session initialization paths, and whether their guards and provider-internal context checks succeed under ordinary Node. The native class identity and sign-vtable target are resolved statically; process execution and signature authenticity remain unverified.

`scripts/linux-signing-vtable.py` reproduces the relocation/RTTI chain, verifies the exact binary SHA-256 before using version-specific addresses, and outputs no runtime or account data. Its private output is `.local/research/linux-signing-vtable.json`.

## Follow-up: authoritative MSF class slots and SessionInit guards

The four setter callers can now be assigned classes without relying on nearby log labels. On the same SHA-256-pinned ARM64 wrapper, `.eh_frame_hdr` uses encoding bytes `01 1b 03 3b`. Its data-relative sorted lookup table identifies each caller's function start. ELF `R_AARCH64_RELATIVE` entries independently place those exact starts in two class vtables, whose RTTI names resolve to `nt::MSFService` and `nt::MSFCoreService`.

| Setter call | Enclosing entry / next unwind entry | Class vtable address point | Virtual slot |
| --- | --- | --- | --- |
| `0x1379124` | `0x1378c4c` / `0x1379fe8` | MSFService `0x87173e8` | `+0x88` |
| `0x137a888` | `0x137a48c` / `0x137b194` | MSFService `0x87173e8` | `+0x90` |
| `0x139cea4` | `0x139c93c` / `0x139d864` | MSFCoreService `0x8718f60` | `+0x88` |
| `0x139df1c` | `0x139d864` / `0x139e8e4` | MSFCoreService `0x8718f60` | `+0x90` |

MSFService RTTI is at `0x87177e0`, reached from vtable RTTI slot `0x87173e0`; MSFCoreService RTTI is at `0x87193f8`, reached from slot `0x8718f58`. Names are exact mangled bytes `N2nt10MSFServiceE` and `N2nt14MSFCoreServiceE`. The next unwind entry gives a reproducible range boundary, rather than asserting that arbitrary nearby prologue bytes identify functions.

The entry `0x137a48c` is associated with the previously resolved `SessionInit` source/function log. It preserves entry arguments as `x19=this`, `x20=x1`, `x21=x2` at `0x137a4a8..0x137a4b0`. After a helper call, it checks three pointers: `this+0x50` at `0x137a4b8`, `this+0x60` at `0x137a4c0`, and the first pointer in the third argument at `0x137a4c8`. Any zero branches to `0x137a840`, logs `session not init`, sets return register `w0=0` at `0x137a86c`, and jumps to the function's exit path, bypassing callback construction and setter call. On the other path it retains the shared-pointer-shaped pair supplied by `x1` into owner offsets `0x70/0x78` and later constructs and registers the security callback. Exact C++ parameter type names are not recoverable merely from these offsets; do not supply fabricated values based on them.

A full `.text` direct `BL` scan finds **no direct callers** to any of these four starts. Their placement in virtual slots makes indirect service dispatch a concrete unresolved boundary. A call using a `+0x88` or `+0x90` vtable offset elsewhere cannot establish this class connection without tracing the receiver object and its construction: these common offsets appear in many unrelated classes. Consequently, an exact `createEngine → initWithDeskTopConfig → account Session::init → MSFService/CoreService slot` chain remains unproven. The current SDK's public session call alone does not establish that these guards pass or which class implementation is selected.

`scripts/linux-signing-init-map.py` reproduces the SHA check, unwind-table boundaries, class RTTI, virtual slot relocations and direct-call inventory. Output is `.local/research/linux-signing-init-map.json`. This script reads bytes only and never loads the native module.

The next useful evidence is receiver provenance at the indirect service calls, ideally an unstripped matching official symbol map. A feasible **future, separately authorized, no-account observation** is a fresh empty private data directory with networking blocked and breakpoints on the four init entries, the setter and engine/session init entries. Observe only hit counts, native backtraces, guard booleans and callback-vtable offsets; do not read credential buffers, invoke signing, or skip guards. First use only module loading and desktop engine initialization; if registration is account-session dependent, report that boundary rather than triggering login. Such observation has not been performed here and would establish initialization reachability only, not genuine signing output or server acceptance.

## Authorized no-account runtime observation: Linux ARM64 prepare

A narrowly scoped observation now crosses the previously unresolved virtual-call boundary. The installed npm package was imported by name in a Linux ARM64 container with `--network none`, read-only mounts of only the package, exported native bundle and observation scripts, and a fresh empty data directory in tmpfs. The harness calls `createClient()` and later `close()` only. It never calls login, account-session authentication, SSO or a signing API. GDB was added to a separate local tool image; `SYS_PTRACE` and an unconfined seccomp profile permit debugging inside this container, while network and mount restrictions remain.

`scripts/linux-signing-observe-gdb.py` verifies the exact wrapper SHA-256 before observing it. A shared-object load event obtains the wrapper load bias from the zero-file-offset `/proc/<pid>/maps` entry. Four **hardware execution breakpoints** observe native init entries; no native instructions, flags, guards or pointers are changed. An inherited Node preload schedules SIGUSR2 in the worker solely to stop the debugger for read-only observation after preparation. It reads the callback/control pair and, when non-null, the object's first vtable pointer. Only booleans, module-relative addresses and hit counts are emitted, not heap buffers, identities or credentials.

Actual receipt `.local/research/linux-signing-observe-receipt.json`:

- Installed-import `createClient` completed preparation, exposing 98 native exports, without attempting login or mounting account data.
- `MSFService` virtual slot `+0x88`, entry `0x1378c4c`, was hit once. Entries `0x137a48c`, `0x139c93c`, `0x139d864` were not hit. Thus the `SessionInit` guards described above were not exercised and no guard values are fabricated.
- Global slots at load bias plus `0x8a036a0` and `0x8a036a8` both held nonzero pointers.
- The callback object's first vtable pointer equalled load bias plus `0x8717310`, the exact RTTI-resolved `nt::internal::MSFSecuritySignCallback` address point.
- No debugger observer errors occurred. The wrapper-relative native stack was `0x1378c4c ← 0x1309864 ← 0x1308dd8 ← 0x157e770`; further frames belonged outside the wrapper and their addresses were omitted.

The immediate caller can now be verified statically: at `0x130984c`, the code reads the receiver vtable; at `0x1309850`, loads its `+0x88` slot; at `0x1309860`, executes `blr x8`, whose return address is the observed `0x1309864`. This ties actual SDK preparation to the MSFService initialization slot rather than merely matching common slot offsets in disconnected static code.

This establishes that the inspected **prepare** flow registers a non-null native callback of the identified class. The earlier possibility that this prepare flow simply leaves the global callback null is ruled out for this exact bundle/package/environment. It does **not** establish provider internal initialization, invocation/result of `0x42627dc`, valid signatures, absence of degraded/fake-sign markers, or server acceptance; no signing path was intentionally exercised. The observation does not dismiss the expert's detection concern. The first run's debugger stopped again on the worker's normal SIGTERM during close; the receipt concerns the completed preparation and pointer snapshot, not clean-shutdown acceptance. The runner now passes SIGTERM without stopping.

Reproduction components are `scripts/linux-signing-observe.sh`, `scripts/linux-signing-observe-consumer.mjs`, `scripts/linux-signing-observe-timer.cjs` and `scripts/linux-signing-observe-gdb.py`. The tool image `qq-native-debug-env:arm64` derives from the previously prepared `qq-native-load-env:arm64` plus Debian GDB. No original native file was modified.

## Provider-local caller-image predicate and normal return

Further **static-only** work establishes the exact provider routine range as `0x42627dc..0x4262ec0`, using the `.eh_frame_hdr` entry (FDE `0x7c48694`). It contains one normal `RET`, at `0x4262eb8`; its shared epilogue explicitly sets `w0=0` at `0x4262e98`. Stack-canary mismatch goes to `__stack_chk_fail` at `0x4262ebc`. Thus a zero return from this particular local routine is not evidence that its internal outputs or environment checks were acceptable. Exceptions, helper failures and output semantics are not established by this return inventory.

The caller-image check is now more concrete:

- `0x426283c` passes the caller's saved return address in `x30` to `dladdr` at `0x4262840`. The first field of the resulting `Dl_info` structure, the image filename pointer, is copied from `[x29-0xe8]` to `[sp+0x70]` at `0x4262848/0x4262860`.
- The nonzero `dladdr` return is retained as a boolean at `[sp+0x6f]`; image filename non-null is retained at `[sp+0x7f]`. They are combined by `AND` at `0x4262b0c`, then select control-flow state at `0x4262b14`. Failure of either condition selects the state corresponding to the later helper path rather than an explicit nonzero failure return.
- A successful lookup path constructs a stack-local string and performs `strstr(imageFilename, constructedString)` at `0x4262dd4`. The null/non-null result selects state at `0x4262e00`. The constructed match target is deliberately not interpreted as a supported host identity or a recipe for emulating one.
- The selected paths write an actual process-global 32-bit value at `0x89e36d8`: zero at `0x4262c50`, one at `0x4262c68`. Both then select the same subsequent state and continue. The naming, meaning, lifetime and consumers of this field remain **unknown**. It is not labelled an official marker, fake-sign flag or validity bit merely because image matching controls it.
- The subsequent code makes direct helper calls at `0x4262b8c→0x424c350`, `0x4262bb0→0x424ab24`, and `0x4262bc4→0x4239ebc`, then copies their output regions. Their input contracts, initialization prerequisites and any dependence on `0x89e36d8` require separate analysis. No helper was invoked here.

This is evidence that caller-image inspection affects internal process state in the provider chain, while normal local return stays zero. It makes the expert's concern a substantive unresolved question; the evidence neither identifies the state as the reported detection marker nor proves output degradation. The prior live observation established callback registration only and did not exercise this routine.

`scripts/linux-signing-provider-map.py` verifies exact hash and selected instruction words, reproduces unwind boundaries, direct-call and RET inventory, and records these predicate addresses. Its output is `.local/research/linux-signing-provider-map.json`; no native code or account data is executed/read.

## Global field consumer and provider helper contracts

The global at `0x89e36d8` has a verified reader through a relocated pointer, explaining why a direct field-address load scan did not find it. ELF GOT slot `0x89dd9b8` has `R_AARCH64_RELATIVE` addend `0x89e36d8`. At `0x4335ab4`, `ADRP x8` selects the GOT page; `0x4335ac0` loads that exact pointer; `0x4335ac4` loads its 32-bit value; `0x4335ac8` compares the value with 1. The branch at `0x4335ad4` reaches `0x433bda8`, where `CSEL ... eq` uses that comparison's flags to select a control-flow state. These consecutive instructions were checked against exact binary words and manually disassembled, rather than assuming a distant ADRP register remained unchanged.

The reader belongs to unwind-bounded function `0x4334048..0x433bf80`. A bounded direct-call graph links the provider's first helper to this reader:

`0x424c350 → (BL 0x4257898) 0x43307b8 → (BL 0x4330984) 0x433008c → (BL 0x4330158) 0x4334048`.

These are structural static call edges; their containing paths may be conditional. This proves a concrete connection within the provider helper graph, not that every signing call exercises the reader. It also rules out treating the field as necessarily an unused write. The selected state's downstream data transformations remain unresolved; neither a logging-only classification nor a fake-sign/output-marker classification is established.

The three provider calls support these limited register contracts:

| Helper | Explicit inputs set at the call | Result handling |
| --- | --- | --- |
| `0x424c350` at `0x4262b8c` | `x0` is provider original `x0`; `x1` points to a formatted decimal string of original `w3`; `x2` points to a string constructed from original `x1` byte start and `w2` length | `x8` points to an indirect result object at `[x29-0x80]`; its data/length pair is later copied to the provider output region at `+0x200` |
| `0x424ab24` at `0x4262bb0` | `x0` is provider original `x0`; `x1` points to the constructed input-range string | `x8` points to an indirect result object at `[x29-0xa0]`; its data/length pair is copied to output region `+0x100` |
| `0x4239ebc` at `0x4262bc4` | Only the indirect result pointer in `x8` is explicitly prepared here; caller-saved registers changed by the prior helper must not be invented as formal parameters | Result at `[x29-0xc0]` is copied to output region `+0`; its size is written at output `+0xff` |

For the `+0x100` region, size is written at output `+0x1ff`; output `+0x200` copying occurs at `0x4262bd4`. These are byte-layout observations, not authoritative signature/token/extra field names, and do not establish size validation or a safe externally callable ABI.

`scripts/linux-signing-field-map.py` reproduces the version check, selected instruction checks, GOT identity, function bounds and bounded direct-call path. Output is `.local/research/linux-signing-field-map.json`. The direct-address heuristic initially produced an apparent second match pairing the ADRP at `0x4262c44` with the later store at `0x4262c68`; manual inspection shows a newer ADRP at `0x4262c58`, so the older pairing is not treated as a separate reference. Only the two verified stores and the GOT-mediated reader are asserted; this is not an exhaustive proof against other indirect references.

## Bounded downstream effect: conditional byte write

The two states selected by the verified field reader now have a narrowly identified difference, recovered from exact state constants and dispatcher equality branches within `0x4334048..0x433bf80`:

- If the global equals 1, `CSEL` at `0x433bda8` selects state `0x04bf8aad`. Equality dispatch at `0x4334a60` enters `0x433a18c`, retaining `[frame+0x6c8] + 8` at frame offset `0x798` and choosing state `0x2137f5ae`.
- That state's dispatcher branch at `0x43361b4` enters `0x433a7e0`. It dereferences the retained pointer, adds 5, saves that resulting pointer as frame offset `0x7a0`, reads its byte and chooses state `0x0a12e4fc`.
- Equality dispatch at `0x4336280` enters `0x433a950`. At `0x433a964`, the byte is ORed with `0x08`; at `0x433a968`, it is written back to the pointed memory. The path then selects state `0xd990ab20`.
- If the global does not equal 1, the initial selection chooses `0xd990ab20` directly. Both paths converge through dispatcher `0x433652c` at block `0x4339b18`. Thus the non-equal path skips this identified extra byte-write sequence.

Here `frame` is the routine's local workspace base `x19=sp`, established at `0x4334068`. The written address is `*([frame+0x6c8]+8)+5`. The pointer retained at frame offset `0x6c8` comes from helper `0x4331760` called at `0x4339470` and stored at `0x4339474`. Its object layout, ownership and eventual serialization remain unresolved.

This establishes **a conditional memory-data effect, not only a logging call**. It does not yet establish that this byte belongs to the final provider output regions, a network field, a detection marker or a fake signature. The remaining concrete boundary is pointer/data provenance from `0x4331760` through the common continuation and eventual helper return. Full flattening/path analysis of this 32 KiB routine would be required to assign those semantics; isolated OR instructions are insufficient.

`scripts/linux-signing-state-effects.py` verifies version and selected instruction words and outputs the exact dispatcher/block/effect map to `.local/research/linux-signing-state-effects.json`. This is a bounded static map, not a generic symbolic execution engine, and no code or signing input was executed. A permissible next no-account initialization observation would only read whether the global changes during `prepare` and whether `0x4331760` is entered during that preparation; observing a signing-dependent output would require a separately scoped authorization and is not part of the current work. No identity/environment changes or internal-check bypass are proposed.

## No-account field snapshot after preparation

The current packaged SDK was observed again with the same hardware-breakpoint harness, no network and a fresh empty account directory. The observer now reads only the 32-bit field at `0x89e36d8` after `createClient` preparation. It reports `4294967295` (`0xffffffff`), while callback/control pointers remain nonzero and the callback vtable still matches. The exact ELF file's initial four bytes for this address also encode `0xffffffff` in a PROGBITS section. The snapshot is consistent with that initial value; it does not prove that no intervening write occurred, or establish when/why the provider later selects zero or one.

Thus this preparation snapshot cannot be labelled detection success/failure or a signature-validity result. The observer did not invoke signing, SSO or login. The consumer prints `observationClosed:true` after `close()` completes; GDB sees the observed worker terminate by SIGTERM during owner-controlled shutdown. This is completed shutdown evidence, not a worker crash during preparation or a zero-exit claim. Current log: `.local/research/linux-signing-observe-latest.log`; static initial-value receipt: `.local/research/linux-signing-field-initial.json`. The offline runner now mounts the pinned production codec tarball explicitly for the current npm package.

## Pointer provenance boundary after the conditional byte write

A further bounded pass narrows the pointed object contract without claiming final-output propagation. Helper `0x4331760` is not observed allocating memory: within its bounded code it reads owner arrays/pointers at argument `x0+0x10`, `+0x18`, `+0x20`, indexes using argument `x1`, and returns either an existing pointer (`0x4331810`) or null (`0x4331818`). Its normal return is `0x4331844`. This is evidence of indexed pointer lookup, not a new independently allocated signing buffer.

In the consumer, the call at `0x4339470` supplies an owner pointer derived from the routine's original argument plus 8, and an index derived from the low nibble of a byte in the frame's `0x9e8` pointed region. The returned pointer is retained at frame `0x6c8`. The previously established conditional write therefore updates byte 5 of the data pointer stored at lookup-result offset 8. This identifies a concrete indirect existing-object data location; its native class and external field semantics remain unknown.

The common continuation at `0x4339b18` derives another pointer from `[frame+0x9e8]+6`, stores it at frame `0x7b0`, and later loads it into `x22` at `0x433b974`. The consumer's only normal return loads **frame `0xa00`** into `x0` at `0x433bf44`; a preceding path stores `[frame+0x170]` there at `0x433a990..0x433a994`. These addresses are different local slots from the looked-up object at `0x6c8`. No alias identity between those pointed regions has been established.

Consequently, the current evidence does **not** prove that the modified byte is copied into provider output `+0x200`. A structural caller chain reaches this consumer from the helper producing that output, but call reachability is not data provenance. Proving propagation would require following the looked-up object through the consumer's workspace aliases and transformations, then through the three intervening return/caller boundaries to the first helper's indirect-result buffer. The 32 KiB flattened consumer uses many indexed pointers and control states; an exhaustive manual path walk would be unreliable without a verified symbolic/data-flow model or matching native type information. This is the current finite static-analysis boundary, not evidence that the byte is discarded.

No further signing-dependent experiment is performed. A separately authorized no-account `prepare` observer could check whether this lookup helper is ever entered and whether the global's value changes during initialization, emitting only hit counts and integer state. Such an observation would clarify initialization reachability and state lifetime but would still not prove final signature-output propagation.

## Recovered caller-image substring predicate

The previously uninterpreted stack string can be recovered exactly from constant instructions without executing the provider. Constructor `0x4262a28..0x4262abc` writes bytes `01 35 4f 49 5b 4d 4c 5a 4c 1f 5e 5c 56 50`. The bounded loop compares its index with 12 at `0x4262ce8`, and its XOR instructions `0x4262d30/0x4262d34/0x4262d38` recover each of the twelve bytes as `initial[i+2] XOR 0x35 XOR (i+1) XOR 0x0c`. The resulting exact bytes are **`wrapper.node`**, followed by the zero terminator written at `0x4262d84`.

Thus `strstr` at `0x4262dd4` tests whether the caller-image filename returned by `dladdr(callerReturnAddress)` contains `wrapper.node`. This is a substring comparison, not an exact basename/path check and not cryptographic file-integrity verification. For the successful `dladdr` and non-null filename route, a null match selects state `0xa9a7b87f`, dispatches to the write of global value 1; a non-null match selects state `0x49e7ae57`, dispatches to the write of value 0. The already documented helper consumer conditionally writes the additional byte when that global equals 1. Failure of the lookup/filename prerequisites has a separate route and must not be reduced to this match table.

This provides a concrete native loading contract to document: the embedded code inspects the loaded caller-image path for this literal substring. The SDK accepts arbitrary `wrapperPath` values, so renaming an authentic wrapper can change this predicate even if file bytes remain identical. Retaining the official bundle's `wrapper.node` path is the normal exported package layout; no renamed-image signing experiment, path spoofing or check modification was performed or proposed. The substring alone does not identify the global/byte as the reported fake-sign marker, prove validity, or establish server-visible output propagation.

`scripts/linux-signing-image-predicate.py` decodes MOV/STURB constant construction from the exact ELF, checks the loop's selected XOR/limit/terminator/strstr instruction words, and reproduces the recovered substring. Receipt: `.local/research/linux-signing-image-predicate.json`. This is arithmetic on static constants only; no ABI calls, account operations or native signing were executed.

## Direct entry observation during no-account preparation

`sh scripts/linux-signing-observe.sh provider` selects four hardware execution breakpoints: MSFService initialization entries 0x1378c4c/0x137a48c, the statically identified callback sign method 0x1375a78 and candidate provider entry 0x42627dc. The original registration observation remains the default mode. No instruction or native memory is patched.

The pinned arm64 wrapper run on 2026-09-30 recorded one 0x1378c4c hit and zero hits for the other three entries before the timed snapshot. It prepared 98 exports, retained a nonnull callback/control pair with the known vtable, and read the image field as 0xffffffff. The observer reported no errors and the SDK closed after continuation; GDB reports the worker's owner-requested SIGTERM, not a normal worker exit. External networking was disabled and no account was mounted or login called. Receipt: `.local/research/linux-signing-observe-provider.json`; full log alongside it.

This directly limits preparation evidence: registration occurred but the observed callback/provider entries were not executed in the measured initialization interval. It does not establish their behavior during authentication or outgoing requests, exclude other signing paths, or validate output authenticity. A registered callback and successful createClient cannot be promoted to signing execution evidence.

## One additional bounded boundary: provider buffer to callback result

A single downstream consumer is now verified: the success branch of `MSFSecuritySignCallback` converts the three provider regions into three adjacent 24-byte string-shaped result slots. It calls the same byte-copy routine `0x13f0634` three times: `0x1375c84` copies provider offset `0` to result offset `0`, `0x1375c94` copies provider offset `0x100` to result offset `0x18`, and `0x1375ca4` copies provider offset `0x200` to result offset `0x30`. Each length comes from an unsigned byte at the corresponding region offset `+0xff`, via `LDRB` at `0x1375c78`, `0x1375c90`, `0x1375ca0`.

Inside the shared copy routine, an existing storage-capacity flag chooses inline or heap storage. Heap growth calls operator new and `memcpy` at `0x13f06fc`; reused storage uses `memmove` at `0x13f073c`. It stores a length, then writes a trailing zero at `0x13f075c`. This is a length-delimited byte-copy boundary, not observed textual encoding, hashing or semantic validation. Embedded zero bytes are copied according to length rather than stopping at a C-string terminator.

The native result therefore has three ordered byte-string-shaped slots. No checked symbol/type schema assigns their semantic names as signature, token or extra; those names remain unknown. This transformation also does not connect the conditional OR8 byte to provider region `+0x200`: the earlier pointer-provenance boundary remains intact. The local callback success boolean compares only the provider's integer return with zero, as previously described.

`scripts/linux-signing-output-copy.py` verifies the hash and exact copy-site/length-load/storage-copy instruction words, emitting `.local/research/linux-signing-output-copy.json`. This investigation follows only this one concrete conversion; it does not expand the obfuscated helper graph or execute provider/login/SSO/signing code.

## One bounded caller contract: 0x433008c

Entry `0x433008c` saves original `x0` in `x20`, original `x1` in `x19`, and original `x2..x7` at stack offsets `0x80..0xa8`. It also saves the floating-point argument register area. A local workspace at `x29-0x68` is initialized from a copied 378-byte static blob. At `0x4330114`, the named `std::string::_M_assign` PLT call copies original `x0` into the workspace's string member at offset `0x40`.

A setup call at `0x4330150` to `0x43318f8` supplies `x0=workspace`, `x1=original x1`, and `x2=sp+0xb0`, pointing to a copied argument-list-shaped descriptor built from the saved register areas and caller stack. The setup helper's internal semantics are not followed in this bounded step.

Immediately before the consumer call at `0x4330158→0x4334048`, only `x0=workspace` is explicitly set. Other caller-saved argument registers have passed through the setup helper, so their values cannot safely be identified as original parameters. **No `x8` indirect-result contract is established at this boundary.** The consumer's ordinary `x0` return is saved in `x19` at `0x433015c`, cleanup runs, and the same value is restored to `x0` at `0x4330180` and returned. Thus this caller forwards an ordinary return pointer/value; it must not be confused with the provider's first helper's later indirect string-result convention.

This establishes workspace ownership and forwarding but does not identify the returned value with the conditional OR8 object's data or provider `+0x200`. Missing definitions remain in the setup helper's workspace/argument mappings and the consumer's `frame0xa00` return provenance. `scripts/linux-signing-caller-contract.py` checks exact hash and instruction words for this single entry/setup/call/exit map; output is `.local/research/linux-signing-caller-contract.json`. No further flattened-graph expansion or native execution was performed.

## One bounded setup contract: 0x43318f8

The setup entry preserves `workspace=x0` in `x20`, descriptor `x2` in `x19`, and original `x1` initially in `x22`. Before flattening it calls `0x4332284(original x1)`, stores the returned word at local `sp+0x58`, stores `original x1+1` at `sp+0x8`, stores `workspace+8` at `sp+0x18`, and derives `descriptor+0x18` in `x27`. The original `x1` is not demonstrably retained in a persistent workspace field by these instructions; `x22` is subsequently reused for state constants.

Two direct workspace writes are verified: `0x4331eac` writes an eight-byte value to `workspace+8`, sourced from `x28` loaded through the pointer in local `sp+0x48`; `0x4331f1c` writes a four-byte value to `workspace+0x10`, sourced from local `[x29-0x14]`. Their complete path-dependent source definitions are unresolved, so these fields are not labelled as original parameters or outputs. The setup also passes `workspace+8` to helper `0x4332380` before the first write; that helper's indirect effects are outside this bounded inspection.

The descriptor is consumed/mutated rather than simply retained: blocks ending in stores `0x4331b94` and `0x4332244` increment its first pointer by 8. These are distinct conditional blocks; this does not assert both execute on every call. This supports the earlier argument-list-shaped descriptor interpretation while leaving exact parsing/type semantics unknown.

The workspace still lacks an authoritative object schema, and no alias between these fields and the downstream OR8 target/provider output has been established. `scripts/linux-signing-setup-contract.py` verifies the hash and precise register-save/derived-local/direct-store instruction words and emits `.local/research/linux-signing-setup-contract.json`. The investigation stops at this setup function; no helper body, login or native code was executed.

## One indexed setup helper: 0x4332380

A subsequent bounded inspection follows only helper `0x4332380..0x4332588`, with the same pinned binary hash and unwind boundaries. It retains `x0` as an owner pointer (the setup caller supplies `workspace+8`) and `x1` as an index. Its direct writes use two pointers loaded from the owner: `0x4332490` clears an eight-byte slot at `owner[+0x10] + index*8`; `0x43324fc` stores a callee-produced local value into the same slot; `0x4332518` writes byte `1` at `owner[+0x18] + index`. These give array-shaped field evidence, without establishing the owner's C++ type.

The two internal calls are `0x434d384(owner, original x4)` and `0x434daa4(owner, original x2, &local)`. Their bodies and indirect writes remain uninspected. This helper has no identified direct owner-field store, so it is not classified as a constructor for `workspace+8`. Its epilogue does not establish a new explicit `x0` return value, and the setup caller ignores its return. The only named PLT call in this helper is `__stack_chk_fail`.

`scripts/linux-signing-setup-helper.py` verifies exact instruction words, calls and unwind boundaries; its output is `.local/research/linux-signing-setup-helper.json`. This adds a limited owner/index structure clue. It does not establish aliasing with the downstream OR8 target, propagation into provider output, a signature format or a server-visible account marker. No native code, login or signing operation was executed.

## Independent older-version comparison: Linux 3.2.31-51102 ARM64

A bounded offline comparison used `.local/native/qq-3.2.31-linux-arm64/wrapper.node`, SHA-256 `72978494d18d0076a378550099628569ff5081ada79f37e0b7adaeae6904217a`. All older addresses were derived independently from its own ELF string sections, relative relocations and unwind table; no 3.2.32 absolute addresses were reused.

| Structure | Older 3.2.31 | Newer 3.2.32 |
| --- | --- | --- |
| Same callback RTTI name | `N2nt8internal23MSFSecuritySignCallbackE` at `0x60dbe68` | Same class name at `0x677e8e0` |
| Typeinfo | `0x7e19fa8` | `0x8717338` |
| Vtable address point | `0x7e19f80` | `0x8717310` |
| Sign slot `+0x10` | `0x7e19f90 → 0x11df4b0` | `0x8717320 → 0x1375a78` |
| Sign method unwind range | `0x11df4b0..0x11df764` | `0x1375a78..0x1375d2c` |
| Provider candidate call | `0x11df64c → 0x3cc75fc` | `0x1375c14 → 0x42627dc` |

The older method's candidate call has the same observed local calling shape (`x4` points to a local buffer, input byte start/length in `x1/w2`, module-like original word in `w3`) and tests the integer return for zero at `0x11df654`. Its success branch loads unsigned lengths for the three regions at `0x11df6b0`, `0x11df6c8`, `0x11df6d8`, then copies to ordered result offsets `0`, `0x18`, `0x30`. This confirms callback/vtable and three-region output structure across these two exact binaries; semantic signature/token/extra names and output authenticity are still unproven.

The older method additionally calls routines `0x3cc13e8` and `0x3cc1c44` before the candidate provider call, passing local function addresses / a buffer in the shown context. Their semantics and runtime effects were not followed; they must not be treated as equivalent to newer initialization without further evidence. This comparison does not establish that the newer caller-image/global predicate exists unchanged in the older provider.

`scripts/linux-signing-old-vtable.py` independently resolves the older RTTI chain, reports the method's direct calls, and verifies selected candidate/copy-context instruction words. Receipt: `.local/research/linux-signing-old-vtable.json`. No older/newer native module, provider, login or account operation was executed for this comparison, and no signing safety claim is made.

## Older pre-provider function: bounded initialization operations

For the same older hash, `.eh_frame_hdr` bounds the first pre-provider call target `0x3cc13e8` to next entry `0x3cc1b10`. It saves original `x0/x1/x2` in `x20/x19/x21`. Near its normal exit path, it calls `0x3cc1b10` and writes those original inputs into the returned object's offsets `0`, `0x10`, `8`, respectively, then writes byte value 1 at offset `0x18`. The callee's object ownership/lifetime was not followed.

It also updates two callback-like function-pointer pairs at offset `0x10` of global structures reached through GOT relocations `0x80af568` and `0x80acb80`. The stored local function addresses are `0x3d79e10/0x3d79d5c` at `0x3cc1a88`, and `0x3d79f84/0x3d79e24` at `0x3cc1abc`. Before replacement it copies the prior structure into a local temporary; when its previous function pointer is non-null, it invokes that pointer at `0x3cc1a9c` / `0x3cc1adc` with `x0=x1=&temporary` and `w2=3`. This shape is consistent with callback-wrapper replacement, but its precise ABI and operation 3 meaning are not established and are not assumed.

Consequently, this function is not merely three stores of caller callbacks: it also calls helper `0x3c8caa8`, obtains an object via another helper, replaces two global function-pointer pairs and conditionally invokes previous handlers. Helper bodies and any effects beyond these explicit instructions remain unknown. This bounded result neither executes the pre-provider function nor proves provider readiness. `scripts/linux-signing-old-preinit.py` verifies the older hash, unwind bounds, exact store/indirect-call words and global-pointer relocations; output is `.local/research/linux-signing-old-preinit.json`. No investigation of the second pre-provider call or provider internals was performed.

## Two setup-helper callees: owner cleanup and vector-shaped index output

This independent finite pass returns to the newer Linux ARM64 wrapper SHA-256 `c302361f52494de257044e912e43ed244bb29ee59f59345d25a8959327828337`. Its unwind table bounds the two previously uninspected helper targets to `0x434d384..0x434daa4` and `0x434daa4..0x434dc44`. No nested callee bodies were followed.

The first target saves owner `x0` at `sp+8`, retains original `x1` in `x19`, and reads the indexed byte through owner offset `0x18` at `0x434d3ec`. Its body contains three named `memset` calls (`0x434d668`, `0x434d730`, `0x434d87c`), each explicitly passing zero as the fill value, and four named `free` calls (`0x434d674`, `0x434d7d8`, `0x434d7e8`, `0x434d888`). At `0x434d7e0` it also writes an eight-byte zero through a path-dependent local pointer. These are actual cleanup-like memory operations, but the complete pointer aliases, allocation lengths and reachable combinations remain unresolved. Both explicit normal epilogue routes assign `w0=0` or `w0=1`; their semantic meaning is unknown, and the calling setup helper ignores this result.

The second target preserves original output pointer `x2` in `x19`, input `x1` at local `x29-0x10`, and owner-region address `owner+0x20` at `sp+8`. Call `0x434db04→0x434dda0` receives the pointers loaded from owner offsets `0x20` and `0x28`, plus the address of the stored input. Its body was not inspected. Two branches then write an eight-byte value through original `x2`: `0x434dbac` writes `(local returned position - *(owner+0x20)) >> 3` using arithmetic shift; `0x434dbc8` writes `(*(owner+0x28) - *(owner+0x20)) >> 3`. The latter branch also calls the named PLT entry `std::vector<long>::emplace_back<long&>` at `0x434dbd0` on `owner+0x20`, passing the address of the saved input. This identifies a vector-shaped region and an index/count-shaped out-parameter. It does not establish that this out-parameter is a payload pointer.

Combined with the already checked caller `0x43324f4..0x43324fc`, this newly establishes that one path stores that index/count-shaped result into the indexed eight-byte owner table at offset `0x10`. It adds a concrete local data-flow edge and clarifies the prior generic “callee-filled local” description. No relationship to the OR8 lookup object's data, provider `+0x200`, signature/token/extra semantic names or any server-visible marker has been proven. The vendor class schema and internal implementation source remain unknown.

`scripts/linux-signing-setup-callees.py` checks the exact file hash, unwind boundaries and selected instruction words, and inventories all direct calls/returns in these two bodies. Receipt: `.local/research/linux-signing-setup-callees.json`. This is static file inspection only: no native execution, account access, signing operation, environment modification or detection-result change was performed.


The four PLT labels in this latest pass were independently checked against `.rela.plt` GOT relocations and `.dynsym`/`.dynstr` bytes from the same pinned ELF: vector emplacement at `0x83a460`, memset at `0x83a5f0`, free at `0x83c7b0`, stack-check failure at `0x83d540`. The script now rejects a dynamic-symbol mismatch. The vector's exact mangled label is `_ZNSt6vectorIlSaIlEE12emplace_backIJRlEEES3_DpOT_`. On the analysis host, `/usr/bin/objdump --disassemble --start-address=0x83a460 --stop-address=0x83a470 /absolute/path/wrapper.node` independently printed that `.plt` label and its GOT load.

Run `python3 scripts/linux-signing-setup-callees.py /absolute/path/wrapper.node` from the source checkout with the exact matching ARM64 ELF to reproduce this finite pass. It reads binary bytes; it does not import or invoke the native module.


## 有界补充：setup 的 8 字节元素查找 callee

固定 Linux arm64 wrapper SHA-256 `c302361f52494de257044e912e43ed244bb29ee59f59345d25a8959327828337` 下，`0x434dda0..0x434e45c` 的 unwind 边界、选定指令字以及全部直接/间接调用位置已独立复核。可复现命令：

```sh
python3 scripts/linux-signing-next-vector-search.py /absolute/path/wrapper.node
```

本函数保存传入的 range begin 和 target 指针，读取并比较两个 64 位值；迭代位置按 8 字节推进，剩余数出现 `(end-current)>>3`，返回 `x0` 从保存的当前位置间接读取。唯一直接调用为既已通过 ELF 符号表确认的 stack-check failure，未出现间接调用。这些局部关系符合“查找 8 字节元素并返回位置”的解释，补强上一节调用者把返回指针差转换为元素 index/count 的判断。它们不证明所有混淆分支的执行关系，也不能据此认定这是签名数据或检测位。

这一有限步骤仍未建立 OR8 lookup 对象与 provider `+0x200` 的别名或传递路径；不能把 `+0x200` 直接命名为已确认的 owner 字段。服务端标记、签名输出含义和纯 Node 环境与官方宿主的真实性等价仍未知。脚本仅读取二进制，不加载或执行原生模块。

## 有界补充：OR8 目标对象的查找入口

同一固定 SHA 下，OR8 路径此前保存的返回值来自 `0x4339470→0x4331760`。本次仅检查 unwind 有界函数 `0x4331760..0x4331848`，并独立复核完整 SHA、指令字和系统 objdump 结果。该函数读取 `owner+0x10` 的 8 字节索引表、`owner+0x18` 的字节表和 `owner+0x20` 的指针表。

当 `byteTable[index]` 的 bit0 为零时返回空指针；否则先在 `0x433182c` 读取 `indexTable[index]`，再在 `0x4331810` 返回 `pointerTable[indexTable[index]]`。这是两级索引取得已有表项的关系。函数没有直接或间接调用，没有分配和外部内存写入；其写入均为局部栈存储。没有在此函数中确认索引边界检查。

```sh
python3 scripts/linux-signing-lookup-origin.py /absolute/path/wrapper.node
```

这将“返回对象”收窄为表中已有指针，但尚未确认该表项的原生类型、其 `+8` 字段的数据含义，也未证明它与 provider `+0x200` 的别名关系。因此仍不能认定 OR8 改写了最终签名或服务端可识别的标记。相邻函数未纳入本次分析；没有原生执行或账号操作。

## 返回记录、数据复制与 provider 第三个区域

在同一固定 Linux 3.2.32-52194 arm64 SHA 下，本轮把返回值追踪到 provider 的 `+0x200` 区域。consumer `0x4334048` 的普通 `x0` 返回经 `0x433008c`、`0x43307b8` 转发，保存到第一 helper 的局部槽 `frame+0xe8`。该返回值是记录指针 `R`：`R+0` 读取 32 位长度，`R+8` 读取数据指针。`0x4257644` 使用 `data..data+length` 调用 ELF 动态符号确认的 `std::string::_M_construct<const char*>`，写入原始 `x8` 指定的间接结果对象。provider 在 `0x4262b8c` 指定该对象为 `x29-0x80`，随后在 `0x4262bd4` 调用实际 `memcpy`，把字符串数据按长度复制到原始输出指针 `+0x200`。结合前述 callback 的三区域复制，此处建立了长度限定的数据输出关系；仍没有权威字段名说明该区域是 signature、token 或 extra。

consumer 中还找到返回数据的构造与复制指令。记录通过 `malloc(16)` 分配；另一处从 lookup 对象取得的 32 位长度左移两位后传给 `malloc`，所得缓冲区写入 `R+8`，对象长度写入 `R+0`。`0x4335194..0x43351b0` 按相同索引从另一个 lookup 对象的 `+8` 数据指针读取并写入返回缓冲区，元素宽度为 32 位。因而，返回缓冲区虽为独立分配，也不能据此排除内容传播。这里的分配大小与后续字符串构造长度单位不同，不能把分配范围直接当成最终输出范围。

| 待连接的路径 | 精确局部关系 | 尚缺证据 |
| --- | --- | --- |
| OR8 目标 | `0x4339470` 的 lookup 使用当前指令 byte1 的低 4 位；后续修改该对象数据指针 `+5` 的字节 | 与复制源是否相同或有数据转换关系 |
| 返回数据复制源 | `0x4339644` 的 lookup 使用当前指令完整 byte1；其 `+8` 数据指针进入 32 位索引复制 | 两处指令位置和索引不能直接视为相同 |
| 最终输出 | `R.data` 按 `R.length` 构造字符串并复制到 provider `+0x200` | 复制及输出是否覆盖改写字节、可达路径上是否先写后复制 |

consumer 入口的 `frame+0x28 = *(incoming x0)+0x10`，lookup owner 则为 `incoming x0+8`。两次 lookup 都从 `frame+0x9e8` 读取指令位置，其直接定义来自 `frame+0x28`，但循环会更新该槽，因此共用解析状态不能证明读取同一指令。`0x4339b28` 将该指针加 6 后保存，未在该处解引用；不能描述成“载荷 byte6”或与数据指针混同。若复制源为相关表项且索引 1 实际复制，32 位元素会覆盖 byte4–7，可能包含改写的 byte5；字符串输出还须实际覆盖 byte5。这些是条件性范围关系，并非执行证明。

完整 consumer 指令字均与系统 objdump 核对，frame 槽清单包含 `STP/LDP` 的第二槽；清单仍不能穷尽间接别名及所有混淆状态的可达关系。

```sh
python3 scripts/linux-signing-provider-third-region.py /absolute/path/wrapper.node
python3 scripts/linux-signing-return-provenance.py /absolute/path/wrapper.node
```

两个脚本均先检查完整二进制 SHA，再输出精确局部证据。前者额外校验 39 个选定指令字、unwind 边界和字符串构造/`memcpy` 动态符号；后者需要分析主机的 `/usr/bin/objdump` 支持 AArch64 ELF，并核对 consumer 范围内每个反汇编指令字。本机复跑及独立 objdump 检查通过，私有收据保存在 `.local/research/linux-signing-provider-third-region.json`、`linux-signing-return-provenance.json` 和 `linux-signing-third-region-independent.json`。

结论仍是：已确认真实输出复制链及候选内容传播入口，但没有证明 OR8 位进入最终输出，更没有证明服务端账号标记或踢下线机制。没有加载原生模块、调用 provider、恢复账号或修改检测结果。上述地址仅适用于这个固定二进制，不能推广到其他平台或版本。

## 静态指令源、分发表与另一条返回路径

同一固定 Linux arm64 SHA 下，caller 在 `0x43300e4` 分配 378 字节，在 `0x43300f8` 从静态地址 `0x6c7e29c` 复制同样长度。构造函数 `0x433185c` 在 `0x4331870` 把复制品指针存入 `workspace+0`，并将 blob 首个 `uint16`（值 18）传给 owner 初始化。consumer 在 `0x43340b8` 读取该指针，在 `0x43340c8` 加 `0x10` 作为入口指令位置。其余 header 字段尚未命名。整个 blob SHA-256 为 `fe1623668335f3f6dce1065e72349da9d71262bd31ba61f7be42e1da1aa8d976`。

consumer 的 `0x4337340` 从当前指令位置读取 byte0。bit7 置位走已识别的退出分支；其他值通过静态地址 `0x6c7e59e` 的 128 项 `uint16` 表，计算 `0x4334230 + table[opcode]*4` 并跳转。256 字节表的 SHA-256 为 `0e5b7d0e329515863b5e947f409f7d2cc7b5bed5e777ad584070b1da08079a3f`。

| opcode | 表项得到的入口 | 已检查的局部关系 | blob 中的裸字节位置 |
| --- | --- | --- | --- |
| `0x79` | `0x4339460` | 低四位 operand lookup，进入此前 OR8 对象路径 | 362 |
| `0x7a` | `0x4336d00` | lookup 对象进入加工函数，结果经 `0x4332380` 回存 owner 索引 | 368 |
| `0x61` | `0x4336e1c` | 另一条按字节复制的返回记录路径 | 376 |
| `0x62` | `0x4339638` | 前述按 uint32 索引复制的返回路径 | 整个 blob 均无此字节 |

这些是精确表项与裸字节候选位置，不能把裸字节搜索等同于指令解码。setup 已识别的直接 workspace 写入没有覆盖 `workspace+0`；consumer 的 239 个单基本块指令指针载入窗口也未发现通过所追踪指针直接写 blob。然而，该有限检查未覆盖跨块别名及全部间接 callee，故没有证明运行时 blob 不变或指令位置始终位于它内部。`0x62` 的缺席仅在这些前提成立时限制该 opcode；**不能据此排除返回数据复制**。

`0x61` 的局部指令另有 `malloc(16)` 返回记录 `R` 和 `malloc(sourceLength+1)` 数据缓冲区；`0x4338758` 调用实际 `memcpy`，从 lookup 对象的 `+8` 数据指针按首个 uint32 字节长度复制。后续在 `R+0` 写长度、`R+8` 写数据指针，记录经 frame158、`x1/x20` 和 frame170 转存，接入前述普通返回链。因此先前 `0x62` 的 32 位元素复制路径不是唯一返回候选。这些仍是局部数据边，未穷尽所有混淆状态的可达顺序。

`0x7a` 从 byte1 低四位 lookup 对象；byte2 参与读取 owner 索引表。`0x433a9d4` 调用 `0x434c4c0`，传入该对象、索引表的 uint32 值和一个保存的 uint32 参数。返回值再作为 `x2` 交给 `0x4332380(owner, byte2, result, 0, -1)`。候选位置的 operand `07/02` 与“查索引 7 的对象、加工结果回存索引 2”相符，但仍以指令边界和执行可达为前提，不能认定它是直接或无损复制。

加工函数 `0x434c4c0..0x434d2e0` 的 904 条指令已完整复核。其原对象 `+8` 数据指针参与逐字节读取，在 `0x434cdcc` 写入一份局部缓冲区；另一个内部调用 `0x434d0d4→0x4356f94` 收到“局部缓冲区 +2”和“原对象 uint32 长度 +8”，其普通返回值经局部槽转存成为该加工函数的 `x0` 返回。其他内部调用以及缓冲区完整布局、加工返回记录 ABI 未被穷尽确认。不能从这些边推断算法名、最终输出的具体位值或服务端检测语义。

```sh
python3 scripts/linux-signing-instruction-source.py /absolute/path/wrapper.node
python3 scripts/linux-signing-opcode-map.py /absolute/path/wrapper.node
python3 scripts/linux-signing-transform-boundary.py /absolute/path/wrapper.node
```

复跑通过完整 SHA、选定指令/完整函数字、unwind、静态 blob 和动态 PLT 检查。独立检查另用 ELF `PT_LOAD` 映射（区别于脚本的 section 映射），复核全部 128 个表项、378 字节 blob、18 个来源指令的系统 objdump 结果以及加工函数的全部指令；三个脚本对真实旧版二进制均以 SHA 不匹配拒绝。私有收据：`.local/research/linux-signing-instruction-evidence-verified.json` 及同名脚本 JSON。没有执行 native、provider、账号操作或改写检测结果。

当前缺口已收窄到：实际指令边界/执行顺序、OR8 修改字节进入加工缓冲区的覆盖关系、加工结果布局，以及索引 2 到 `0x61` 返回对象的实际连接。尚未证明最终输出受该位影响，更未证明是假签名、服务端账号标记或踢下线机制。

## 加工返回中的嵌套解释器边界

继续检查 `0x434d0d4` 调用的 `0x4356f94..0x4357024`，发现它不是直接返回所分配的数据记录。该函数分配 16 字节记录：`+0` 写原始 uint32 长度参数，`+4` 写 uint16 值 32，`+8` 写数据分配指针；分配大小为 uint32 长度零扩展后的 64 位加一，而 `0x4357004` 实际 `memcpy` 的长度为 uint32 `length-1`（减法本身会在零处回绕）。记录未初始化字段的意义未知。此处上层传入的是局部缓冲区 `+2` 和原对象长度 `+8`，但其完整布局和取值范围仍未证实。

`0x4357020` 恢复栈后尾调用 `0x4356e3c`，传入静态地址 `0x6f19d2e` 和刚构造的记录；因此该记录是下一层输入，不能把它等同于加工函数的最终返回值。下一层 `0x4356e3c..0x4356f94` 构造另一份 3264 字节解释器 blob，再调用已经识别的 `0x433185c`、`0x43318f8` 和同一个 consumer `0x4334048`。consumer 的 `x0` 结果保存于 `x19`，清理 workspace 后恢复到普通 `x0` 返回。这确认了嵌套解释器边界，尚未确认嵌套程序结果的记录 ABI。

新 blob 的静态模板位于 `0x6c7eb40`，前 3264 字节 SHA-256 为 `44b70e204ba91b526a4bcbf426c5a4df71d304cd32c20e66118296c910af8260`。构造先复制模板前 `0xc30` 字节，随后在局部缓冲区 `[0xc30,0xc60)` 写入来自运行时全局指针的 48 字节，再从模板 `+0xc60` 复制 128 字节到局部缓冲区同一偏移；最终只复制局部缓冲区的 `0xcc0` 字节到分配的 blob。因此最后一次模板复制的末尾 32 字节不进入这次最终 blob 复制。指针来自 GOT `0x89dee08` 引用的全局地址 `0x8a077f0`；其运行时内容、初始化和语义未检查。**静态模板 SHA 不能冒充实际运行时 blob SHA**，也不能把这 48 字节命名为检测位、密钥或签名材料。

```sh
python3 scripts/linux-signing-nested-transform.py /absolute/path/wrapper.node
```

脚本固定完整 binary SHA，校验两个相邻 unwind 范围、全部 122 条反汇编指令与 ELF 字节、尾调用和普通返回边、模板及完整 128 字节 tail 来源 SHA，以及 `malloc`/`memset`/`memcpy` 的 PLT 指令和动态符号重定位。独立 ELF `PT_LOAD` 映射复核全部 122 条指令、静态来源字节及 global 重定位通过；脚本对实际旧版 binary 以 SHA 不匹配拒绝且不输出证据。私有收据位于 `.local/research/linux-signing-nested-transform-independent.json`。上述静态证据不涉及执行 provider、构造替代运行环境、恢复账号或改写检测值。它修正了一个可能误读：前层所见的输入记录和最终加工返回之间还有一段含运行时注入数据的解释器程序；最终输出受 OR8 位影响仍未证明。

## 注入的 48 字节的初始化来源

同一固定 binary 下，找到向 global `0x8a077f0` 写入指针的 initializer `0x42f9558..0x42f95ac`。它在 `0x42f9564` 调用动态绑定的 `_Znwm`，分配 `0x58`（88）字节；从静态地址 `0x6c7ded2` 读取 48 字节，再在 `0x42f9588/0x42f958c` 写入分配对象的 `[0,48)`。静态来源 SHA-256 为 `f88007f6ee01e966ee287956f490dac8edc6bc53a54a13bdeb02a9730340248d`。它还初始化对象的若干后续字段，但这些字段的意义未命名。`0x42f95a0` 经 GOT `0x89dee08` 将对象指针写入 `0x8a077f0`，与前节嵌套 blob 构造读取的 global 一致。

嵌套构造中的 `0x4356ea4→0x42f9378` 位于读取该指针之前。调用者传入的 `x0` 来自 GOT `0x89dc900`，重定位指向相邻地址 `0x8a077f8`。`0x42f9378..0x42f9558` 保存原始 `x0`，把 initializer 地址 `0x42f9558` 存入 TLS 槽，并在 `0x42f94b4` 调用 `pthread_once`；其 `x1` 来自 GOT `0x89debc8`，动态符号绑定为 `__once_proxy`。两处外部调用的 PLT 指令、JUMP_SLOT 重定位和动态符号均已核对。尚未展开外部 `__once_proxy` 的间接分派或穷尽对象后续写入，不能据此声称这 48 字节在每次构造时都等于静态初始值。

```sh
python3 scripts/linux-signing-global48-origin.py /absolute/path/wrapper.node
```

脚本固定 binary 和静态来源 SHA，检查两个 unwind 范围、wrapper 的全部 120 条指令、initializer 指令、选定来源/存储边，以及上述动态符号绑定。独立检查用 ELF `PT_LOAD` 映射复核 wrapper 和 initializer 的全部 141 条指令与系统 objdump、静态 48 字节、五条重定位绑定及两个 PLT；实际旧版 binary 被 SHA 拒绝且证据 stdout 为空。私有收据为 `.local/research/linux-signing-global48-origin.json` 和 `linux-signing-global48-origin-independent.json`。本轮没有执行 native/provider 或账号操作。

这将数据来源从“未知运行时 global”收窄为“具有已确认静态初始值的分配对象”。后续可变性、嵌套解释器指令顺序、OR8 字节传播及最终输出布局仍未证明；不能把来源字节命名为检测位、密钥、假签名材料或服务端账号标记。
