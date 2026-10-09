# Native Session creation and startup

The SDK selects a Session creation path from exported callable methods before invoking a factory:

- When both `NodeIQQNTStartupSessionWrapper.create` and `NodeIQQNTWrapperSession.getNTWrapperSession` exist, create the startup Session, then obtain account Session `nt_1`.
- Otherwise, when `NodeIQQNTWrapperSession.create` exists, select direct account creation without invoking an incomplete startup factory.
- When neither complete path exists, reject before invoking a Session factory.

Once selected, factory errors propagate. The SDK does not interpret a thrown native error as proof that the call had no effects, and does not try another creation path. Failed preparation retains its original rejected Promise; another `prepare()` call does not repeat initialization. A new client/worker is required for another explicit initialization attempt.

After authorized authentication and account `init`, the selected startup path invokes `startupSession.start()` once. The direct compatibility path invokes `accountSession.startNT(0)` once. A thrown start error is retained and never causes an argumentless retry. The direct argument is the existing compatibility contract; it is not a new inferred Windows ABI. Missing methods reject through the same native boundary. No automatic reconnect or retry is introduced by this change.

Readiness received synchronously during `init` or startup is buffered until the chosen startup call returns successfully. If it returns a Promise, that Promise must also fulfill first. A synchronous throw or Promise rejection wins over buffered readiness; close, timeout and originating-login replacement prevent a late completion from publishing login/ready. The SDK does not cancel dispatched native startup work. A successful start return alone is insufficient: the native readiness notification is still required.

The previous implementation caught any startup factory/account lookup exception and fell back to account `create`; it also retried `startNT()` after `startNT(0)` threw. Synthetic regressions reproduce both masked failures, including a fake second start that emitted readiness and incorrectly resolved login. Tests require the original error object/code, exact call counts, no alternate dispatch and no false readiness. The fresh installed consumer checks the actual compiled kernel with fake services and isolated temporary directories; it executes no addon, real login or account operation.

Read-only binary inspection found the compiled assertions for zero-argument startup `create` and one-argument `getNTWrapperSession` in all six current platform/CPU samples and both older Linux 3.2.31 samples. The parent independently rechecked eight original binary hashes and assertion offsets, including the original macOS x64 auxiliary archive. Assertion strings are static evidence, not proof that methods are registered or that authenticated startup succeeds. No `startNT` argument assertion was found in those samples. Existing prepare-only CI does not exercise account Session start; real login/restore acceptance requires a newly authorized batch tied to this source.

The shared installed check reports `sessionStrategyContract:true` and `nativeSessionStrategyLoginAttempted:false`. Six-platform CI requires both fields rather than promoting synthetic checks to account evidence. Vendor signing/provider authenticity remains unverified.
