# Native signing integrity investigation

Observed 2026-09-30. This investigation takes priority over further account tests. Existing account credentials are preserved. No new signing requests, account logins, sends or changes are used to probe detection behavior.

## Current conclusion

The project has functional proof for macOS authentication, account readiness, contact/group/history reads, reception, explicit text send/recall and process restart/restore. Linux arm64 has authentication/readiness proof, but restoration failed because its existing native record exposes three false login flags. These facts do not prove that the security signing environment matches the vendor client or that later server checks will accept it.

There is no demonstrated causal chain in current evidence from a specific detection bit to a fabricated security signature to a server-side account marker and kick. Absence of that evidence is not a guarantee of safety.

Static analysis of the pinned Linux arm64 provider now demonstrates caller-image inspection: `dladdr` and an image-path string predicate select writes of zero or one to internal process-global field `0x89e36d8`, while the routine's sole normal return sets `w0=0`. This makes a simple zero-return success interpretation invalid for this routine. The field's consumers and meaning remain unknown; it is not identified as a fake-sign or account-marker bit. This observation supplies a concrete next investigation target, not a workaround or authentic-signature proof. See [provider evidence](linux-signing-static.md#provider-local-caller-image-predicate-and-normal-return).

The user clarified that this report came privately from a professional and that no public project name, issue or quotation is available. It remains an unresolved investigation hypothesis. Lack of a public citation must not be treated as evidence against it. No repeated login experiment on the user's regular account will be used to test the hypothesis.

## JavaScript initialization contract audit

A static comparison against pinned NapCatQQ commit `26d7533e0f5800fdff865ab2f2ad7692917e1076` found the same empty engine/login/session fields (`base_path_prefix`, `machineId`, `a2`, `d2`, `d2Key`, rdelivery/vendor configuration) in the primary implementation. Its login `machineId` declaration is the literal empty string. Existing device GUID acquisition uses the native machine-GUID result, and exported version/AppID/QUA already derive from package/architecture metadata. No confirmed required field with a supported calculation was found missing in this JavaScript boundary. This comparison is not evidence that either environment produces authentic signatures.

The native QIMEI setter belongs to an unresolved MSF initialization chain; the fixed JavaScript source provides no confirmed QIMEI/appSigned setter contract. Supplying invented values would not resolve that gap. The upstream also contains extra O3 calls using hardcoded data/report arguments; these were not copied as a presumed initialization fix, since their semantics and requiredness are unverified. Continue investigating native provider data/environment provenance rather than replacing empty configuration with fabricated tickets or device identifiers.

## Installed vendor bootstrap inspection

Read-only inspection of installed macOS QQ 7.0.2-53644 finds outer launchers delegating to `major.node.load('internal_index',module)` and `internal_launcher`. Its application.asar SHA-256 is `e515fbf7c47d0e05a5539c9aeeea8a3268551dd5f6ddb7a39a9a4bb656c7bf12`: 1,433 members, including 173 packed JavaScript-named entries. No inspected entry contains the selected plaintext engine/signing initialization terms. The two archived launcher entries are 80-byte non-UTF-8 payloads. The package declares byte-code shell mode; these observations do not identify the exact payload encoding or prove the absence of initialization logic.

All inspected members with embedded SHA-256 metadata match it, which establishes internal archive consistency only, not Tencent provenance or protocol-signature integrity. The installed package main references the user's NapCat loader, so its outer main configuration must not be treated as an untouched official startup baseline. No application file was changed, and no major.node/app script/account data was loaded. `scripts/inspect-official-bootstrap.py` reproduces the inventory and checks; receipt `.local/research/official-bootstrap-inspection.json`. Direct vendor initialization remains hidden behind the native loader/opaque payload boundary rather than available as a confirmed plaintext JavaScript contract.

## Distinct meanings of signature

- Package/file SHA-256 pins downloaded bytes. A third-party release checksum alone does not authenticate Tencent as the producer.
- macOS code signatures bind executable code and sealed bundle resources. They do not prove QQ protocol signatures are generated in a supported runtime.
- `qq_magic_napi_register` is a module-registration symbol. Our C bridge forwards it to Node's standard `napi_module_register`; it does not generate protocol signatures or fabricate a server reply.
- QQ protocol security signatures are managed inside native components. The Linux wrapper contains SecuritySignManager/Callback symbols, a signature-needed flag and a missing-callback error string. These strings establish that relevant code exists, not which path executed.

## Local macOS binary provenance check

Read-only `codesign --verify --strict` on `/Applications/QQ.app/Contents/Resources/app/wrapper.node` succeeded outside the filesystem sandbox. Its SHA-256 also matches the wrapper entry in the installed QQ bundle's `Contents/_CodeSignature/CodeResources` seal. The already exported local wrapper uses the same bytes.

Whole-app `codesign --verify --deep --strict --verbose=4` did not pass: it identifies the added `Resources/app/package.json.bak` file. The current package.json and this backup are byte-identical. This is an extra sealed-resource issue, not evidence that wrapper.node was modified or that protocol signatures are fake. Neither the backup nor any user-installed QQ files were removed or changed during this investigation. Sandbox-only verification first reported a trust error; the unsandboxed detailed result above is the relevant result.

## Implementation audit

`native/registration-bridge.c` supplies registration forwarding and explicit system-library loading. It contains no detector result replacement, signing response stub, process-identity rewrite or packet hook.

`src/kernel.ts` currently supplies placeholder configuration fields and no-op host callbacks, including shell dispatch and app-settings callbacks. Generic callback Proxies also return a no-op for unfamiliar method names. That can hide an incomplete host contract. Fixed upstream NapCat code uses several similar empty callbacks, but similarity is not proof that they are adequate or that they participate in signing.

The SDK now emits `native-callback` diagnostics containing only callback family, method name and argument types for these no-op callbacks. This identifies unanswered host requests without logging payloads. It does not implement their missing behavior or prove signing initialization. Native kick, login disconnect and MSF error events preserve their original arguments; none currently establishes a safely retryable transport failure. Unknown failures and forced logout therefore never automatically log in again, even when `autoReconnect` is enabled.

Account readiness comes from the native Session callback. Text send success comes from the correlated native update and send status; recall waits for the corresponding native update. These acknowledgements were not synthesized locally. They establish those operations, not signing integrity.

An intact native binary may depend on initialization performed by the original host. Native dependency availability and module registration are only part of that initialization. The exact signing callback/provider initialization and any error/fallback behavior are still unresolved.

## Evidence required before stronger claims

1. Pin binary source, version, architecture and dependencies, and report vendor authenticity separately from mirror transport integrity.
2. Trace the supported initialization path for the native security signing provider and classify required host requests versus optional notifications. Observe only method names, argument types and failure categories in SDK diagnostics; do not dump signature bytes or credentials.
3. Treat a missing required provider/request handler as an explicit failure. Never substitute an empty or fabricated signature or a fake success value.
4. Preserve native disconnect/kick/error reasons and stop automatic retries on forced-offline/security failures. Unknown reasons must remain unknown rather than receive an invented detector interpretation.
5. Compare functional/session evidence and signing-environment evidence separately. A short successful login/send run is insufficient for a long-term safety guarantee.

The original pure-Node/no-QQ-host objective remains unchanged. If its required signing host contract cannot be demonstrated, report that limitation instead of declaring it solved or changing the project into a hosted QQ launcher.

The exact Linux arm64 binary now has bounded disassembly evidence for the callback setter, its initialization call sites, null/failure/success branches, and a candidate provider routine calling `dladdr` on the caller image. No-account runtime observation identifies the registered callback object during Node initialization; the provider's signing branch and output remain unknown. See [offline native chain](linux-signing-static.md) for hashes, addresses, reproduction scripts and limits.

Related evidence: [community sources](signing-community-evidence.md), [Linux runtime and restore](linux-runtime.md), [SDK acceptance](sdk-acceptance.md).

## Initialization callback audit snapshot

`client.nativeCallbackAudit` retains up to 128 distinct callback family/name/argument-type shapes and occurrence counts, including callbacks emitted before `createClient()` returns. It returns defensive copies and stores no argument payloads. Consumers can inspect this after initialization and also subscribe to `native-callback` for later notifications. This observes the no-op callback boundary only: it cannot inspect native signing pointers, signature bytes, native branches or server-side decisions. Its counts span worker generations for the same client object and are diagnostic, not provider-readiness evidence.

## Current initialization evidence

The Linux arm64 prepare flow now has no-account runtime evidence: a hardware-breakpoint observation recorded an MSFService initialization entry and a non-null global callback/control pair; the object's vtable matched the statically identified MSFSecuritySignCallback. The observer ran with no network and a fresh empty data directory, and did not call signing. This resolves the null-callback hypothesis for that exact tested initialization path. Provider execution, output semantics and any detection marker remain unverified; callback registration must not be reported as authentic-signature verification. Details and limits are in [the native investigation](linux-signing-static.md).

## Version comparison boundary

Independent old-version analysis now locates the same callback RTTI class in Linux 3.2.31-51102 arm64 and a three-region result-copy shape. Absolute addresses are derived from each pinned ELF; the 3.2.32 map cannot be reused for 3.2.31. Extra older pre-provider calls are unresolved and are not automatically interpreted as a detector or a provider-readiness fix. See linux-signing-static.md for independently checked addresses and reproduction.

A separate no-account 3.2.32 hardware-breakpoint run watched both callback sign entry and candidate provider entry during preparation. Neither entry was hit in that observed interval, although the callback was registered. The registration evidence therefore does not establish signing execution during prepare. Neither observation covers authenticated requests or server-side account marking.
