import { nativeResultError } from '../../errors.ts';
/** Fixed NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/group.ts#L400-L403
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/group.ts#L522-L525
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/group.ts#L570-L584
 * apis/user.ts150-151: TipOffService.getPskey(domainList,true).
 * No list implementation: native bulletin result/listener fields remain unknown;
 * pinned OneBot GetGroupNotice uses WebApi rather than these native callbacks.
 */
import { realpath, stat } from 'node:fs/promises';
import { captureGroupNoticeDeletion, captureGroupNoticePublication } from './group-notice-input.ts';
export interface GroupNoticePicture {
  id: string;
  width: number;
  height: number;
}
export interface GroupNoticePublication {
  text: string;
  picInfo: GroupNoticePicture | undefined;
  oldFeedsId: string;
  pinned: number;
  confirmRequired: number;
}
export interface GroupNoticeTicketPort {
  getPskey?: (domains: string[], flag: boolean) => unknown;
}
export interface GroupNoticePort {
  uploadGroupBulletinPic?: (group: string, key: string, path: string) => unknown;
  publishGroupBulletin?: (group: string, key: string, payload: GroupNoticePublication) => unknown;
  deleteGroupBulletin?: (group: string, key: string, notice: string) => unknown;
}
export interface GroupNoticesContext {
  getTipOffService(): GroupNoticeTicketPort | null | undefined;
  getGroupService(): GroupNoticePort | null | undefined;
  signal: AbortSignal;
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}
export type GroupNoticeOperation = 'publishGroupNotice' | 'deleteGroupNotice';
function check(result: unknown, method: string): asserts result is Record<string, unknown> {
  if (
    !result ||
    typeof result !== 'object' ||
    !('result' in result) ||
    (result as Record<string, unknown>).result !== 0
  )
    throw nativeResultError(`Native ${method} failed or returned an invalid result`, result);
}
export function createGroupNotices(context: GroupNoticesContext) {
  const controller = new AbortController();
  let closed = false;
  const alive = () => {
    context.signal.throwIfAborted();
    if (closed) throw new Error('Group notice service is closed');
  };
  const retire = () => {
    if (closed) return;
    closed = true;
    context.signal.removeEventListener('abort', retire);
    controller.abort(
      context.signal.aborted ? context.signal.reason : new Error('Group notice service is closed'),
    );
  };
  context.signal.addEventListener('abort', retire, { once: true });
  if (context.signal.aborted) retire();
  const wait = async <T>(value: T | PromiseLike<T>): Promise<T> => {
    const pending = Promise.resolve(value);
    if (controller.signal.aborted) {
      void pending.catch(() => {});
      throw controller.signal.reason;
    }
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const result = await Promise.race([context.awaitAlive(pending), stopped]);
      alive();
      return result;
    } finally {
      controller.signal.removeEventListener('abort', abort);
    }
  };
  const groupCall = <K extends keyof GroupNoticePort>(
    methodName: K,
    args: Parameters<NonNullable<GroupNoticePort[K]>>,
  ) => {
    alive();
    const service = context.getGroupService();
    alive();
    const method = service?.[methodName];
    alive();
    if (typeof method !== 'function')
      throw new Error(`Native Group service is missing ${methodName}`);
    return Reflect.apply(method, service, args) as unknown;
  };
  const ticketCall = () => {
    alive();
    const service = context.getTipOffService();
    alive();
    const method = service?.getPskey;
    alive();
    if (typeof method !== 'function') throw new Error('Native TipOff service is missing getPskey');
    return Reflect.apply(method, service, [['qun.qq.com'], true]) as unknown;
  };
  const pskey = async (): Promise<string> => {
    const result = await wait(ticketCall());
    check(result, 'getPskey');
    const domainMap = result.domainPskeyMap;
    if (!(domainMap instanceof Map))
      throw new Error('Native getPskey returned an invalid domain map');
    const key = domainMap.get('qun.qq.com');
    if (typeof key !== 'string' || !key)
      throw new Error('Native getPskey did not return the requested domain key');
    alive();
    return key;
  };
  async function invokeOperation(
    method: GroupNoticeOperation,
    payload: Record<string, unknown>,
  ): Promise<void> {
    alive();
    if (method === 'deleteGroupNotice') {
      const { groupId: group, noticeId } = captureGroupNoticeDeletion(
        payload.groupId,
        payload.noticeId,
      );
      const key = await pskey();
      const result = await wait(groupCall('deleteGroupBulletin', [group, key, noticeId]));
      // The native declaration returns void; this is dispatch completion only.
      if (result !== undefined) check(result, 'deleteGroupBulletin');
      alive();
      return;
    }
    if (method !== 'publishGroupNotice')
      throw new Error(`Unsupported group notice operation: ${method}`);
    const captured = captureGroupNoticePublication(payload.groupId, payload.text, payload.options);
    const group = captured.groupId;
    const content = captured.text;
    const options = captured.options ?? {};
    const pinned = options.pinned ? 1 : 0;
    const confirmRequired = options.confirmRequired ? 1 : 0;
    let imagePath: string | undefined;
    const capturedImagePath = options.imagePath;
    if (capturedImagePath !== undefined) {
      alive();
      imagePath = await wait(realpath(capturedImagePath));
      if (!(await wait(stat(imagePath))).isFile())
        throw new Error('imagePath must reference a local file');
    }
    alive();
    const key = await pskey();
    let picInfo: { id: string; width: number; height: number } | undefined;
    if (imagePath) {
      const result = await wait(groupCall('uploadGroupBulletinPic', [group, key, imagePath]));
      check(result, 'uploadGroupBulletinPic');
      if (result.errCode !== 0)
        throw nativeResultError('Native bulletin image upload failed', result, 'errCode');
      const info = record(result.picInfo);
      const id = info?.id,
        width = info?.width,
        height = info?.height;
      if (
        typeof id !== 'string' ||
        !id ||
        typeof width !== 'number' ||
        !Number.isSafeInteger(width) ||
        width <= 0 ||
        typeof height !== 'number' ||
        !Number.isSafeInteger(height) ||
        height <= 0
      )
        throw new Error('Native bulletin upload returned invalid picture metadata');
      picInfo = { id, width, height };
    }
    const result = await wait(
      groupCall('publishGroupBulletin', [
        group,
        key,
        {
          text: encodeURI(content),
          picInfo,
          oldFeedsId: '',
          pinned,
          confirmRequired,
        },
      ]),
    );
    check(result, 'publishGroupBulletin');
    alive();
    // Native success supplies no verified notice ID or reading/recipient receipt.
  }
  return { invokeOperation, close: retire };
}
