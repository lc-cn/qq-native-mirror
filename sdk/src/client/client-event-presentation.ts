import type { NativeCallbackAudit } from '../contracts/native.ts';

/** A property view for the existing worker event presentation. These fields are
 * checked where interpreted; the original opaque payload is still forwarded.
 * This is not validation of a native event or a business result.
 */
interface EventFields {
  family?: unknown;
  name?: unknown;
  argumentTypes?: unknown;
  message?: unknown;
  image?: unknown;
  peer?: { type?: unknown };
}

/** Present worker events and retain a bounded shape-only callback audit for one
 * public client, across worker generations. Lifecycle owns generation filtering.
 * Delivery is synchronous: observer failures propagate and prevent later aliases.
 */
export function createClientEventPresentation(
  emit: (event: string, payload: unknown) => unknown,
  presentMessage: (message: unknown) => unknown = (message) => message,
) {
  const audit = new Map<string, NativeCallbackAudit>();
  return {
    forward(event: string, value: unknown): void {
      const fields = value as EventFields | null | undefined;
      if (event === 'native-callback') {
        const { family, name, argumentTypes } = fields ?? {};
        if (
          typeof family === 'string' &&
          typeof name === 'string' &&
          Array.isArray(argumentTypes) &&
          argumentTypes.every((value) => typeof value === 'string')
        ) {
          const key = JSON.stringify([family, name, argumentTypes]);
          const existing = audit.get(key);
          if (existing) existing.count++;
          else if (audit.size < 128)
            audit.set(key, { family, name, argumentTypes: [...argumentTypes], count: 1 });
        }
      }
      const payload =
        event === 'login-error'
          ? new Error(typeof fields?.message === 'string' ? fields.message : 'Native login failed')
          : event === 'message'
            ? presentMessage(value)
            : value;
      if (event === 'qrcode' && fields && typeof fields.image === 'string')
        fields.image = Buffer.from(fields.image, 'base64');
      emit(event, payload);
      if (event === 'message')
        emit(
          (payload as EventFields | null | undefined)?.peer?.type === 'group'
            ? 'message.group'
            : 'message.private',
          payload,
        );
    },
    /** Independent snapshots contain shapes and counts, never callback arguments. */
    get audit(): NativeCallbackAudit[] {
      return [...audit.values()].map((value) => ({
        ...value,
        argumentTypes: [...value.argumentTypes],
      }));
    },
  };
}
