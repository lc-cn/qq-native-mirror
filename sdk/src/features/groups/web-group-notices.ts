/** HTTP path, pinned NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * apis/webapi.ts211-236,318-330; apis/user.ts134-151,245-246;
 * napcat-common/src/request.ts6-51; types/webapi.ts58-106.
 * This fixed query is not evidence of complete pagination. Tickets stay in worker.
 */
import type { WebGroupNoticeResult } from '../../contracts/groups.ts';
export type { WebGroupNotice, WebGroupNoticeResult } from '../../contracts/groups.ts';
import type { NativeObject as Native } from '../../native/native-object.ts';
import { requestQunPage } from './qun-web-read.ts';
export async function listWebGroupNotices(
  session: Native,
  accountId: string,
  groupId: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<WebGroupNoticeResult> {
  if (!/^\d+$/.test(accountId) || !/^\d+$/.test(groupId))
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
  const raw = (await requestQunPage(
    { session, accountId, fetchImpl, signal },
    'notices',
    query,
  )) as Native;
  if (!raw || raw.ec !== 0 || !Array.isArray(raw.feeds))
    throw new Error('Group notice list returned failure or invalid feeds');
  const notices = raw.feeds
    .filter((feed: unknown) => feed !== null && feed !== undefined)
    .map((feed: Native) => {
      if (
        typeof feed.fid !== 'string' ||
        !Number.isSafeInteger(feed.u) ||
        !Number.isFinite(feed.pubt) ||
        typeof feed.msg?.text !== 'string'
      )
        throw new Error('Group notice list returned an invalid notice');
      const pics = feed.msg.pics ?? [];
      if (
        !Array.isArray(pics) ||
        pics.some(
          (pic: Native) =>
            !pic ||
            typeof pic.id !== 'string' ||
            typeof pic.w !== 'string' ||
            typeof pic.h !== 'string',
        )
      )
        throw new Error('Group notice list returned invalid pictures');
      return {
        noticeId: feed.fid,
        senderId: String(feed.u),
        publishTime: feed.pubt,
        text: feed.msg.text,
        images: pics.map((pic: Native) => ({ id: pic.id, width: pic.w, height: pic.h })),
        settings: feed.settings,
        readCount: feed.read_num,
        raw: feed,
      };
    });
  return { notices, raw };
}
