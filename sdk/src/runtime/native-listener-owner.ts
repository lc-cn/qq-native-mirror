import type { NativeObject } from '../native/native-object.ts';
import type { NativeCallbackAudit } from '../contracts/native.ts';

export interface NativeListenerContext {
  isClosed(): boolean;
  auditCallback?(info: Pick<NativeCallbackAudit, 'family' | 'name' | 'argumentTypes'>): void;
  dispatch(channel: string, args: unknown[]): unknown;
}

export interface NativeListenerRegistration {
  family: string;
  overrides: NativeObject;
  add(listener: NativeObject): unknown;
  retainBeforeAdd?: boolean;
}

/** Owns callback wrappers and their strong references for the worker lifetime.
 * No listener removal ABI is assumed. Registration and audit exceptions retain
 * their original identity; registration is never retried.
 */
export class NativeListenerOwner {
  readonly #context: NativeListenerContext;
  readonly #references: NativeObject[] = [];

  constructor(context: NativeListenerContext) {
    this.#context = context;
  }

  register({ family, overrides, add, retainBeforeAdd = false }: NativeListenerRegistration): void {
    const wrapped = new Map<PropertyKey, (...args: unknown[]) => unknown>();
    const target = new Proxy(overrides, {
      get: (object, key) => {
        const member = object[key as string];
        if (member !== undefined && typeof member !== 'function') return member;
        if (!wrapped.has(key))
          wrapped.set(key, (...args: unknown[]) => {
            if (this.#context.isClosed()) return;
            const auditCallback = this.#context.auditCallback;
            auditCallback?.({
              family,
              name: String(key),
              argumentTypes: args.map((value) =>
                value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
              ),
            });
            if (typeof member === 'function') return Reflect.apply(member, object, args);
            const dispatch = this.#context.dispatch;
            return dispatch(`${family}/${String(key)}`, args);
          });
        return wrapped.get(key);
      },
    });
    if (retainBeforeAdd) this.#references.push(target);
    add(target);
    if (!retainBeforeAdd) this.#references.push(target);
  }
}
