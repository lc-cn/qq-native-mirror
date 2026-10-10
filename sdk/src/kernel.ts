import { serializeKernelError } from './errors.ts';
import { withCleanupFailure } from './runtime/cleanup.ts';
import { createNativeServices, type ServiceOperation } from './native-services.ts';
import { normalizeLoginRequest } from './native/login-request.ts';
import type { LoginRequest } from './types.ts';
import { AccountSessionLifecycle } from './runtime/account-session-lifecycle.ts';
import type {
  AccountIdentity,
  AccountSessionOptions,
} from './runtime/account-session-lifecycle.ts';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname, platform, release } from 'node:os';

// QQ exports are proprietary and versioned; this boundary intentionally validates
// the required methods at runtime rather than asserting a stable upstream API.
import type { NativeObject } from './native/native-object.ts';
export interface KernelOptions extends AccountSessionOptions {
  loginTimeoutMs?: number;
  rememberPassword?: boolean;
}
export type { LoginRequest } from './types.ts';
export type { AccountIdentity } from './runtime/account-session-lifecycle.ts';

function nativeAccountNumber(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

export function createKernel(
  wrapper: NativeObject,
  options: KernelOptions,
  emit: (event: string, payload: unknown) => void,
) {
  let loginService: NativeObject | undefined;
  let listener: NativeObject | undefined;
  let startupSession: NativeObject | undefined;
  let accountSession: NativeObject | undefined;
  let sessionStrategy: 'startup' | 'direct' | undefined;
  let identity: AccountIdentity | undefined;
  let ownedSession: AccountSessionLifecycle | undefined;
  let forcedOffline = false;
  let lastMsfStatus: { status: unknown; reason: unknown } | undefined;
  let accountMsfConnected = false;
  let closed = false;
  let initialized = false;
  let generation = 0;
  let pending:
    | {
        method: LoginRequest['method'];
        targetUin?: string;
        authenticationIssued: boolean;
        resolve: (account: AccountIdentity) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let request: LoginRequest;
  let requesting = false;
  const notify = (event: string, payload: unknown) => {
    if (!closed) emit(event, payload);
  };
  const clearTimers = () => {
    clearTimeout(timeout);
    clearTimeout(poll);
    timeout = poll = undefined;
  };
  // Detach before teardown: reentrant native notifications cannot reuse a Session.
  const detachSession = () => {
    const services = ownedSession;
    ownedSession = undefined;
    return services;
  };
  const cleanupFailure = (services: typeof ownedSession): { error: unknown } | undefined => {
    try {
      services?.close();
    } catch (error) {
      return { error };
    }
  };
  const reportCleanupFailure = (cleanup: unknown, primary?: Error) => {
    const failures = primary ? [primary] : ([] as unknown[]);
    const append = (error: unknown) => {
      if (error instanceof AggregateError) for (const item of error.errors) append(item);
      else failures.push(error);
    };
    append(cleanup);
    notify('diagnostic', {
      stage: 'native-cleanup',
      cleanupFailures: failures.map((error) => {
        const serialized = serializeKernelError(error);
        return {
          message: serialized.message,
          ...(serialized.name !== undefined ? { name: serialized.name } : {}),
          ...(serialized.code !== undefined ? { code: serialized.code } : {}),
        };
      }),
    });
  };
  const fail = (error: Error) => {
    generation++;
    identity = undefined;
    requesting = false;
    clearTimers();
    const current = pending;
    pending = undefined;
    const failure = cleanupFailure(detachSession());
    const result = failure ? withCleanupFailure(error, failure.error) : error;
    current?.reject(result);
    if (failure) reportCleanupFailure(failure.error, error);
    notify('login-error', result);
  };
  const invoke = (object: NativeObject, method: string, ...args: unknown[]) => {
    if (typeof object[method] !== 'function') throw new Error(`Native kernel is missing ${method}`);
    return object[method](...args);
  };
  const noop = () => {};
  const transitionOffline = (details: Record<string, unknown>) => {
    if (closed) return;
    generation++;
    identity = undefined;
    requesting = false;
    const services = detachSession();
    clearTimers();
    const current = pending;
    pending = undefined;
    const original = new Error('Native account became offline');
    const failure = cleanupFailure(services);
    current?.reject(failure ? withCleanupFailure(original, failure.error) : original);
    if (failure) reportCleanupFailure(failure.error, original);
    const info = { ...details, retryable: false };
    notify('offline', info);
    notify('disconnected', info);
    return info;
  };
  const auditedNoop =
    (family: string, name: string) =>
    (...args: unknown[]) => {
      if (closed) return;
      // Audit shape only; never log native callback payloads or pretend to sign.
      notify('native-callback', {
        family,
        name,
        argumentTypes: args.map((value) =>
          value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
        ),
      });
    };
  const callbacks = (names: string[], overrides: NativeObject = {}, family = 'Session') =>
    new Proxy(
      Object.assign(
        Object.fromEntries(names.map((name) => [name, auditedNoop(family, name)])),
        overrides,
      ),
      { get: (target, key) => Reflect.get(target, key) ?? auditedNoop(family, String(key)) },
    );
  const startAccountSession = (account: AccountIdentity) => {
    if (closed || !pending || ownedSession) return;
    const attempt = generation;
    const expectedPending = pending;
    const session = accountSession!;
    const active = () => !closed && generation === attempt && accountSession === session;
    ownedSession = new AccountSessionLifecycle({
      session,
      account,
      options,
      machineGuid: () => invoke(loginService!, 'getMachineGuid'),
      startNative: () =>
        sessionStrategy === 'startup'
          ? invoke(startupSession!, 'start')
          : invoke(session, 'startNT', 0),
      isCurrent: active,
      isPending: () => pending === expectedPending,
      createServices: createNativeServices,
      depends: {
        onMSFStatusChange: (status: unknown, reason: unknown, ...extra: unknown[]) => {
          lastMsfStatus = { status, reason };
          notify('msf-status', { status, reason, args: [status, reason, ...extra] });
          if (status === 2) accountMsfConnected = true;
          // During Session startup the first disconnected/unknown snapshot is
          // not a transition from an established connection. Keep awaiting
          // native readiness or a definitive failure within the login deadline.
          if (
            status === 1 &&
            reason === 0 &&
            pending &&
            !identity &&
            !accountMsfConnected &&
            !forcedOffline
          ) {
            notify('diagnostic', { stage: 'session-initial-msf-disconnected' });
            return;
          }
          // 1=DISCONNECTED; reason2=USERLOGINOUT, reason3=AUTO. AUTO is
          // not a documented network-only reason and is never auto-restored.
          if (status === 1)
            transitionOffline({
              source: 'msf',
              kind: forcedOffline ? 'forced' : reason === 2 ? 'logout' : 'transport',
              status,
              reason,
              args: [status, reason, ...extra],
            });
        },
        onMSFSsoError: (code: unknown, description: unknown, ...extra: unknown[]) => {
          const details = {
            ...(typeof code === 'number' || typeof code === 'string' ? { code } : {}),
            ...(typeof description === 'string' ? { description } : {}),
            args: [code, description, ...extra],
          };
          notify('msf-error', details);
          transitionOffline({
            source: 'msf',
            kind: forcedOffline ? 'forced' : 'unknown',
            ...details,
          });
        },
      },
      emit: (event, payload) => {
        if (!active()) return;
        if (event === 'kicked') {
          forcedOffline = true;
          const kicked = payload as { info?: unknown; args?: unknown[] };
          const info = transitionOffline({
            source: 'kicked',
            kind: 'forced',
            kickedInfo: kicked.info,
            args: kicked.args ?? [],
          });
          if (info) notify('kicked', info);
          return;
        }
        notify(event, payload);
      },
      ready: (account) => {
        if (!active() || pending !== expectedPending) return;
        identity = { ...account };
        clearTimers();
        pending = undefined;
        expectedPending.resolve({ ...account });
        notify('login', { ...account });
        if (active()) notify('ready', { ...account });
      },
      failed: fail,
      cleanupFailed: (error) => reportCleanupFailure(error),
    });
    ownedSession.begin();
  };
  const beginAuthentication = async () => {
    if (closed || !pending || !loginService || requesting) return;
    const attempt = generation;
    const expectedPending = pending;
    const active = () => !closed && generation === attempt && pending === expectedPending;
    try {
      if (invoke(loginService, 'getMsfStatus') === 3) {
        poll = setTimeout(() => {
          void beginAuthentication();
        }, 500);
        return;
      }
      requesting = true;
      if (request.method === 'qr') {
        expectedPending.authenticationIssued = true;
        const accepted = invoke(loginService, 'getQRCodePicture');
        if (accepted === false) throw new Error('Native login service rejected QR request');
      } else {
        let uin = request.uin;
        if (request.method === 'restore') {
          const records = await invoke(loginService, 'getLoginList');
          if (!active()) return;
          if (process.env.QQ_NATIVE_TRACE_FIELDS === '1') {
            const local = Array.isArray(records?.LocalLoginInfoList)
              ? records.LocalLoginInfoList
              : [];
            notify('diagnostic', {
              stage: `restore-records:${JSON.stringify({
                topLevelKeys: records && typeof records === 'object' ? Object.keys(records) : [],
                localRecordCount: local.length,
                recordFieldNames: local.map((record: NativeObject) => Object.keys(record)),
                quickLoginFlagTypes: local.map(
                  (record: NativeObject) => typeof record.isQuickLogin,
                ),
                quickLoginFlags: local.map((record: NativeObject) =>
                  typeof record.isQuickLogin === 'boolean' ? record.isQuickLogin : null,
                ),
              })}`,
            });
          }
          const eligible = Array.isArray(records?.LocalLoginInfoList)
            ? records.LocalLoginInfoList.filter(
                (record: NativeObject) => record.isQuickLogin === true,
              )
            : [];
          if (uin) {
            if (!eligible.some((record: NativeObject) => nativeAccountNumber(record.uin) === uin)) {
              throw new Error('Requested account has no restorable login record');
            }
          } else {
            if (eligible.length !== 1)
              throw new Error(
                eligible.length === 0
                  ? 'No restorable login record'
                  : 'Multiple restorable accounts; specify uin',
              );
            uin = nativeAccountNumber(eligible[0].uin);
          }
          if (uin === undefined) throw new Error('Invalid restored account number');
        }
        expectedPending.targetUin = uin;
        expectedPending.authenticationIssued = true;
        const result = await invoke(loginService, 'quickLoginWithUin', uin);
        if (!active()) return;
        if (result?.result !== '0' || result?.loginErrorInfo?.errMsg) {
          throw new Error(
            result?.loginErrorInfo?.errMsg || `Quick login failed: ${result?.result}`,
          );
        }
      }
    } catch (error) {
      if (active()) fail(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const initialize = async () => {
    if (closed) throw new Error('Client is closed');
    if (initialized) return;
    const globalDir = join(options.dataDir, 'global');
    await mkdir(globalDir, { recursive: true });
    if (closed) throw new Error('Client is closed');
    const nativePlatform = { win32: 3, darwin: 4, linux: 5 }[
      platform() as 'win32' | 'darwin' | 'linux'
    ];
    if (!nativePlatform) throw new Error(`Unsupported platform: ${platform()}`);
    notify('diagnostic', { stage: 'engine-get' });
    const engine = invoke(wrapper.NodeIQQNTWrapperEngine ?? {}, 'get');
    notify('diagnostic', { stage: 'login-service-get' });
    loginService = invoke(wrapper.NodeIKernelLoginService ?? {}, 'get');
    notify('diagnostic', { stage: 'session-create' });
    const startupFactory = wrapper.NodeIQQNTStartupSessionWrapper;
    const accountFactory = wrapper.NodeIQQNTWrapperSession;
    // Choose from the exported surface before dispatching either factory.
    // A thrown native call may already have effects; never use it as a probe
    // for another signature or Session strategy.
    if (
      typeof startupFactory?.create === 'function' &&
      typeof accountFactory?.getNTWrapperSession === 'function'
    ) {
      sessionStrategy = 'startup';
      startupSession = invoke(startupFactory, 'create');
      accountSession = invoke(accountFactory, 'getNTWrapperSession', 'nt_1');
    } else if (typeof accountFactory?.create === 'function') {
      sessionStrategy = 'direct';
      accountSession = invoke(accountFactory, 'create');
    } else throw new Error('Native kernel has no supported Session creation surface');
    // Retain session instances; native login initialization may depend on them.
    void startupSession;
    void accountSession;
    const osVersion = options.device?.osVersion ?? release();
    const hostName = options.device?.hostname ?? hostname();
    const engineCallbacks = callbacks(
      [
        'onLog',
        'onGetSrvCalTime',
        'onShowErrUITips',
        'fixPicImgType',
        'getAppSetting',
        'onInstallFinished',
        'onUpdateGeneralFlag',
        'onGetOfflineMsg',
      ],
      {},
      'Global',
    );
    notify('diagnostic', { stage: 'engine-init' });
    invoke(
      engine,
      'initWithDeskTopConfig',
      {
        base_path_prefix: '',
        platform_type: nativePlatform,
        app_type: 4,
        app_version: options.version.clientVersion,
        os_version: osVersion,
        use_xlog: false,
        qua: options.version.qua,
        global_path_config: { desktopGlobalPath: globalDir },
        thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 },
      },
      new Proxy(engineCallbacks, { get: (target, key) => Reflect.get(target, key) ?? noop }),
    );
    notify('diagnostic', { stage: 'login-config' });
    invoke(loginService!, 'initConfig', {
      machineId: '',
      appid: options.version.appId,
      platVer: osVersion,
      commonPath: globalDir,
      clientVer: options.version.clientVersion,
      hostName,
      externalVersion: false,
    });
    if (options.rememberPassword !== undefined) {
      if (typeof options.rememberPassword !== 'boolean')
        throw new TypeError('rememberPassword must be boolean');
      invoke(loginService!, 'setRemerberPwd', options.rememberPassword);
    }
    listener = Object.fromEntries(
      [
        'onLoginConnected',
        'onLoginDisConnected',
        'onLoginConnecting',
        'onQRCodeGetPicture',
        'onQRCodeLoginPollingStarted',
        'onQRCodeSessionUserScaned',
        'onQRCodeLoginSucceed',
        'onQRCodeSessionFailed',
        'onLoginFailed',
        'onLogoutSucceed',
        'onLogoutFailed',
        'onUserLoggedIn',
        'onQRCodeSessionQuickLoginFailed',
        'onPasswordLoginFailed',
        'OnConfirmUnusualDeviceFailed',
        'onQQLoginNumLimited',
        'onLoginState',
        'onLoginRecordUpdate',
      ].map((name) => [name, auditedNoop('Login', name)]),
    );
    Object.assign(listener, {
      onLoginConnected: () => {
        void beginAuthentication();
      },
      onLoginDisConnected: (...args: unknown[]) => {
        transitionOffline({
          source: 'login',
          kind: forcedOffline ? 'forced' : 'unknown',
          args,
          ...(lastMsfStatus ?? {}),
        });
      },
      onQRCodeGetPicture: (data: { pngBase64QrcodeData: string; qrcodeUrl: string }) => {
        if (!pending) return;
        const image = Buffer.from(
          data.pngBase64QrcodeData.replace(/^data:image\/\w+;base64,/, ''),
          'base64',
        );
        notify('qrcode', { image, url: data.qrcodeUrl });
      },
      onQRCodeSessionUserScaned: () => notify('qr-scanned', undefined),
      onQRCodeLoginSucceed: (account: AccountIdentity) => {
        if (!pending) return;
        const authentication = pending;
        const attempt = generation;
        const uin = nativeAccountNumber(account?.uin);
        if (uin === undefined || typeof account?.uid !== 'string' || !account.uid.trim()) {
          fail(new Error('Invalid native login identity'));
          return;
        }
        if (!pending.authenticationIssued) {
          fail(new Error('Native authentication arrived before the login request was issued'));
          return;
        }
        if (
          pending.method !== 'qr' &&
          (pending.targetUin === undefined || uin !== pending.targetUin)
        ) {
          fail(new Error('Native login account does not match the requested account'));
          return;
        }
        const accountIdentity = { uid: account.uid, uin };
        notify('authenticated', { ...accountIdentity });
        if (closed || generation !== attempt || pending !== authentication) return;
        startAccountSession(accountIdentity);
      },
      onQRCodeSessionFailed: (type: number, code: number) =>
        fail(new Error(`QR login failed (${type}, ${code})`)),
      onLoginFailed: (...details: unknown[]) =>
        fail(new Error(`Native login failed: ${JSON.stringify(details)}`)),
      onUserLoggedIn: (uin: unknown) =>
        fail(new Error(`Account already logged in: ${String(uin)}`)),
      onLogoutSucceed: () => {
        generation++;
        clearTimers();
        identity = undefined;
        requesting = false;
        const current = pending;
        pending = undefined;
        const services = detachSession();
        const original = new Error('Native account logged out during login');
        const failure = cleanupFailure(services);
        current?.reject(failure ? withCleanupFailure(original, failure.error) : original);
        if (failure) reportCleanupFailure(failure.error, original);
        notify('logout', undefined);
      },
    });
    // Local NapCat returns a no-op for newly added callbacks. Preserve that behavior
    // while keeping a strong reference for native asynchronous callback delivery.
    listener = new Proxy(listener, {
      get: (target, key) => Reflect.get(target, key) ?? auditedNoop('Login', String(key)),
    });
    notify('diagnostic', { stage: 'login-listener' });
    invoke(loginService!, 'addKernelLoginListener', listener);
    initialized = true;
  };
  let preparation: Promise<void> | undefined;
  const prepare = () => (preparation ??= initialize());
  return {
    /** Initialize the local environment without connecting or authenticating. */
    prepare,
    async login(loginRequest: LoginRequest): Promise<AccountIdentity> {
      if (closed) throw new Error('Client is closed');
      loginRequest = normalizeLoginRequest(loginRequest);
      if (pending) throw new Error('Login is already in progress');
      if (identity) {
        if (
          loginRequest.method !== 'qr' &&
          loginRequest.uin !== undefined &&
          loginRequest.uin !== identity.uin
        )
          throw new Error('Another account is already logged in');
        return { ...identity };
      }
      const attempt = ++generation;
      forcedOffline = false;
      lastMsfStatus = undefined;
      accountMsfConnected = false;
      request = loginRequest;
      requesting = false;
      const result = new Promise<AccountIdentity>((resolve, reject) => {
        pending = { method: loginRequest.method, authenticationIssued: false, resolve, reject };
      });
      // Attach rejection handling immediately while asynchronous setup runs.
      void result.catch(() => {});
      timeout = setTimeout(
        () => fail(new Error('Login timed out')),
        options.loginTimeoutMs ?? 120_000,
      );
      try {
        await prepare();
        if (pending && !closed && generation === attempt) {
          notify('diagnostic', { stage: 'login-connect' });
          invoke(loginService!, 'connect');
        }
      } catch (error) {
        if (generation === attempt) fail(error instanceof Error ? error : new Error(String(error)));
      }
      return result;
    },
    async invokeOperation(
      method: ServiceOperation,
      payload: Record<string, unknown> = {},
    ): Promise<unknown> {
      if (closed) throw new Error('Client is closed');
      if (!identity || !ownedSession) throw new Error('Client is not online');
      return ownedSession.invokeOperation(method, payload);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      generation++;
      const services = detachSession();
      identity = undefined;
      requesting = false;
      clearTimers();
      pending?.reject(new Error('Client closed during login'));
      pending = undefined;
      services?.close();
      // No native teardown contract has been verified. Owning Node worker exit
      // is required to release native singleton state and its threads.
    },
  };
}
