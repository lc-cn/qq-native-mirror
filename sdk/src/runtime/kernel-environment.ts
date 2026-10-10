import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname, platform, release } from 'node:os';
import type { NativeObject } from '../native/native-object.ts';
import type { AccountSessionOptions } from './account-session-lifecycle.ts';

export interface KernelEnvironment {
  loginService: NativeObject;
  accountSession: NativeObject;
  startupSession?: NativeObject;
  sessionStrategy: 'startup' | 'direct';
}
export interface KernelEnvironmentContext {
  wrapper: NativeObject;
  options: AccountSessionOptions & { rememberPassword?: boolean };
  isClosed(): boolean;
  diagnostic(payload: { stage: string }): void;
  engineCallbacks(): NativeObject;
  loginCallbacks(): NativeObject;
  onAcquired(environment: KernelEnvironment): void;
}
/** Own local preparation and strong native references without connecting or authenticating. */
class KernelEnvironmentPreparation {
  #context: KernelEnvironmentContext;
  #preparation: Promise<void> | undefined;
  #references = new Set<NativeObject>();

  constructor(context: KernelEnvironmentContext) {
    this.#context = context;
  }

  prepare = (): Promise<void> => (this.#preparation ??= this.#initialize());

  async #initialize(): Promise<void> {
    const context = this.#context;
    let accountSession: NativeObject | undefined;
    let startupSession: NativeObject | undefined;
    let sessionStrategy: KernelEnvironment['sessionStrategy'] | undefined;
    const diagnostic = context.diagnostic;
    const noop = () => {};
    const invoke = (object: NativeObject, method: string, ...args: unknown[]) => {
      if (typeof object[method] !== 'function')
        throw new Error(`Native kernel is missing ${method}`);
      return object[method](...args);
    };
    if (context.isClosed()) throw new Error('Client is closed');
    const globalDir = join(context.options.dataDir, 'global');
    await mkdir(globalDir, { recursive: true });
    if (context.isClosed()) throw new Error('Client is closed');
    const nativePlatform = { win32: 3, darwin: 4, linux: 5 }[
      platform() as 'win32' | 'darwin' | 'linux'
    ];
    if (!nativePlatform) throw new Error(`Unsupported platform: ${platform()}`);
    diagnostic({ stage: 'engine-get' });
    const engine = invoke(context.wrapper.NodeIQQNTWrapperEngine ?? {}, 'get');
    diagnostic({ stage: 'login-service-get' });
    const loginService: NativeObject = invoke(context.wrapper.NodeIKernelLoginService ?? {}, 'get');
    diagnostic({ stage: 'session-create' });
    const startupFactory = context.wrapper.NodeIQQNTStartupSessionWrapper;
    const accountFactory = context.wrapper.NodeIQQNTWrapperSession;
    // Choose from the exported surface before dispatching either factory.
    // A thrown native call may already have effects; never use it as a probe
    // for another signature or Session strategy.
    if (
      typeof startupFactory?.create === 'function' &&
      typeof accountFactory?.getNTWrapperSession === 'function'
    ) {
      sessionStrategy = 'startup';
      startupSession = invoke(startupFactory, 'create');
      this.#references.add(startupSession!);
      accountSession = invoke(accountFactory, 'getNTWrapperSession', 'nt_1');
    } else if (typeof accountFactory?.create === 'function') {
      sessionStrategy = 'direct';
      accountSession = invoke(accountFactory, 'create');
    } else throw new Error('Native kernel has no supported Session creation surface');
    context.onAcquired({
      loginService: loginService!,
      accountSession: accountSession!,
      startupSession,
      sessionStrategy: sessionStrategy!,
    });
    // Retain session instances; native login initialization may depend on them.
    if (startupSession) this.#references.add(startupSession);
    this.#references.add(accountSession!);
    const osVersion = context.options.device?.osVersion ?? release();
    const hostName = context.options.device?.hostname ?? hostname();
    const engineCallbacks = context.engineCallbacks();
    diagnostic({ stage: 'engine-init' });
    invoke(
      engine,
      'initWithDeskTopConfig',
      {
        base_path_prefix: '',
        platform_type: nativePlatform,
        app_type: 4,
        app_version: context.options.version.clientVersion,
        os_version: osVersion,
        use_xlog: false,
        qua: context.options.version.qua,
        global_path_config: { desktopGlobalPath: globalDir },
        thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 },
      },
      new Proxy(engineCallbacks, { get: (target, key) => Reflect.get(target, key) ?? noop }),
    );
    diagnostic({ stage: 'login-config' });
    invoke(loginService!, 'initConfig', {
      machineId: '',
      appid: context.options.version.appId,
      platVer: osVersion,
      commonPath: globalDir,
      clientVer: context.options.version.clientVersion,
      hostName,
      externalVersion: false,
    });
    if (context.options.rememberPassword !== undefined) {
      if (typeof context.options.rememberPassword !== 'boolean')
        throw new TypeError('rememberPassword must be boolean');
      invoke(loginService!, 'setRemerberPwd', context.options.rememberPassword);
    }
    const listener = context.loginCallbacks();
    this.#references.add(listener);
    diagnostic({ stage: 'login-listener' });
    invoke(loginService!, 'addKernelLoginListener', listener);
  }
}

export function createKernelEnvironment(context: KernelEnvironmentContext) {
  return new KernelEnvironmentPreparation(context);
}
