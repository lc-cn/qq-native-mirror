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
 * Each callback slot captures its override once; cached acquisition performs no
 * further override getter evaluation. Ordinary non-function metadata remains
 * uncached; locked data properties retain the Proxy target's exact value.
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
        const cached = wrapped.get(key);
        if (cached) {
          // Proxy invariants require the target's exact value after a captured
          // slot becomes locked metadata. Descriptor inspection invokes no getter.
          const descriptor = Object.getOwnPropertyDescriptor(object, key);
          if (
            descriptor &&
            !descriptor.configurable &&
            'value' in descriptor &&
            !descriptor.writable &&
            typeof descriptor.value !== 'function'
          )
            return descriptor.value;
          return cached;
        }
        const member = object[key as string];
        if (member !== undefined && typeof member !== 'function') return member;
        const callback = (...args: unknown[]) => {
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
        };
        wrapped.set(key, callback);
        return callback;
      },
    });
    if (retainBeforeAdd) this.#references.push(target);
    add(target);
    if (!retainBeforeAdd) this.#references.push(target);
  }
}
