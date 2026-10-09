/** HTTP path, pinned NapCatQQ 26d7533e0f5800fdff865ab2f2ad7692917e1076:
 * apis/webapi.ts211-236,318-330; apis/user.ts134-151,245-246;
 * napcat-common/src/request.ts6-51; types/webapi.ts58-106.
 * This fixed query is not evidence of complete pagination. Tickets stay in worker.
 */
export interface WebGroupNotice {
  noticeId: string; senderId: string; publishTime: number; text: string;
  images: { id: string; width: string; height: string }[];
  settings?: unknown; readCount?: number; raw: Record<string, unknown>;
}
export interface WebGroupNoticeResult { notices: WebGroupNotice[]; raw: Record<string, unknown> }
type Native = Record<string, any>;
export async function listWebGroupNotices(session: Native, accountId: string, groupId: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<WebGroupNoticeResult> {
  if (!/^\d+$/.test(accountId) || !/^\d+$/.test(groupId)) throw new Error('accountId and groupId must be numeric strings');
  const ensureActive=()=>{if(signal?.aborted) throw new Error('Group notice listing cancelled');};
  ensureActive();
  const request = async (url: string, init: RequestInit = {}) => {
    ensureActive();
    try {
      const timeout=AbortSignal.timeout(15_000);
      const response=await fetchImpl(url, { ...init, redirect: 'manual', signal: signal ? AbortSignal.any([signal,timeout]) : timeout });
      if(signal?.aborted){await response.body?.cancel();ensureActive();}
      return response;
    }
    catch { throw new Error('Group notice HTTP request failed'); } // Never propagate credential-bearing URL/errors.
  };
  let ticket: Native;
  try { ticket = await session.getTicketService().forceFetchClientKey(''); }
  catch { throw new Error('Native client key acquisition failed'); }
  ensureActive();
  if (ticket?.result !== 0 || typeof ticket.clientKey !== 'string' || !ticket.clientKey) throw new Error('Native client key acquisition failed');
  let url = 'https://ssl.ptlogin2.qq.com/jump?ptlang=1033&clientuin=' + accountId + '&clientkey=' + encodeURIComponent(ticket.clientKey) + '&u1=https%3A%2F%2Fqun.qq.com%2F' + accountId + '%2Finfocenter&keyindex=19%27';
  const cookies: Record<string, string> = Object.create(null);
  for (let redirects = 0; ; redirects++) {
    const response = await request(url);
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0]!;
      const at = pair.indexOf('=');
      if (at > 0 && at < pair.length - 1) cookies[pair.slice(0, at)] = pair.slice(at + 1);
    }
    await response.body?.cancel();
    if (response.status !== 301 && response.status !== 302) {
      if (!response.ok) throw new Error('Group notice cookie exchange failed');
      break;
    }
    const location = response.headers.get('location');
    if (!location || redirects >= 5) throw new Error('Group notice cookie redirect failed');
    const next = new URL(location, url);
    if (next.protocol !== 'https:' || !(next.hostname === 'qq.com' || next.hostname.endsWith('.qq.com')) || next.username || next.password) throw new Error('Group notice cookie redirect failed');
    url = next.href;
  }
  if (!cookies.p_skey) {
    let keys: Native;
    try { keys = await session.getTipOffService().getPskey(['qun.qq.com'], true); }
    catch { throw new Error('Native domain key acquisition failed'); }
    ensureActive();
    const key = keys?.domainPskeyMap instanceof Map ? keys.domainPskeyMap.get('qun.qq.com') : undefined;
    if (keys?.result !== 0 || typeof key !== 'string' || !key) throw new Error('Native domain key acquisition failed');
    cookies.p_skey = key;
  }
  if (!cookies.skey) throw new Error('Group notice cookie exchange omitted skey');
  let hash = 5381;
  for (let i = 0; i < cookies.skey.length; i++) hash += (hash << 5) + cookies.skey.charCodeAt(i);
  const query = new URLSearchParams({ bkn: (hash & 0x7fffffff).toString(), qid: groupId, ft: '23', ni: '1', n: '1', i: '1', log_read: '1', platform: '1', s: '-1' });
  const response = await request(`https://web.qun.qq.com/cgi-bin/announce/get_t_list?${query}&n=20`, { headers: { Cookie: Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; ') } });
  if (!response.ok) throw new Error('Group notice list HTTP request failed');
  let raw: Native;
  try { raw = await response.json(); } catch { throw new Error('Group notice list returned invalid JSON'); }
  ensureActive();
  if (!raw || raw.ec !== 0 || !Array.isArray(raw.feeds)) throw new Error('Group notice list returned failure or invalid feeds');
  const notices = raw.feeds.filter((feed: unknown) => feed !== null && feed !== undefined).map((feed: Native) => {
    if (typeof feed.fid !== 'string' || !Number.isSafeInteger(feed.u) || !Number.isFinite(feed.pubt) || typeof feed.msg?.text !== 'string') throw new Error('Group notice list returned an invalid notice');
    const pics = feed.msg.pics ?? [];
    if (!Array.isArray(pics) || pics.some((pic: Native) => !pic || typeof pic.id !== 'string' || typeof pic.w !== 'string' || typeof pic.h !== 'string')) throw new Error('Group notice list returned invalid pictures');
    return { noticeId: feed.fid, senderId: String(feed.u), publishTime: feed.pubt, text: feed.msg.text, images: pics.map((pic: Native) => ({ id: pic.id, width: pic.w, height: pic.h })), settings: feed.settings, readCount: feed.read_num, raw: feed };
  });
  return { notices, raw };
}
