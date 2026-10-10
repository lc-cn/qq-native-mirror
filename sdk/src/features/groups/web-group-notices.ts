/** HTTP path, pinned NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * apis/webapi.ts211-236,318-330; apis/user.ts134-151,245-246;
 * napcat-common/src/request.ts6-51; types/webapi.ts58-106.
 * This fixed query is not evidence of complete pagination. Tickets stay in worker.
 */
import type { WebGroupNoticeResult } from '../../contracts/groups.ts';
export type { WebGroupNotice, WebGroupNoticeResult } from '../../contracts/groups.ts';
export interface WebGroupNoticesContext {
  accountId: string;
  signal: AbortSignal;
  readPage(parameters: URLSearchParams): Promise<unknown>;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}
export async function listWebGroupNotices(
  context: WebGroupNoticesContext,
  groupId: unknown,
): Promise<WebGroupNoticeResult> {
  const { accountId, signal, readPage } = context;
  const alive = () => {
    if (signal.aborted) throw new Error('Group notice listing cancelled');
  };
  alive();
  if (typeof groupId !== 'string' || !/^\d+$/.test(accountId) || !/^\d+$/.test(groupId))
    throw new Error('accountId and groupId must be numeric strings');
  const query = new URLSearchParams({
    qid: groupId,
    ft: '23',
    ni: '1',
    n: '1',
    i: '1',
    log_read: '1',
    platform: '1',
    s: '-1',
  });
  query.append('n', '20');
  const raw = await readPage(query);
  alive();
  const result = record(raw);
  const status = result?.ec,
    feeds = result?.feeds;
  alive();
  if (status !== 0 || !Array.isArray(feeds))
    throw new Error('Group notice list returned failure or invalid feeds');
  const notices = feeds
    .filter((feed) => feed !== null && feed !== undefined)
    .map((value) => {
      alive();
      const feed = record(value),
        msg = record(feed?.msg);
      const fid = feed?.fid,
        sender = feed?.u,
        time = feed?.pubt,
        text = msg?.text;
      if (
        typeof fid !== 'string' ||
        typeof sender !== 'number' ||
        !Number.isSafeInteger(sender) ||
        typeof time !== 'number' ||
        !Number.isFinite(time) ||
        typeof text !== 'string'
      )
        throw new Error('Group notice list returned an invalid notice');
      const pics = msg?.pics ?? [];
      if (!Array.isArray(pics)) throw new Error('Group notice list returned invalid pictures');
      const images = pics.map((value) => {
        const pic = record(value),
          id = pic?.id,
          width = pic?.w,
          height = pic?.h;
        if (typeof id !== 'string' || typeof width !== 'string' || typeof height !== 'string')
          throw new Error('Group notice list returned invalid pictures');
        alive();
        return { id, width, height };
      });
      const settings = feed?.settings,
        readCount = feed?.read_num;
      alive();
      return {
        noticeId: fid,
        senderId: String(sender),
        publishTime: time,
        text,
        images,
        settings,
        // Preserve the existing optional passthrough, without adding a validation claim.
        readCount: readCount as number | undefined,
        raw: value,
      };
    });
  alive();
  return { notices, raw: result! };
}
