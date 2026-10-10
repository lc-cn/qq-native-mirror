import type { CapturedMergedForward } from './merged-forward-input.ts';
export { captureMergedForward } from './merged-forward-input.ts';
export type { CapturedMergedForward } from './merged-forward-input.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildTextForwardRequest } from './long-message-request.ts';
import { buildMergedForwardCard } from './merged-forward-card.ts';
import {
  LongMessageResponseError,
  type createLongMessageResponseTransport,
} from './long-message-response.ts';
import { MergedForwardError } from '../../errors.ts';
import type { SentMessage, SentMergedForward } from '../../types.ts';

type UploadTransport = ReturnType<typeof createLongMessageResponseTransport>;
export async function sendCapturedMergedForward(
  captured: CapturedMergedForward,
  selfUid: string,
  getTransport: () => UploadTransport,
  sendCard: (
    element: ReturnType<typeof buildMergedForwardCard>,
    onDispatch: () => void,
  ) => Promise<SentMessage>,
  signal: AbortSignal,
): Promise<SentMergedForward> {
  let resourceId: string;
  try {
    signal.throwIfAborted();
    const request = buildTextForwardRequest({
      selfUid,
      target:
        captured.peer.type === 'group'
          ? { type: 'group', groupUin: Number(captured.peer.groupId) }
          : { type: 'private' },
      nodes: captured.nodes.map((n) => ({
        senderUin: Number(n.userId),
        displayName: n.nickname,
        timeSeconds: n.time,
        text: n.text,
        sequence: randomBytes(4).readUInt32LE(0),
      })),
    });
    resourceId = (await getTransport().send(request.command, request.data, { signal })).resId;
  } catch (error) {
    const dispatched = error instanceof LongMessageResponseError && error.dispatched;
    throw new MergedForwardError('upload', 'Merged-forward upload failed', {
      uploadCompletion: dispatched ? 'unknown' : 'not-dispatched',
      cardCompletion: 'not-dispatched',
    });
  }
  let dispatched = false;
  try {
    signal.throwIfAborted();
    const card = buildMergedForwardCard({
      resourceId,
      cardId: randomUUID(),
      nodes: captured.nodes.map((n) => ({ displayName: n.nickname, text: n.text })),
      options: captured.options,
    });
    const sent = await sendCard(card, () => {
      dispatched = true;
    });
    signal.throwIfAborted();
    return { ...sent, resourceId };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    throw new MergedForwardError(
      'card',
      'Merged-forward card sending failed',
      {
        uploadCompletion: 'resource-received',
        cardCompletion: dispatched ? 'unknown' : 'not-dispatched',
        resourceId,
      },
      typeof code === 'string' || (typeof code === 'number' && Number.isFinite(code))
        ? code
        : undefined,
    );
  }
}
