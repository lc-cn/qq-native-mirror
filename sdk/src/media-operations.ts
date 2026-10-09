import { nativeResultError } from './errors.ts';
import { constants } from 'node:fs';
import { mkdir, stat, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

type Native = Record<string, any>;
type EventCall = (event: string, check: (...args: any[]) => unknown, invoke: () => any, timeoutMs?: number, checkReturn?: (value: any) => boolean) => Promise<any>;
/** Native download contract, fixed NapCat source:
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/file.ts#L256-L276
 * https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/listeners/NodeIKernelMsgListener.ts#L4-L20
 */
export async function downloadAttachment(
  msgService: Native,
  peer: { chatType: number; peerUid: string },
  payload: { messageId: unknown; elementId: unknown; destination: unknown },
  eventCall: EventCall,
  signal?: AbortSignal,
): Promise<{ file: string }> {
  signal?.throwIfAborted();
  const { messageId, elementId, destination } = payload;
  if (typeof messageId !== 'string' || !messageId || typeof elementId !== 'string' || !elementId) throw new Error('Attachment requires messageId and elementId');
  if (typeof destination !== 'string' || !isAbsolute(destination)) throw new Error('Attachment destination must be an absolute local path');
  if (typeof msgService.downloadRichMedia !== 'function') throw new Error('Native service is missing downloadRichMedia');
  await mkdir(dirname(destination), { recursive: true });
  try { await stat(destination); throw new Error('Attachment destination already exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const stagingDir = await mkdtemp(join(dirname(destination), '.qq-download-'));
  const stagingPath = join(stagingDir, 'attachment');
  try {
  const file = await eventCall('Msg/onRichMediaDownloadComplete', (complete: Native) => {
    if (complete.msgElementId !== elementId || complete.msgId !== messageId) return undefined;
    for (const key of ['fileErrCode', 'fileSrvErrCode']) {
      if (complete[key] !== undefined && String(complete[key]) !== '0') throw nativeResultError(`Native attachment download failed: ${key}`, complete, key);
    }
    if (typeof complete.filePath !== 'string' || !isAbsolute(complete.filePath)) throw new Error('Native attachment completion has no local path');
    return complete.filePath;
  }, () => msgService.downloadRichMedia({
    fileModelId: '0', downSourceType: 0, downloadSourceType: 0, triggerType: 1,
    msgId: messageId, chatType: peer.chatType, peerUid: peer.peerUid,
    elementId, thumbSize: 0, downloadType: 1, filePath: stagingPath,
  }), 120_000);
  signal?.throwIfAborted();
  if (!(await stat(file)).isFile()) throw new Error('Native attachment completion did not produce a file');
  // COPYFILE_EXCL also prevents overwriting a file created during transfer.
  signal?.throwIfAborted();
  await copyFile(file, destination, constants.COPYFILE_EXCL);
  return { file: destination };
  } finally { await rm(stagingDir, { recursive: true, force: true }); }
}
