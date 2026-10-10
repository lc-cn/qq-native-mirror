# Windows native loading investigation

Checked 2026-10-09. The initial sections record official downloads, source inspection and static PE findings. Subsequent CI built the pinned-runtime adapter and passed headless prepare/close on both Windows architectures, as recorded in the final section. No Windows account login or business operation has been validated.

## Official sources and architectures

The [QQ official PC page](https://im.qq.com/pcqq/index.shtml) loads [Tencent Windows configuration](https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/windowsConfig.js). The configuration fetched here lists 9.9.36 updated 2026-09-24, with independent `ntDownloadX64Url` and `ntDownloadARMUrl` links under Tencent `qqdl.gtimg.cn/qqfile/QQNTV2/9.9.36/release/e8e54bbb/`. These are current discovery metadata; they were not downloaded in this inspection.

For a reproducible same-version baseline, [upstream installer index](https://github.com/Rodert/qq-versions/releases) records official Tencent 9.9.33 links. The ARM64 installer was downloaded directly from [Tencent](https://qqdl.gtimg.cn/qqfile/QQNT/9.9.33/release/497e2f1f/QQ_9.9.33_260813_arm64_01.exe), size 186881704, SHA-256 `ee77d6d8bdfc4f4c9bf9c6d2521322ff410d2614a7e8ba005aaa9703fc9ef174`. A Linux archive tool extracted it without executing the installer. The installer PE machine is `0x014c` (x86 self-extractor), while its actual `Files/versions/9.9.33-52230/resources/app/wrapper.node` has PE machine **`0xaa64` (ARM64)**, SHA-256 `54e5a6ce127a1f973f28e38ddfbf1338403ea323a141546a6578dd25332c928a`. Thus this native ARM64 wrapper is independently confirmed; running the x64 edition through Windows ARM emulation is a separate target and cannot count as native ARM64.

## Pure Node upstream evidence

[NapCat release-publish workflow](https://github.com/NapNeko/NapCatQQ/blob/main/.github/workflows/release-publish.yml) assembles a Windows Node bundle using stock Node 22.11.0 win-x64, an extracted official QQ x64 installer, selected vendor DLLs and wrapper.node, plus its repository's QQNT.dll. A Windows runner source step invokes `node.exe -e "...require('./wrapper.node')..."` to check a named export. This is a concrete upstream pure-Node build/test recipe, not evidence that our package has passed Windows runtime tests. Its current recipe is x64 only.

The [upstream compatibility QQNT.dll](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-develop/QQNT.dll), downloaded only for static inspection, is machine `0x8664`, SHA-256 `2f9ae01c30fa624535439cab9ccc2ba56d95e5f2ec85e6182789cb3c9089f3b7`. Its exports include thousands of forwarding entries to `node.exe`; specifically `qq_magic_napi_register` forwards to `node.exe.napi_module_register`. This differs from loading the full official Electron QQNT library. We should build our own minimal forwarder from audited imports instead of redistributing this prebuilt binary with unclear build provenance. Its x64 machine code does not support native ARM64.

## Actual ARM64 wrapper imports and bridge contract

`llvm-objdump -p` on the extracted ARM64 wrapper identifies `QQNT.dll` as an import-library name. Imported symbols include standard `napi_*`, libuv `uv_*`, `qq_magic_napi_register`, and two C++ names:

- `?GetCurrent@Isolate@v8@@SAPEAV12@XZ`
- `?IsEnvironmentStopping@node@@YA_NPEAVIsolate@v8@@@Z`

A purpose-built `QQNT.dll` can plausibly export the exact imported names using a generated `.def`: regular names forward to the matching `node.exe.<name>` export; only `qq_magic_napi_register` maps to `node.exe.napi_module_register`. This is a PE loader contract, not a Unix `RTLD_GLOBAL` registrar bridge: a separate global `.node` exporting that symbol does not by itself satisfy imports explicitly bound to QQNT.dll. DLL placement/search and the complete vendor dependency closure must be handled before loading wrapper.node.

Node 24 compatibility is **unverified**. N-API compatibility does not establish compatibility of the two Node/V8 C++ imports or libuv handle layouts compiled against QQ's runtime. CI must inspect the chosen official Node24 `node.exe` export table for every imported symbol and build each forwarder with matching native machine architecture, then perform actual empty-directory, no-account prepare. An export-name match proves symbol availability only, not ABI/runtime safety. No fallback should silently substitute missing private APIs or map `qq_magic_node_register` blindly.

The direct DLL dependencies also include vendor `libvips-42.dll`, `libglib-2.0-0.dll`, `libgobject-2.0-0.dll`, `crypto.dll`, `ssl.dll` and many Windows system libraries. Their recursive imports, delay-load imports and runtime-loaded modules remain to be inventoried. The [upstream wrapper-loading code](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-core/index.ts) additionally documents `mfplat.dll`/Media Foundation as a Windows Server concern with its chosen QQNT configuration; that warning is not proof that our minimal-forwarder closure has the same dependency.

For GitHub Actions, native Windows x64 and native Windows ARM64 executions must be separate receipts: report OS, `process.arch`, Node version, wrapper PE machine/hash, exact bridge hash and no-account prepare result. An x64 process on an ARM64 runner remains x64 emulation. Building auxiliary packages across six platform/architecture cells does not prove the proprietary wrapper initializes in all six.

Private research files are under `.local/research/windows-upstream/` and extracted ARM64 native files under `.local/research/windows-extracted/`. Original native bytes were not modified.

## Actual two-architecture exports and Node24 blocker

The official matching x64 installer was also downloaded and archive-extracted: [Tencent x64 9.9.33](https://qqdl.gtimg.cn/qqfile/QQNT/9.9.33/release/497e2f1f/QQ_9.9.33_260813_x64_01.exe), SHA-256 `b25c0d3ce9df764074a9118d0ded927e1b2d7ebf60e306112e8df18a040ec492`. Its wrapper machine is `0x8664`, SHA-256 `63112ab9161e127f5f7e17998a7196e143808923fb54cbbf7b4e21426187a5f0`.

Static native closures were exported with `scripts/export-windows-native.py`:

| Target                                      | Files / bytes  | Native metadata |
| ------------------------------------------- | -------------- | --------------- |
| `.local/native/qq-9.9.33-52230-win32-arm64` | 12 / 138852224 | appId 537379423 |
| `.local/native/qq-9.9.33-52230-win32-x64`   | 17 / 174686216 | appId 537379411 |

Both use `clientVersion=9.9.33-52230` from package.json and literal QUA `V1_WIN_NQ_9.9.33_52230_GW_B` and appId markers from major.node. Every copied PE matches its target architecture and every output file's size/hash was checked. Original official QQNT.dll, QQ.exe and account data are excluded. The flat sibling DLL layout has unique names and follows regular/delay imports; system API-set DLL names are recorded externally. Optional runtime-loaded libraries remain unproven. Schema-1 manifests describe the vendor files **but these bundles are not yet runnable**: a successfully built compatibility QQNT.dll must first be added with hash to each manifest.

`scripts/pe-inspect.py` parses PE normal/delay imports and named exports without loading code. Both wrapper closures require 99 distinct QQNT exports. `scripts/generate-windows-forwarder.py` compares those symbols with an architecture-matched official node.exe before emitting DEF, mapping only qq_magic_napi_register to napi_module_register.

Official [Node24.20 win-arm64](https://nodejs.org/dist/v24.20.0/win-arm64/node.exe) and [win-x64](https://nodejs.org/dist/v24.20.0/win-x64/node.exe) were downloaded for static export comparison. **Both lack** `?IsEnvironmentStopping@node@@YA_NPEAVIsolate@v8@@@Z`; the other 98 requested names exist. The generator therefore fails explicitly and emits no DEF. The Node24 public header exposes GetCurrentEnvironment but no IsEnvironmentStopping declaration; no verified equivalent stop-state API was found in this bounded check. A fabricated constant return would not preserve the imported function's contract and was not implemented. This is a concrete blocking difference from upstream's Node22.11 recipe, and Node22's actual export availability still requires independent inspection.

Possible next work is to locate a genuine upstream contract for that missing API or choose a documented compatible Node runtime, then build the audited bridge and run native Windows no-account prepare. Presence of the remaining names does not remove V8/libuv ABI risk. Current artifacts provide static source/architecture/hash/dependency evidence only; neither Windows target has a runtime pass in this investigation.

## Real stopping-state implementation contract

The function was not located in the current Electron main Node patch inventory; it must not be attributed to a confirmed public Electron patch without evidence. Instead, the **official QQ ARM64 QQNT.dll export itself** supplies an authoritative local contract. Its exported RVA is `0x17458b0` (image address `0x1817458b0`). Disassembly shows: null isolate branches to return true; `v8::Isolate::InContext()` false also returns true; it creates/restores HandleScope state, obtains current context and an environment pointer; null environment returns true; otherwise an ARM64 `LDARB` reads the environment stopping byte and returns it. The official binary offset `env+0x428` is QQ-runtime-specific and **must not be applied to Node24**.

Exact [Node24.20 env-inl.h](https://github.com/nodejs/node/blob/v24.20.0/src/env-inl.h) defines `Environment::GetCurrent(Isolate*)` using InContext, HandleScope and GetCurrentContext; its context overload checks the Node context tag before retrieving the environment. `Environment::is_stopping()` loads a `std::atomic_bool`, with matching field declaration in [env.h](https://github.com/nodejs/node/blob/v24.20.0/src/env.h). A source-level adapter can therefore implement the observed contract faithfully:

`if (!isolate) return true; env=Environment::GetCurrent(isolate); return !env || env->is_stopping();`

Prototype source is `native/windows/environment-stopping.cc`; it is not integrated or compiled here. The DEF should map only the missing mangled name to local `qq_node_environment_stopping`, with the other 98 exports forwarded normally. This reads the real environment state, including null/non-Node contexts, and does not replace it with a constant.

Compilation requires `NODE_WANT_INTERNALS=1`, full **exact-runtime Node source** including internal/dependency headers, matching generated `node_version.h`/`node_config.h` where required, Node release import library, and the actual runtime build configuration (`config.gypi`/`process.config`). `HAVE_INSPECTOR` and other layout-affecting feature macros change Environment members; V8 pointer compression/sandbox and architecture macros must also match. Merely using Node24 public headers or matching `NODE_MODULE_VERSION` is insufficient. Do not hardcode a private field offset or assume all Node24 patch releases share its layout. Pin the precise runtime version/config used for the bridge build and reject mismatched runtimes until rebuilt; source-level compatibility is not internal binary-layout stability.

The atomic load makes reading the stopping flag itself thread-safe while the Environment remains alive. It does not make V8 InContext/GetCurrentContext calls safe from arbitrary non-isolate threads, nor extend Environment lifetime. The adapter must preserve the existing caller-thread/lifetime assumptions; actual no-account prepare and shutdown tests on native Windows x64/ARM64 are required. This prototype cannot yet be labelled runtime-safe or complete Windows support.

Public N-API offers teardown cleanup hooks and closing status for particular operations, but no public synchronous equivalent taking `v8::Isolate*` and returning the complete Environment stopping/null-context predicate was identified. A cached cleanup-hook boolean would have a different lifecycle and must not silently substitute for this API. The internal-source adapter is a feasible precise route for pinned official Node24 builds; compilation/ABI and runtime verification remain the next required evidence.

## Dedicated real Stop transition verifier

`native/windows/verify-stopping.cc` is an independent N-API probe, intended solely for a fresh dedicated Node process. It loads the already-built adapter DLL at an explicit runner-supplied absolute `QQ_STOPPING_ADAPTER_DLL` path, invokes its exported real predicate for null and a current live environment, calls public `node::Stop(environment, node::StopFlags::kDoNotTerminateIsolate)`, and invokes the predicate again. It emits booleans/result classification only, flushes stdout and deliberately `_Exit`s. No QQ module, account or private-field modification is involved.

Exact [Node24.20 node.h](https://github.com/nodejs/node/blob/v24.20.0/src/node.h) declares `int Stop(Environment*, StopFlags::Flags)`, with `kDoNotTerminateIsolate = 1 << 0`. Its [node.cc implementation](https://github.com/nodejs/node/blob/v24.20.0/src/node.cc) calls `env->ExitEnv(flags)` and returns zero; [env.cc](https://github.com/nodejs/node/blob/v24.20.0/src/env.cc) sets stopping true synchronously, omits explicit isolate termination with this flag, then schedules disabling JS calls and stopping the event loop. Therefore the immediate second predicate call can test the actual transition without writing an internal flag. It makes no N-API calls after Stop.

Build the verifier as a separate `.node` with the official same-version public Node/V8 headers and node.lib, release CRT and matching architecture. This source does not require compiling its own internal Environment layout; it calls the built adapter under test. Dedicated runner invocation shape: set `QQ_STOPPING_ADAPTER_DLL` to the absolute built DLL, then `node -e "require('./verify-stopping.node').verify()"`. Compilation/execution remain Windows CI responsibilities. A passing receipt demonstrates this actual predicate transition, **not** a normal Node/SDK close or environment lifetime/threading guarantee; client.close must be validated separately.

## Windows 9.9.33-52230 buddy-list candidate profile and six-platform CI

The SDK now accepts the exact version `9.9.33-52230` as a **static upstream candidate** for the three-argument buddy-list contract. The pinned primary source is NapCatQQ commit `26d7533e0f5800fdff865ab2f2ad7692917e1076`: [friend.ts lines 18–36](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/friend.ts#L18-L36) calls `getBuddyListV2('0', true, BuddyListReqType.KNOMAL)` for its newer-build branch, reads `result.data.flatMap(item => item.buddyUids)`, and requests `NodeIKernelProfileService/getCoreAndBaseInfo` with `'nodeStore'` and those UIDs. The [service declaration](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/services/NodeIKernelBuddyService.ts) declares both the older two-argument and newer three-argument overloads. This source supports the SDK's chosen call and validation shape; its build threshold is not treated as a universal cross-platform ABI guarantee.

Official-package artifacts were inspected as bytes, without executing application JavaScript. Paths below are relative to `.local/research/`, and offsets are zero-based file-byte offsets, not virtual addresses:

| Architecture | Artifact path                                                                      |     Bytes | SHA-256                                                            |
| ------------ | ---------------------------------------------------------------------------------- | --------: | ------------------------------------------------------------------ |
| x64          | `windows-x64-extracted/Files/versions/9.9.33-52230/resources/app/major.node`       | 107373608 | `3fdc17fa0512fd4b702f34a0025ffe4eca0a5c70229872f7fc0a0324bdfb5fdf` |
| x64          | `windows-x64-extracted/Files/versions/9.9.33-52230/resources/app/application.asar` |  30339880 | `882aa00613afd72f63b424dce347d0bffceb25c5ce643babcebe2776ab8606d7` |
| arm64        | `windows-extracted/Files/versions/9.9.33-52230/resources/app/major.node`           | 107669552 | `f8e406b2464bce4a74b6c74a782f15d1d3c76a52daacc89935cd3cd8ef2fdfdc` |
| arm64        | `windows-extracted/Files/versions/9.9.33-52230/resources/app/application.asar`     |  30601572 | `5a20441ca8f1e81937f7fc3b9a71c27be0ff7705b8b5bec126ca07e886d2ba78` |

The `major.node` local string clusters contain:

| Token                                                 | x64 offset | arm64 offset |
| ----------------------------------------------------- | ---------: | -----------: |
| `getBuddyListV2`                                      |    5958384 |     36357672 |
| `forceRefresh` (in the same cluster)                  |    5958435 |     36357723 |
| `kNomal`                                              |    5958485 |     36357773 |
| `getBuddyList(from=`                                  |    5958510 |     36357798 |
| `,force=`                                             |    5958545 |     36357833 |
| `,fromNt=`                                            |    5958565 |     36357853 |
| `onBuddyListChange` (standalone token in the cluster) |    5958726 |     36358014 |
| `userSimpleInfos`                                     |    5958782 |     36358070 |

These tokens corroborate the method and refresh/request naming in both official architectures. They do **not** prove executable argument order, call arity, notification payload layout, or a successful authenticated query. Core ASAR entries are precompiled rather than accessible plain application source; the x64 ASAR entry-byte scan did not find a plaintext `getBuddyList` call. The candidate keeps existing category/UID/result/profile-Map validation and was covered by version-parameterized mocked list/history fixtures. No Windows business API runtime certification follows from these tests.

The first six-platform CI run [37878933698](https://github.com/lc-cn/qq-native-mirror/actions/runs/37878933698), as reported by the coordinating agent's CI observation, exercised installed-consumer package resolution and native prepare/close. The Windows runtime was Node `24.20.0`, with `98` native exports; Windows x64's successful job was `113653866830`. This is runtime evidence for installation, native loading, headless environment preparation and process close. It does not establish QR/account login, session readiness after authentication, friend/group/history queries, or message/media sending on Windows. This appendix's static inspection did not execute login, restore, signing or account queries.
