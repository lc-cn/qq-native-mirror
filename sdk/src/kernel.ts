import { normalizeKernelError, serializeKernelError } from './errors.ts';
import { withCleanupFailure } from './runtime/cleanup.ts';
import { createNativeServices, type ServiceOperation } from './native-services.ts';
import { normalizeLoginRequest } from './native/login-request.ts';
import type { LoginRequest } from './contracts/client.ts';
import { AccountSessionLifecycle } from './runtime/account-session-lifecycle.ts';
import type {
  AccountIdentity,
  AccountSessionOptions,
} from './runtime/account-session-lifecycle.ts';
import { createKernelEnvironment } from './runtime/kernel-environment.ts';
import { AuthenticationAttempt } from './runtime/authentication-attempt.ts';

// QQ exports are proprietary and versioned; this boundary intentionally validates
// the required methods at runtime rather than asserting a stable upstream API.
import type { NativeObject } from './native/native-object.ts';
export interface KernelOptions extends AccountSessionOptions {
  loginTimeoutMs?: number;
  rememberPassword?: boolean;
}
export type { LoginRequest } from './contracts/client.ts';
export type { AccountIdentity } from './runtime/account-session-lifecycle.ts';

export function createKernel(
  wrapper: NativeObject,
  options: KernelOptions,
  emit: (event: string, payload: unknown) => void,
) {
  let loginService: NativeObject | undefined;
  let startupSession: NativeObject | undefined;
  let accountSession: NativeObject | undefined;
  let sessionStrategy: 'startup' | 'direct' | undefined;
  let identity: AccountIdentity | undefined;
  let ownedSession: AccountSessionLifecycle | undefined;
  let forcedOffline = false;
  let lastMsfStatus: { status: unknown; reason: unknown } | undefined;
  let accountMsfConnected = false;
  let closed = false;
  let generation = 0;
  let pending: AuthenticationAttempt | undefined;
  const notify = (event: string, payload: unknown) => {
    if (!closed) emit(event, payload);
  };
  const invalidateAttempt = () => pending?.invalidate();
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
    invalidateAttempt();
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
  const transitionOffline = (details: Record<string, unknown>) => {
    if (closed) return;
    generation++;
    identity = undefined;
    const services = detachSession();
    invalidateAttempt();
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
        invalidateAttempt();
        pending = undefined;
        expectedPending.completeReady(account);
        notify('login', { ...account });
        if (active()) notify('ready', { ...account });
      },
      failed: fail,
      cleanupFailed: (error) => reportCleanupFailure(error),
    });
    ownedSession.begin();
  };
  const environment = createKernelEnvironment({
    wrapper,
    options,
    isClosed: () => closed,
    diagnostic: (payload) => notify('diagnostic', payload),
    onAcquired: (value) => {
      ({ loginService, accountSession, startupSession, sessionStrategy } = value);
    },
    engineCallbacks: () => {
      return callbacks(
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
    },
    loginCallbacks: () => {
      const listener = Object.fromEntries(
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
          void pending?.onConnected();
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
          let accountIdentity: AccountIdentity;
          try {
            accountIdentity = authentication.acceptAuthentication(account);
          } catch (error) {
            fail(normalizeKernelError(error));
            return;
          }
          notify('authenticated', { ...accountIdentity });
          if (closed || generation !== attempt || pending !== authentication) return;
          startAccountSession(accountIdentity);
        },
        onQRCodeSessionFailed: (type: number, code: number) =>
          fail(new Error(`QR login failed (${type}, ${code})`)),
        onLoginFailed: () => fail(new Error('Native login failed')),
        onUserLoggedIn: (uin: unknown) =>
          fail(new Error(`Account already logged in: ${String(uin)}`)),
        onLogoutSucceed: () => {
          generation++;
          invalidateAttempt();
          identity = undefined;
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
      return new Proxy(listener, {
        get: (target, key) => Reflect.get(target, key) ?? auditedNoop('Login', String(key)),
      });
    },
  });
  const prepare = environment.prepare;
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
      const authentication: AuthenticationAttempt = new AuthenticationAttempt({
        request: loginRequest,
        timeoutMs: options.loginTimeoutMs ?? 120_000,
        prepare,
        loginService: () => loginService,
        isCurrent: (): boolean => !closed && generation === attempt && pending === authentication,
        notify,
        failed: fail,
      });
      pending = authentication;
      await authentication.begin();
      const result = authentication.result;
      return result;
    },
    async invokeOperation(
      method: ServiceOperation,
      payload: Record<string, unknown> = {},
      signal?: AbortSignal,
    ): Promise<unknown> {
      if (closed) throw new Error('Client is closed');
      if (!identity || !ownedSession) throw new Error('Client is not online');
      return ownedSession.invokeOperation(method, payload, signal);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      generation++;
      const services = detachSession();
      identity = undefined;
      invalidateAttempt();
      pending?.reject(new Error('Client closed during login'));
      pending = undefined;
      services?.close();
      // No native teardown contract has been verified. Owning Node worker exit
      // is required to release native singleton state and its threads.
    },
  };
}
