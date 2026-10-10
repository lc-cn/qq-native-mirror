import { normalizeKernelError } from '../errors.ts';
import type { LoginRequest } from '../contracts/client.ts';
import type { AccountIdentity } from './account-session-lifecycle.ts';
import type { NativeObject } from '../native/native-object.ts';

/** Narrow authentication port; native results remain untrusted at this boundary. */
export interface AuthenticationLoginPort {
  connect?(): unknown;
  getMsfStatus?(): unknown;
  getQRCodePicture?(): unknown;
  getLoginList?(): unknown;
  quickLoginWithUin?(uin: string | undefined): unknown;
}

export interface AuthenticationAttemptContext {
  request: LoginRequest;
  timeoutMs: number;
  prepare(): Promise<void>;
  loginService(): AuthenticationLoginPort | undefined;
  isCurrent(): boolean;
  notify(event: string, payload: unknown): void;
  failed(error: Error): void;
}
function nativeAccountNumber(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

/** Own one authentication request until account Session readiness settles it.
 * Invalidation stops work before the account owner performs teardown; rejection
 * is settled by Kernel, which preserves each teardown path’s error contract.
 */
export class AuthenticationAttempt {
  #context: AuthenticationAttemptContext;
  #request: LoginRequest;
  #requesting = false;
  #authenticationIssued = false;
  #targetUin: string | undefined;
  #invalidated = false;
  #timeout: ReturnType<typeof setTimeout> | undefined;
  #poll: ReturnType<typeof setTimeout> | undefined;
  #resolve!: (value: AccountIdentity) => void;
  #reject!: (error: Error) => void;
  readonly result: Promise<AccountIdentity>;

  constructor(context: AuthenticationAttemptContext) {
    this.#context = context;
    this.#request = context.request;
    this.result = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    void this.result.catch(() => {});
    this.#timeout = setTimeout(
      () => context.failed(new Error('Login timed out')),
      context.timeoutMs,
    );
  }
  #active() {
    return !this.#invalidated && this.#context.isCurrent();
  }
  #invoke(method: keyof AuthenticationLoginPort, ...args: [string | undefined] | []) {
    const service = this.#context.loginService();
    if (typeof service?.[method] !== 'function')
      throw new Error(`Native kernel is missing ${method}`);
    return Reflect.apply(service[method], service, args) as unknown;
  }
  async begin(): Promise<void> {
    try {
      await this.#context.prepare();
      if (this.#active()) {
        this.#context.notify('diagnostic', { stage: 'login-connect' });
        if (this.#active()) this.#invoke('connect');
      }
    } catch (error) {
      if (this.#active()) this.#context.failed(normalizeKernelError(error));
    }
  }
  async onConnected(): Promise<void> {
    if (!this.#active() || !this.#context.loginService() || this.#requesting) return;
    try {
      const status = this.#invoke('getMsfStatus');
      if (!this.#active()) return;
      if (status === 3) {
        clearTimeout(this.#poll);
        this.#poll = setTimeout(() => {
          void this.onConnected();
        }, 500);
        return;
      }
      clearTimeout(this.#poll);
      this.#poll = undefined;
      this.#requesting = true;
      if (this.#request.method === 'qr') {
        this.#authenticationIssued = true;
        const accepted = this.#invoke('getQRCodePicture');
        if (accepted === false) throw new Error('Native login service rejected QR request');
      } else {
        let uin = this.#request.uin;
        if (this.#request.method === 'restore') {
          // The dynamic native adapter is confined here; preserve native field access
          // and trace behavior while keeping the injected port result unknown.
          const records = (await this.#invoke('getLoginList')) as NativeObject;
          if (!this.#active()) return;
          if (process.env.QQ_NATIVE_TRACE_FIELDS === '1') {
            const local = Array.isArray(records?.LocalLoginInfoList)
              ? records.LocalLoginInfoList
              : [];
            this.#context.notify('diagnostic', {
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
          if (!this.#active()) return;
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
        this.#targetUin = uin;
        this.#authenticationIssued = true;
        const result = (await this.#invoke('quickLoginWithUin', uin)) as NativeObject;
        if (!this.#active()) return;
        if (result?.result !== '0' || result?.loginErrorInfo?.errMsg) {
          throw new Error(
            result?.loginErrorInfo?.errMsg || `Quick login failed: ${result?.result}`,
          );
        }
      }
    } catch (error) {
      if (this.#active()) this.#context.failed(normalizeKernelError(error));
    }
  }
  acceptAuthentication(value: unknown): AccountIdentity {
    const account = value as NativeObject;
    const uin = nativeAccountNumber(account?.uin);
    if (uin === undefined || typeof account?.uid !== 'string' || !account.uid.trim())
      throw new Error('Invalid native login identity');
    if (!this.#authenticationIssued)
      throw new Error('Native authentication arrived before the login request was issued');
    if (this.#request.method !== 'qr' && (this.#targetUin === undefined || uin !== this.#targetUin))
      throw new Error('Native login account does not match the requested account');
    return { uid: account.uid, uin };
  }
  invalidate(): void {
    this.#invalidated = true;
    clearTimeout(this.#timeout);
    clearTimeout(this.#poll);
    this.#timeout = this.#poll = undefined;
  }
  reject(error: Error): void {
    this.invalidate();
    this.#reject(error);
  }
  completeReady(account: AccountIdentity): void {
    this.invalidate();
    this.#resolve({ ...account });
  }
}
