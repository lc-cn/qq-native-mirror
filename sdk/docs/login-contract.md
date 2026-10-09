# Pure Node login contract extracted from local NapCat

Source: `/Users/liuchunlang/Library/Containers/com.tencent.qq/Data/Documents/napcat/napcat.mjs`, observed 2026-09-30. This is a static extraction, not proof that ordinary Node can load or log in using the native library. No login was attempted.

## Native loading and preparation

`bae` at lines 39986-40003 loads an explicit `NAPCAT_WRAPPER_PATH` via `process.dlopen({exports:{}}, path)`. The returned exports supply the wrapper classes below. No Electron import appears in this loader function itself.

However, Shell bootstrap `tL` (around 82398) first initializes a native packet hook (`qEe.init`) and an independent native loader (`HEe`), and calls `nativeExports.enableAllBypasses` unless disabled. These are custom NapCat instrumentation and must not silently be treated as native QQ API requirements, or silently omitted as proven unnecessary. Determine their relationship to native initialization crashes independently. WebUI, OneBot adapters, named pipes, QR terminal rendering, telemetry packet capture and global Date.now replacement are NapCat facilities, not minimal login API requirements.

## Initialization order

1. Obtain `wrapper.NodeIQQNTWrapperEngine.get()` and `wrapper.NodeIKernelLoginService.get()`.
2. Try `wrapper.NodeIQQNTStartupSessionWrapper.create()` plus `wrapper.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1')`; if that sequence throws, fall back to `wrapper.NodeIQQNTWrapperSession.create()`. Keep startup session alive when created.
3. Create an independent root data directory and global directory. Local NapCat chooses the user's existing QQ Application Support path on macOS; an npm implementation should instead pass the explicitly requested isolated data paths.
4. Call `engine.initWithDeskTopConfig(config, engineCallbacks)`.
5. Call `login.initConfig(loginConfig)`.
6. Register login callbacks with `login.addKernelLoginListener(listener)` before `login.connect()`.
7. On `onLoginConnected`, wait until `login.getMsfStatus() !== 3`, then request `login.getQRCodePicture()`. NapCat waits 500 ms each poll; implement a timeout/cancellation to avoid indefinite wait. Status enum meaning is not established by this extraction.
8. On `onQRCodeLoginSucceed({uid,uin})`, initialize the account session and await its readiness callback.

Engine configuration (lines 82058-82079):

```ts
{
  base_path_prefix: '', platform_type: platform, app_type: 4,
  app_version: fullVersion, os_version: os.release(), use_xlog: false,
  qua,
  global_path_config: { desktopGlobalPath: globalDir },
  thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 }
}
```

Platform values extracted at line 33590: Windows=3, macOS=4, Linux=5. Version, appid and qua must be a coherent tuple for the actual native package, not arbitrary defaults.

Engine callback class (40561) provides no-op `onLog`, `onGetSrvCalTime`, `onShowErrUITips`, `fixPicImgType`, `getAppSetting`, `onInstallFinished`, `onUpdateGeneralFlag`, `onGetOfflineMsg`. The bundle does not establish return types or safety of every callback in other versions.

Login configuration (82081-82092):

```ts
{
  machineId: '', appid, platVer: os.release(), commonPath: globalDir,
  clientVer: fullVersion, hostName, externalVersion: false
}
```

## Login callbacks and behavior

`onQRCodeGetPicture({pngBase64QrcodeData,qrcodeUrl})` supplies the QR payload. Strip an optional data:image/...;base64 prefix and decode to Buffer. Emit a public QR event; no filesystem QR persistence is required.

`onQRCodeSessionUserScaned` means scanned, awaiting phone confirmation. Spelling is native and must remain exact.

`onQRCodeLoginSucceed({uid,uin})` supplies authenticated account identity. This is login success, not full account session readiness.

`onQRCodeSessionFailed(errType,errCode)` reports QR failures. Local NapCat refreshes for type=1/code=3 (expired), but a library should surface the event and respect refresh/cancel policy.

`onLoginFailed(...args)`, `onLoginDisConnected`, `onLogoutSucceed`, `onUserLoggedIn` must be represented in the library state machine. Do not mark a disconnected account ready.

Full login listener class at 39414 includes: onLoginConnected, onLoginDisConnected, onLoginConnecting, onQRCodeGetPicture, onQRCodeLoginPollingStarted, onQRCodeSessionUserScaned, onQRCodeLoginSucceed, onQRCodeSessionFailed, onLoginFailed, onLogoutSucceed, onLogoutFailed, onUserLoggedIn, onQRCodeSessionQuickLoginFailed, onPasswordLoginFailed, OnConfirmUnusualDeviceFailed, onQQLoginNumLimited, onLoginState, onLoginRecordUpdate.

NapCat wraps the listener in a Proxy returning a logging no-op for unknown method names (39721). This is compatibility plumbing, not a guarantee that a no-op has correct return semantics.

`login.getLoginList()` returns `LocalLoginInfoList`; `quickLoginWithUin(uin)` is attempted for a cached account. Account number alone is not authentication material. Password and device verification flows exist in this bundle but need a separately extracted and validated contract; QR is the smallest verifiable path.

