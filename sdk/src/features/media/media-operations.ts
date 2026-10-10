import { own, downloadStrings } from './download-input.ts';
export { captureDownloadRequest, captureDownloadPayload } from './download-input.ts';
import { nativeResultError } from '../../errors.ts';
import { constants } from 'node:fs';
import { mkdir, stat, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import type { NativeObject as Native } from '../../native/native-object.ts';
import type { NativeEventChannel } from '../../runtime/native-event-channel.ts';
type EventCall = NativeEventChannel['call'];
function completionData(value: unknown, key: string): unknown {
  try {
    return own(value, key);
  } catch {
    throw Object.assign(new Error('Invalid native attachment completion'), {
      code: 'invalid-result',
    });
  }
}
function completionCode(value: unknown, key: string): void {
  const code = completionData(value, key);
  if (code === '0' || code === 0) return;
  if (
    (typeof code === 'string' && code.length > 0) ||
    (typeof code === 'number' && Number.isFinite(code))
  )
    throw nativeResultError(`Native attachment download failed: ${key}`, { [key]: code }, key);
  throw Object.assign(new Error(`Invalid native attachment completion ${key}`), {
    code: 'invalid-result',
  });
}
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
  const { messageId, elementId, destination } = downloadStrings(
    own(payload, 'messageId'),
    own(payload, 'elementId'),
    own(payload, 'destination'),
  );
  const chatType = own(peer, 'chatType'),
    peerUid = own(peer, 'peerUid');
  if ((chatType !== 1 && chatType !== 2) || typeof peerUid !== 'string' || !peerUid)
    throw new Error('Invalid attachment native peer');
  const capturedPeer = { chatType, peerUid };
  if (typeof msgService.downloadRichMedia !== 'function')
    throw new Error('Native service is missing downloadRichMedia');
  await mkdir(dirname(destination), { recursive: true });
  try {
    await stat(destination);
    throw new Error('Attachment destination already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const stagingDir = await mkdtemp(join(dirname(destination), '.qq-download-'));
  const stagingPath = join(stagingDir, 'attachment');
  try {
    signal?.throwIfAborted();
    const file = await eventCall(
      'Msg/onRichMediaDownloadComplete',
      (complete: Native) => {
        if (
          completionData(complete, 'msgElementId') !== elementId ||
          completionData(complete, 'msgId') !== messageId
        )
          return undefined;
        completionCode(complete, 'fileErrCode');
        completionCode(complete, 'fileSrvErrCode');
        const reportedChatType = completionData(complete, 'chatType');
        if (reportedChatType !== undefined && reportedChatType !== capturedPeer.chatType)
          throw Object.assign(
            new Error('Native attachment completion has a mismatched conversation'),
            { code: 'invalid-result' },
          );
        const path = completionData(complete, 'filePath');
        if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))
          throw Object.assign(new Error('Invalid native attachment completion path'), {
            code: 'invalid-result',
          });
        return path;
      },
      () => {
        signal?.throwIfAborted();
        return msgService.downloadRichMedia({
          fileModelId: '0',
          downSourceType: 0,
          downloadSourceType: 0,
          triggerType: 1,
          msgId: messageId,
          chatType: capturedPeer.chatType,
          peerUid: capturedPeer.peerUid,
          elementId,
          thumbSize: 0,
          downloadType: 1,
          filePath: stagingPath,
        });
      },
      120_000,
    );
    signal?.throwIfAborted();
    let info;
    try {
      info = await stat(file);
    } catch (error) {
      throw nativeResultError('Native attachment file could not be read', {
        result: Object.getOwnPropertyDescriptor(error as object, 'code')?.value,
      });
    }
    if (!info.isFile()) throw new Error('Native attachment completion did not produce a file');
    // COPYFILE_EXCL also prevents overwriting a file created during transfer.
    signal?.throwIfAborted();
    try {
      await copyFile(file, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      throw nativeResultError('Attachment destination could not be published', {
        result: Object.getOwnPropertyDescriptor(error as object, 'code')?.value,
      });
    }
    signal?.throwIfAborted();
    return { file: destination };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
