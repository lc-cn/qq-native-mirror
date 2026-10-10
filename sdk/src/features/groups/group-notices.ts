import { nativeResultError } from '../../errors.ts';
/** Fixed NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/group.ts#L400-L403
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/group.ts#L522-L525
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/group.ts#L570-L584
 * apis/user.ts150-151: TipOffService.getPskey(domainList,true).
 * No list implementation: native bulletin result/listener fields remain unknown;
 * pinned OneBot GetGroupNotice uses WebApi rather than these native callbacks.
 */
import { isAbsolute } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import type { NativeObject as Native } from '../../native/native-object.ts';
export type GroupNoticeOperation = 'publishGroupNotice' | 'deleteGroupNotice';
export interface GroupNoticePublishOptions {
  imagePath?: string;
  pinned?: boolean;
  confirmRequired?: boolean;
}
function groupId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new Error('groupId must be a numeric string');
  return value;
}
function string(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}
function flag(value: unknown, name: string): number {
  if (value === undefined) return 0;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value ? 1 : 0;
}
function check(result: unknown, method: string): asserts result is Native {
  if (!result || typeof result !== 'object' || !('result' in result) || result.result !== 0)
    throw nativeResultError(`Native ${method} failed or returned an invalid result`, result);
}
export function createGroupNotices(session: Native) {
  const call = (family: string, method: string, ...args: unknown[]) => {
    if (typeof session[`get${family}Service`] !== 'function')
      throw new Error(`Native service is missing get${family}Service`);
    const service = session[`get${family}Service`]();
    if (!service || typeof service[method] !== 'function')
      throw new Error(`Native ${family} service is missing ${method}`);
    return service[method](...args);
  };
  const pskey = async (): Promise<string> => {
    const result = await call('TipOff', 'getPskey', ['qun.qq.com'], true);
    check(result, 'getPskey');
    if (!(result.domainPskeyMap instanceof Map))
      throw new Error('Native getPskey returned an invalid domain map');
    const key = result.domainPskeyMap.get('qun.qq.com');
    if (typeof key !== 'string' || !key)
      throw new Error('Native getPskey did not return the requested domain key');
    return key;
  };
  async function invokeOperation(
    method: GroupNoticeOperation,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const group = groupId(payload.groupId);
    if (method === 'deleteGroupNotice') {
      const noticeId = string(payload.noticeId, 'noticeId');
      if (!noticeId) throw new Error('noticeId must not be empty');
      const result = await call('Group', 'deleteGroupBulletin', group, await pskey(), noticeId);
      // The native declaration returns void; this is dispatch completion only.
      if (result !== undefined) check(result, 'deleteGroupBulletin');
      return;
    }
    if (method !== 'publishGroupNotice')
      throw new Error(`Unsupported group notice operation: ${method}`);
    const content = string(payload.text, 'text');
    if (
      payload.options !== undefined &&
      (!payload.options || typeof payload.options !== 'object' || Array.isArray(payload.options))
    )
      throw new Error('options must be an object');
    const options = (payload.options ?? {}) as Native;
    const pinned = flag(options.pinned, 'pinned');
    const confirmRequired = flag(options.confirmRequired, 'confirmRequired');
    let imagePath: string | undefined;
    if (options.imagePath !== undefined) {
      const input = string(options.imagePath, 'imagePath');
      if (!isAbsolute(input)) throw new Error('imagePath must be an absolute local file path');
      imagePath = await realpath(input);
      if (!(await stat(imagePath)).isFile())
        throw new Error('imagePath must reference a local file');
    }
    const key = await pskey();
    let picInfo: { id: string; width: number; height: number } | undefined;
    if (imagePath) {
      const result = await call('Group', 'uploadGroupBulletinPic', group, key, imagePath);
      check(result, 'uploadGroupBulletinPic');
      if (result.errCode !== 0)
        throw nativeResultError('Native bulletin image upload failed', result, 'errCode');
      const info = result.picInfo;
      if (
        !info ||
        typeof info.id !== 'string' ||
        !info.id ||
        !Number.isSafeInteger(info.width) ||
        info.width <= 0 ||
        !Number.isSafeInteger(info.height) ||
        info.height <= 0
      )
        throw new Error('Native bulletin upload returned invalid picture metadata');
      picInfo = { id: info.id, width: info.width, height: info.height };
    }
    const result = await call('Group', 'publishGroupBulletin', group, key, {
      text: encodeURI(content),
      picInfo,
      oldFeedsId: '',
      pinned,
      confirmRequired,
    });
    check(result, 'publishGroupBulletin');
    // Native success supplies no verified notice ID or reading/recipient receipt.
  }
  return { invokeOperation };
}
