import { withCleanupFailure } from '../../runtime/cleanup.ts';
import { captureDownloadPayload, own, downloadStrings } from './download-input.ts';
export { captureDownloadRequest, captureDownloadPayload } from './download-input.ts';
import { nativeResultError } from '../../errors.ts';
import { constants } from 'node:fs';
import { mkdir, stat, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import type { AttachmentDownloadPort } from '../../runtime/media-contracts.ts';
import type { NativeEventChannel } from '../../runtime/native-event-channel.ts';
import type { Peer } from '../../contracts/messages.ts';
import type { NativePeer } from '../../native/message-contracts.ts';
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
  msgService: AttachmentDownloadPort | null | undefined,
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
  const capturedPeer: { chatType: 1 | 2; peerUid: string } = { chatType, peerUid };
  const method = msgService?.downloadRichMedia;
  signal?.throwIfAborted();
  if (typeof method !== 'function') throw new Error('Native service is missing downloadRichMedia');
  await mkdir(dirname(destination), { recursive: true });
  try {
    await stat(destination);
    throw new Error('Attachment destination already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const stagingDir = await mkdtemp(join(dirname(destination), '.qq-download-'));
  const stagingPath = join(stagingDir, 'attachment');
  let failed = false;
  let primary: unknown;
  try {
    signal?.throwIfAborted();
    const file = await eventCall(
      'Msg/onRichMediaDownloadComplete',
      (complete: unknown) => {
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
        return Reflect.apply(method, msgService, [
          {
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
          },
        ]) as unknown;
      },
      120_000,
      undefined,
      signal,
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
  } catch (error) {
    failed = true;
    primary = error;
  }
  try {
    await rm(stagingDir, { recursive: true, force: true });
  } catch (cleanup) {
    if (failed) throw withCleanupFailure(primary, cleanup);
    throw cleanup;
  }
  if (failed) throw primary;
  return { file: destination };
}

export interface AttachmentDownloadsContext {
  signal: AbortSignal;
  resolvePeer(peer: Peer): Promise<NativePeer>;
  awaitAlive<T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T>;
  getMessageService(): AttachmentDownloadPort | null | undefined;
  eventCall: EventCall;
}

/** Owns captured download intent and its cancellable wait; shared callback channel and started FS work remain external. */
export function createAttachmentDownloads(context: AttachmentDownloadsContext) {
  const local = new AbortController();
  const signal = AbortSignal.any([context.signal, local.signal]);
  return {
    async download(payload: unknown, requestSignal?: AbortSignal): Promise<{ file: string }> {
      const captured = captureDownloadPayload(payload);
      const operationSignal = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
      operationSignal.throwIfAborted();
      const peer = await context.awaitAlive(context.resolvePeer(captured.peer), operationSignal);
      operationSignal.throwIfAborted();
      const service = context.getMessageService();
      operationSignal.throwIfAborted();
      // The low-level event wait is cancellable. Wait for its staging cleanup
      // before settling this owner result; already-started filesystem work is not undone.
      const result = await downloadAttachment(
        service,
        peer,
        captured,
        context.eventCall,
        operationSignal,
      );
      operationSignal.throwIfAborted();
      return result;
    },
    close(): void {
      if (!local.signal.aborted) local.abort(new Error('Attachment downloads are closed'));
    },
  };
}
