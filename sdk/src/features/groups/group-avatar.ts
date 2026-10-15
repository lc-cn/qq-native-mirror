import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { nativeResultError } from '../../errors.ts';
import { FeatureLifetime } from '../../runtime/feature-lifetime.ts';
import { captureSetGroupAvatar } from './group-avatar-input.ts';

export interface GroupAvatarPort {
  setHeader?: (groupId: string, file: string) => unknown;
}

export interface GroupAvatarContext {
  readonly signal: AbortSignal;
  readonly awaitAlive: <T>(value: T | PromiseLike<T>, requestSignal?: AbortSignal) => Promise<T>;
  /** Composition binds this decision to the worker's measured binary profile. */
  supportsSetting(): boolean;
  getGroupService(): GroupAvatarPort | null | undefined;
}

/** Read normal ACK fields without running accessors or exposing trap errors.
 * A trap may retire the owner, so retirement takes precedence over parsing.
 */
function resultField(lifetime: FeatureLifetime, value: unknown, key: string): unknown {
  lifetime.assertOpen();
  let selected: unknown;
  try {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && 'value' in descriptor) selected = descriptor.value;
    }
  } catch {
    // Invalid carriers use one fixed public error, never native trap wording.
  }
  lifetime.assertOpen();
  return selected;
}

function acknowledge(lifetime: FeatureLifetime, value: unknown): void {
  const code = resultField(lifetime, value, 'result');
  if (
    typeof code !== 'number' ||
    !Number.isInteger(code) ||
    code < -0x80000000 ||
    code > 0x7fffffff ||
    typeof resultField(lifetime, value, 'errMsg') !== 'string'
  )
    throw nativeResultError('Invalid native group avatar result', undefined);
  if (code !== 0) throw nativeResultError('Native group avatar setting failed', { result: code });
}

/** Own one avatar submission, from measured support through local preflight and
 * native acknowledgement. Path checks do not pin bytes; callers keep files stable.
 * Native work already issued is observed on retirement and is never retried.
 */
export function createGroupAvatar(context: GroupAvatarContext) {
  const lifetime = new FeatureLifetime({
    signal: context.signal,
    awaitAlive: context.awaitAlive,
    closedMessage: 'Group avatar service is closed',
  });
  return {
    close(): void {
      lifetime.close();
    },
    async setGroupAvatar(groupId: unknown, file: unknown): Promise<void> {
      const captured = lifetime.inspect(() => captureSetGroupAvatar(groupId, file));
      if (!lifetime.inspect(() => context.supportsSetting()))
        throw Object.assign(
          new Error('Group avatar setting contract is not verified for this native binary'),
          { code: 'unsupported-native-contract' },
        );

      try {
        const info = await lifetime.wait(stat(captured.file));
        lifetime.assertOpen();
        if (!info.isFile() || info.size <= 0) throw new Error('Invalid group avatar file');
        await lifetime.wait(access(captured.file, constants.R_OK));
      } catch {
        lifetime.assertOpen();
        throw new Error('Group avatar file must be a readable nonempty regular file');
      }

      const service = lifetime.inspect(() => context.getGroupService());
      const method = lifetime.inspect(() => service?.setHeader);
      if (typeof method !== 'function')
        throw new Error('Native Group service is missing setHeader');
      let pending: unknown;
      try {
        pending = Reflect.apply(method, service, [captured.groupId, captured.file]);
      } catch (error) {
        lifetime.assertOpen();
        throw error;
      }
      let timer!: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Native group avatar setting timed out; remote effect unknown')),
          5000,
        );
      });
      try {
        // Race inside the lifetime wait so timeout releases this call's account
        // listeners. Already issued native work stays observed, even after close.
        const result = await lifetime.wait(Promise.race([pending, deadline]));
        acknowledge(lifetime, result);
        lifetime.assertOpen();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
