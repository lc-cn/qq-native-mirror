/** Worker-only QQ group HTTP read transport. Fixed NapCatQQ 26d7533e:
 * UserApi134-151, WebApi74-94/211-236/322-330. Two read endpoints share
 * native ticket exchange, manual redirect checks, timeout/abort and cookie hashing.
 * No ticket or credential-bearing error is returned to callers.
 */
import type { NativeObject as Native } from '../../native/native-object.ts';
export interface QunWebReadContext {
  readonly session: Native;
  readonly accountId: string;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}
export async function requestQunPage(
  context: QunWebReadContext,
  endpoint: 'notices' | 'essence',
  parameters: URLSearchParams,
): Promise<unknown> {
  const { session, accountId, signal, fetchImpl = fetch } = context;
  if (!/^\d+$/.test(accountId)) throw new Error('accountId must be a numeric string');
  const label = endpoint === 'notices' ? 'Group notice' : 'Group essence';
  const ensureActive = () => {
    if (signal?.aborted) throw new Error(`${label} listing cancelled`);
  };
  ensureActive();
  const request = async (url: string, init: RequestInit = {}) => {
    ensureActive();
    try {
      const timeout = AbortSignal.timeout(15_000);
      const response = await fetchImpl(url, {
        ...init,
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (signal?.aborted) {
        await response.body?.cancel();
        ensureActive();
      }
      return response;
    } catch {
      throw new Error(`${label} HTTP request failed`);
    } // Never propagate credential-bearing URL/errors.
  };
  let ticket: Native;
  try {
    ticket = await session.getTicketService().forceFetchClientKey('');
  } catch {
    throw new Error('Native client key acquisition failed');
  }
  ensureActive();
  if (ticket?.result !== 0 || typeof ticket.clientKey !== 'string' || !ticket.clientKey)
    throw new Error('Native client key acquisition failed');
  let url =
    'https://ssl.ptlogin2.qq.com/jump?ptlang=1033&clientuin=' +
    accountId +
    '&clientkey=' +
    encodeURIComponent(ticket.clientKey) +
    '&u1=https%3A%2F%2Fqun.qq.com%2F' +
    accountId +
    '%2Finfocenter&keyindex=19%27';
  const cookies: Record<string, string> = Object.create(null);
  for (let redirects = 0; ; redirects++) {
    const response = await request(url);
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0]!;
      const at = pair.indexOf('=');
      if (at > 0 && at < pair.length - 1) cookies[pair.slice(0, at)] = pair.slice(at + 1);
    }
    try {
      await response.body?.cancel();
    } catch {
      throw new Error(`${label} cookie exchange failed`);
    }
    if (response.status !== 301 && response.status !== 302) {
      if (!response.ok) throw new Error(`${label} cookie exchange failed`);
      break;
    }
    const location = response.headers.get('location');
    if (!location || redirects >= 5) throw new Error(`${label} cookie redirect failed`);
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new Error(`${label} cookie redirect failed`);
    }
    if (
      next.protocol !== 'https:' ||
      !(next.hostname === 'qq.com' || next.hostname.endsWith('.qq.com')) ||
      next.username ||
      next.password
    )
      throw new Error(`${label} cookie redirect failed`);
    url = next.href;
  }
  if (!cookies.p_skey) {
    let keys: Native;
    try {
      keys = await session.getTipOffService().getPskey(['qun.qq.com'], true);
    } catch {
      throw new Error('Native domain key acquisition failed');
    }
    ensureActive();
    const key =
      keys?.domainPskeyMap instanceof Map ? keys.domainPskeyMap.get('qun.qq.com') : undefined;
    if (keys?.result !== 0 || typeof key !== 'string' || !key)
      throw new Error('Native domain key acquisition failed');
    cookies.p_skey = key;
  }
  if (!cookies.skey) throw new Error(`${label} cookie exchange omitted skey`);
  let hash = 5381;
  for (let i = 0; i < cookies.skey.length; i++) hash += (hash << 5) + cookies.skey.charCodeAt(i);

  const query = new URLSearchParams({ bkn: (hash & 0x7fffffff).toString() });
  for (const [key, value] of parameters) query.append(key, value);
  const urlPrefix =
    endpoint === 'notices'
      ? 'https://web.qun.qq.com/cgi-bin/announce/get_t_list'
      : 'https://qun.qq.com/cgi-bin/group_digest/digest_list';
  const response = await request(`${urlPrefix}?${query}`, {
    headers: {
      Cookie: Object.entries(cookies)
        .map(([key, value]) => `${key}=${value}`)
        .join('; '),
    },
  });
  if (!response.ok) throw new Error(`${label} list HTTP request failed`);
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error(`${label} list returned invalid JSON`);
  }
  ensureActive();
  return raw;
}
