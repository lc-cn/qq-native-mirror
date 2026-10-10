import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname, platform, release, type } from 'node:os';
import type { NativeObject } from '../native/native-object.ts';
import type { NativeContractProfile } from '../native/native-contracts.ts';
import type { NativeServiceContext } from './native-service-context.ts';
import type { ServiceOperation } from './operations.ts';
import type { MediaTools, RecordCodec, VideoCodec } from './media-contracts.ts';

export interface AccountIdentity {
  uin: string;
  uid: string;
}

export interface AccountSessionOptions {
  dataDir: string;
  version: { clientVersion: string; appId: string; qua: string };
  device?: { hostname?: string; osVersion?: string };
  mediaTools?: MediaTools;
  recordCodec?: RecordCodec;
  videoCodec?: VideoCodec;
  nativeContracts?: NativeContractProfile;
}

/** The native business adapter varies between the actual Session composition and
 * controlled tests. The Session owner never imports or constructs that adapter.
 */
export interface AccountSessionServices {
  invokeOperation(method: ServiceOperation, payload: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export interface AccountSessionContext {
  readonly session: NativeObject;
  readonly account: AccountIdentity;
  readonly options: AccountSessionOptions;
  readonly machineGuid: () => unknown;
  /** Already selected strategy; an invocation failure must never trigger fallback. */
  readonly startNative: () => unknown;
  readonly isCurrent: () => boolean;
  readonly isPending: () => boolean;
  readonly depends: NativeObject;
  readonly createServices: (context: NativeServiceContext) => AccountSessionServices;
  readonly emit: (event: string, payload: unknown) => void;
  readonly ready: (account: AccountIdentity) => void;
  readonly failed: (error: Error) => void;
  readonly cleanupFailed: (error: unknown) => void;
}

/** Owns one authenticated account's Session startup and business adapter.
 * Native readiness and successful start completion are independent gates. The
 * owner scopes all retained callbacks, detaches services before teardown, and
 * observes startup rejection even after cancellation. No native call is replayed.
 */
export class AccountSessionLifecycle {
  readonly #context: AccountSessionContext;
  readonly #account: AccountIdentity;
  #services: AccountSessionServices | undefined;
  #sessionCallbacks: NativeObject | undefined;
  #closed = false;
  #begun = false;
  #nativeReady = false;
  #startReturned = false;
  #completing = false;
  #completed = false;

  constructor(context: AccountSessionContext) {
    this.#context = context;
    this.#account = { ...context.account };
  }

  #active(): boolean {
    return !this.#closed && this.#context.isCurrent();
  }

  #pending(): boolean {
    return this.#active() && this.#context.isPending();
  }