## Account session initialization

After authenticated identity, get `login.getMachineGuid()` and format the returned unhyphenated value as 8-4-4-4-12 (validate before formatting). `wae` at 40102 constructs:

```ts
{
  selfUin: uin, selfUid: uid,
  desktopPathConfig: { account_path: dataDir }, clientVer: fullVersion,
  a2: '', d2: '', d2Key: '', machineId: '', platform,
  platVer: os.release(), appid,
  rdeliveryConfig: {
    appKey: '', systemId: 0, appId: '', logicEnvironment: '', platform,
    language: '', sdkVersion: '', userId: '', appVersion: '', osVersion: '',
    bundleId: '', serverUrl: '', fixedAfterHitKeys: ['']
  },
  defaultFileDownloadPath: downloadsDir,
  deviceInfo: {
    guid, buildVer: fullVersion, localId: 2052, devName: hostName,
    devType: os.type(), vendorName: '', osVer: os.release(),
    vendorOsName: os.type(), setMute: false, vendorType: 0
  },
  deviceConfig: '{"appearance":{"isSplitViewMode":true},"msg":{}}'
}
```

`session.init(config, dependsAdapter, jsComm, sessionListener)` then `startup.start()` when present; otherwise try `session.startNT(0)` followed by `session.startNT()` only if the first call throws. Local bundle resolves readiness when `onOpentelemetryInit({is_init:true})` fires and rejects for false (82344). This may be only one readiness signal and needs runtime validation.

Depends adapter class (40535): onMSFStatusChange, onMSFSsoError, getGroupCode. JS communication class (40553): dispatchRequest, dispatchCall, dispatchCallWithJson. Session listener class (39400): onNTSessionCreate, onGProSessionCreate, onSessionInitComplete, onOpentelemetryInit, onUserOnlineResult, onGetSelfTinyId. They are mostly no-op stubs locally.

## Cleanup and concurrency limitations

No reliable native `disconnect`, `removeKernelLoginListener`, `destroy`, or engine uninitialization contract was found in this local bundle. Do not invent and invoke teardown method names. Hold listener objects strongly; detach public handlers and timers on cancellation, but disclose that this alone does not shut down native threads. A child process running ordinary Node (not a QQ/Electron host) may supply process-level fault and lifecycle isolation while preserving the pure Node requirement. In-process unload and multiple accounts cannot be promised: engine/login services are singleton getters and likely carry global state.

## Evidence boundaries

All contracts here come from local static source. Loading, native callbacks, QR generation, authenticated session readiness and cleanup remain separate runtime milestones. No public npm API should claim working login until at least QR generation and a human-authorized phone confirmation have been observed.

## Linux restore: static configuration evidence (2026-09-30)

The authorized Linux arm64 QQ 3.2.32-52194 QR session reached readiness, but its subsequent native login list contained one account with `isQuickLogin`, `isAutoLogin`, and `isUserLogin` all false. Restore continues to require the native `isQuickLogin === true` flag. This is not an account selection error. No login record, MMKV, ticket, or flag was modified during this investigation.

The pinned primary contract [NodeIKernelLoginService.ts](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/services/NodeIKernelLoginService.ts) declares `setRemerberPwd(remember: boolean)` (native spelling), but `setAutoLogin` accepts an unspecified argument. The SDK supports optional `rememberPassword?: boolean`: when supplied, it calls `setRemerberPwd` after `initConfig` and before `connect`. Undefined leaves the native setting untouched; a missing setter rejects initialization. This is a native password persistence preference, **not proof that QR login will become restorable**. `setAutoLogin` remains unused because its argument contract is unknown.

Static inspection of the official Linux package found compiled JavaScript strings in `major.node` naming `LoginStorageService`, `syncLoginRecords`, `setQuickLoginByUin`, `syncNewLoginConfig`, `applyNewLoginConfig`, `persistLoginEntries`, and `checkCanNotQuickLogin`. Logs mention account configuration hits, forced disable, and an initial account with no matching configuration skipping a write. Nearby password-login strings include `forceRememberPwd`, `setAutoLogin`, `shouldAutoLogin`, `setRemerberPwd`, and `shouldSave`. These strings establish that the official application has a configuration/persistence layer beyond native QR session readiness; they do not reveal executable ordering, setter arguments, or establish why this particular Linux record has false flags. The core `application.asar` JavaScript entries are nonplaintext and launch through `major.node.load('internal_index', module)`.

Reproducible static artifacts under `.local/research/linux-arm64/opt/QQ/resources/app`:

- `major.node`: SHA-256 `de98700071d18747ea4fedc039278c7d258e7477302b084a7ffbc1cb55210db1`.
- `application.asar`: SHA-256 `13733adff8cc024ef70a734b7f3e0254307496660f7fcd41e8e0971480ab5c50`.

Mock tests verify true/false/undefined behavior, ordering, and missing-method rejection. No account, signing, or persistence operation was executed to validate the new option; Linux restore remains unverified and unsuccessful with the previously observed record.
