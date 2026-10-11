# Group creation: verified structure and missing caller contract

Group creation is required for the complete client and is not yet exposed by
`QQClient`, the closed operation registry or the CLI. This investigation does
not enable a capability or establish a successful remote group creation.

## Exact native profile

The static profile is macOS ARM64 QQ 7.0.2-53644, wrapper SHA-256
`fbc8ad9b328d05e16784d76b0181dda894c17001179dbf8c0d5dd00dc6271358`.
An independent Mach-O parser rechecked file-backed mappings, function boundaries,
instruction words, literals, import stubs and the callback pointer. Thirty complete
functions cover 7044 bytes; a separate replay matched all 18 function ranges
and 1629 instruction words in the two older receipts. No addon was loaded.

| Entry                                  | Verified input structure                                                                                                                      | Core slot |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `createGroup` at `0x92e70c`            | One array argument; record conversion at `0x92e90c` reads `uid`, `nick` and `groupCode`.                                                      | `0x180`   |
| `createGroupWithMembers` at `0x92eb04` | Two arguments: a native string carrier and an array converted element by element into a native string vector.                                 | `0x188`   |
| `createGroupV2` at `0x92ed0c`          | Two arguments: an object plus the same record array. The object reads `createOption`, `createGroupInfo`, `selectGroupCodeInfo` and `extInfo`. | `0x190`   |

The third entry is a distinct registered binding, not an alias inferred from its
name. Its NAPI property descriptor at `0x51257b0` points to `0x92eb04`; argument
count is two, and this branch does not use the classic member-record converter.
It shares the existing Promise callback factory. A fresh independent replay
checks 14 complete functions and 948 bytes for this binding and its helpers.

The ordinary Session constructor installs address point `0x5098838`; its group
getter slot `0x178` points to `0x353e0`. The cold path constructs the Group
address point `0x50b9530` and caches the object/control pair at Session offsets
`0x5d0`/`0x5d8`; the warm path returns that same pair. Group slots
`0x180`/`0x188`/`0x190` point to `0x205288`/`0x203fc8`/`0x2044e4`.
Eighteen complete supplier functions cover 5852 bytes. These bind the normal
receiver path, while complete JS class-registration and carrier-lifetime
semantics remain outside that proof.

For `createGroupWithMembers`, twelve further complete functions cover 1476
bytes. The first string goes through an acquired interface's `0xa0` slot with
the value `60007`. The original string vector and callback pair are captured
in a concrete closure before the final acquired service's `0xd8` call. The
provider of that slot and invocation of the closure at address point `0x50bd860`
remain unclosed. Neither the intermediate value nor a local callback on a weak
lock failure establishes a remotely created group. Independent byte replay
matches all 44 distinct function ranges and 8276 bytes across these three stages.

The entries share a callback factory. The callback table points to `0x70b254`;
its normal serializer constructs `errCode`, `errMsg` and `result`. The latter
includes `groupCode`, `ownerUin`, `securityInfo`, `createOption`, `groupSize` and
`sign`. Group/owner integers use unsigned 64-bit decimal string output; the two
option/size fields use uint32. Promise construction and the normal deferred
resolution edge were verified. The generic queued callback dispatch has not been
fully closed, so this does not guarantee that every path invokes that serializer.

Native conversion helpers accept more than their output representation suggests.
The string helper contains number and bigint conversion paths; the uint32 helper
also has a string path. These are structural findings, not approved public input
types, defaults, enum values or proof of valid member selection.

## Actual caller investigation

The installed official archive, SHA-256
`e515fbf7c47d0e05a5539c9aeeea8a3268551dd5f6ddb7a39a9a4bb656c7bf12`,
was parsed without starting QQ. All 1433 packed members were hash checked; its
173 JavaScript members were not UTF-8 source. Absence of a plaintext method name
does not establish that the method is unused or identify an encryption format.

Readable outer entries delegate to `major.node.load`. Independent static replay
of that binary's ARM slice traced the registered loader through embedded-map
lookup and `vm.Script` cachedData handling. Neither the loader nor its payload
was executed. The `internal_index` and `internal_launcher` map entries were
traced to their exact 3448-byte and 53560-byte raw payloads and into the cachedData
Buffer construction. Runtime header rewrites also exist, so extracted bytes are
not claimed to be the final runtime cache. Readable source and actual
group-creation arguments have not been recovered.

The ARM slice's single `createGroupV2` literal was narrowed to the embedded
`b_86background` entry, filename `86.background.js`, with a 6,161,376-byte payload
at virtual address `0x130460`. Map writes and the literal's location within that
payload were independently checked. Nearby constants include
`createGroupWithMembers`, `invitedUids` and `inviteReq`. These identify a focused
candidate for function/constant analysis; their presence alone does not prove
which function calls the method or how it constructs arguments.

A strict static decoder now consumes the complete original payload, including
deferred objects, synchronization and padding, without skipping unknown tokens.
The resulting graph places the creation names in a service-description object
within a real function's constant-pool descendants. Its SharedFunctionInfo and
ScopeInfo field chain identifies the function name `27218`; the description lists
`createGroupWithMembers` beside `groupName`/`membersUid`, and `createGroupV2`
beside `req`/`membersInfo`. These are parameter-name metadata, not reconstructed
business calls, request defaults or verified UID selection rules.

The installed framework identifies Electron 40.0.0 and V8
`14.4.258.16-electron.0`. Independently applying the fixed upstream version hash
algorithm produces `0x893b947f12819a30`, whose uint32 value matches the original
cache's `0x12819a30`. This establishes version-hash compatibility only. The
actual framework's two symbol tables contain no retained Bytecodes table or
`ToString` anchor; vendor opcode equivalence is still unproved.

Using the fixed upstream
[bytecode definitions](https://github.com/v8/v8/blob/14.4.258.16/src/interpreter/bytecodes.h)
and operand widths interprets the owner’s 74 bytes as 27 instructions, ending
exactly at Return. That conditional interpretation constructs context, closures
and description objects; it is not promoted to an actual native creation call.
The original cache was never loaded, evaluated or patched.

A fixed-source check of NapCat commit
`7471e3ecd648189a9e80530b00348a17a4528906` scanned 886 source-language files.
Literal matches for the two entry names were service declarations and a message
field, with no direct creation caller found. The
[service declaration](https://github.com/NapNeko/NapCatQQ/blob/7471e3ecd648189a9e80530b00348a17a4528906/packages/napcat-core/services/NodeIKernelGroupService.ts#L196)
uses unknown argument types and cannot supply defaults or success semantics.
Computed dispatch remains outside that literal-search claim.

## Implementation requirements

Before adding the public action, establish the actual caller's variant selection,
member identity/source semantics, required fields and defaults. Close relevant V2
nested carriers if that variant is selected. The ordinary Session supplier and
three distinct entry shapes are now bound; complete the with-members core
service and response-closure edges, the JS registration/lifetime path and queued
callback dispatch. Determine how the caller distinguishes a created group from a security
challenge or rejection, including handling of `securityInfo` and `sign`. Other
binary profiles require independent evidence.

One group-creation domain should own captured input, profile admission, invocation
and outcome projection. It can reuse the existing operation lifetime, IPC and CLI
ports. The observed Promise path does not justify inventing a second listener
wait. Actual account and group mutations remain separately authorized acceptance.