  #invoke(method: string, ...args: unknown[]): unknown {
    const session = this.#context.session;
    if (typeof session[method] !== 'function')
      throw new Error(`Native kernel is missing ${method}`);
    return session[method](...args);
  }

  #callbacks(names: string[], overrides: NativeObject = {}, family = 'Session'): NativeObject {
    const audit =
      (name: string) =>
      (...args: unknown[]) => {
        if (!this.#active()) return;
        // Only callback shape crosses the audit seam; payloads may contain tickets.
        this.#context.emit('native-callback', {
          family,
          name,
          argumentTypes: args.map((value) =>
            value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
          ),
        });
      };
    const adapter = Object.assign(
      Object.fromEntries(names.map((name) => [name, audit(name)])),
      overrides,
    );
    return new Proxy(adapter, {
      get: (target, key) => {
        const callback = Reflect.get(target, key) ?? audit(String(key));
        return typeof callback === 'function'
          ? (...args: unknown[]) => {
              if (this.#active()) return callback(...args);
            }
          : callback;
      },
    });
  }

  /** Dispatch once. Completion is delivered through ready/failed, never inferred
   * from begin returning or a readiness callback preceding native start return.
   */
  begin(): void {
    if (this.#begun || !this.#pending()) return;
    this.#begun = true;
    void this.#start();
  }

  #complete(): void {
    if (
      !this.#nativeReady ||
      !this.#startReturned ||
      !this.#pending() ||
      this.#completing ||
      this.#completed
    )
      return;
    this.#completing = true;
    try {
      const options = this.#context.options;
      // Keep dependency reads in the original evaluation order.
      const version = options.version.clientVersion;
      const tools = options.mediaTools;
      const recordCodec = options.recordCodec;
      const userId = this.#account.uin;
      const uid = this.#account.uid;
      const videoCodec = options.videoCodec;
      const binaryProfile = options.nativeContracts;
      const services = this.#context.createServices({
        session: this.#context.session,
        version,
        events: {
          emit: (event, payload) => {
            if (this.#active()) this.#context.emit(event, payload);
          },
        },
        media: { tools, recordCodec, videoCodec },
        identity: { userId, uid },
        auditCallback: (info) => {
          if (this.#active()) this.#context.emit('native-callback', info);
        },
        binaryProfile,
      });
      if (!this.#pending()) {
        // Construction may synchronously close the owner before returning its
        // adapter. Release that late acquisition rather than resurrecting it.
        try {
          services.close();
        } catch (error) {
          this.#context.cleanupFailed(error);
        }
        return;
      }
      this.#services = services;
      this.#completed = true;
    } catch (error) {
      this.#context.failed(error instanceof Error ? error : new Error(String(error)));
      return;
    } finally {
      this.#completing = false;
    }
    this.#context.ready({ ...this.#account });
  }

  async #start(): Promise<void> {
    try {
      const rawGuid = String(this.#context.machineGuid());
      if (!/^[a-fA-F0-9]{32}$/.test(rawGuid) && !/^[a-fA-F0-9-]{36}$/.test(rawGuid))
        throw new Error('Invalid native machine GUID');
      const guid =
        rawGuid.length === 32
          ? `${rawGuid.slice(0, 8)}-${rawGuid.slice(8, 12)}-${rawGuid.slice(12, 16)}-${rawGuid.slice(16, 20)}-${rawGuid.slice(20)}`
          : rawGuid;
      const downloadsDir = join(this.#context.options.dataDir, 'downloads');
      await mkdir(downloadsDir, { recursive: true });
      if (!this.#pending()) return;
      const nativePlatform = { win32: 3, darwin: 4, linux: 5 }[
        platform() as 'win32' | 'darwin' | 'linux'
      ];
      const osVersion = this.#context.options.device?.osVersion ?? release();
      const hostName = this.#context.options.device?.hostname ?? hostname();
      this.#sessionCallbacks = this.#callbacks(
        [
          'onNTSessionCreate',
          'onGProSessionCreate',
          'onSessionInitComplete',
          'onOpentelemetryInit',
          'onUserOnlineResult',
          'onGetSelfTinyId',
        ],
        {
          onOpentelemetryInit: (result: { is_init: boolean }) => {
            if (!this.#pending()) return;
            if (!result?.is_init) {
              this.#context.failed(new Error('Native account session initialization failed'));
              return;
            }
            this.#nativeReady = true;
            this.#complete();
          },
        },
      );
      this.#invoke(
        'init',
        {
          selfUin: this.#account.uin,
          selfUid: this.#account.uid,
          desktopPathConfig: { account_path: this.#context.options.dataDir },
          clientVer: this.#context.options.version.clientVersion,
          a2: '',
          d2: '',
          d2Key: '',
          machineId: '',
          platform: nativePlatform,
          platVer: osVersion,
          appid: this.#context.options.version.appId,
          rdeliveryConfig: {
            appKey: '',
            systemId: 0,
            appId: '',
            logicEnvironment: '',
            platform: nativePlatform,
            language: '',
            sdkVersion: '',
            userId: '',
            appVersion: '',
            osVersion: '',
            bundleId: '',
            serverUrl: '',
            fixedAfterHitKeys: [''],
          },
          defaultFileDownloadPath: downloadsDir,
          deviceInfo: {
            guid,
            buildVer: this.#context.options.version.clientVersion,
            localId: 2052,
            devName: hostName,
            devType: type(),
            vendorName: '',
            osVer: osVersion,
            vendorOsName: type(),
            setMute: false,
            vendorType: 0,
          },
          deviceConfig: '{"appearance":{"isSplitViewMode":true},"msg":{}}',
        },
        this.#callbacks(
          ['onMSFStatusChange', 'onMSFSsoError', 'getGroupCode'],
          this.#context.depends,
          'Depends',
        ),
        this.#callbacks(
          ['dispatchRequest', 'dispatchCall', 'dispatchCallWithJson'],
          {},
          'Dispatcher',
        ),
        this.#sessionCallbacks,
      );
      if (!this.#pending()) return;
      await this.#context.startNative();
      if (!this.#pending()) return;
      this.#startReturned = true;
      this.#complete();
    } catch (error) {
      if (this.#active())
        this.#context.failed(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async invokeOperation(
    method: ServiceOperation,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.#active() || !this.#services) throw new Error('Client is not online');
    return this.#services.invokeOperation(method, payload);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const services = this.#services;
    this.#services = undefined;
    this.#sessionCallbacks = undefined;
    // Owning worker exit still releases native singleton threads. There is no
    // verified proprietary Session destructor to invoke here.
    services?.close();
  }
}
