/** Worker-only QQ group HTTP read transport. Fixed NapCatQQ 26d7533e:
 * UserApi134-151, WebApi74-94/211-236/322-330. Two read endpoints share
 * native ticket exchange, manual redirect checks, timeout/abort and cookie hashing.
 * No ticket or credential-bearing error is returned to callers.
 */
export interface QunTicketPort {
  forceFetchClientKey?: (selector: string) => unknown;
}
export interface QunDomainKeyPort {
  getPskey?: (domains: string[], flag: boolean) => unknown;
}
export interface QunWebReadContext {
  readonly getTicketService: () => QunTicketPort | null | undefined;
  readonly getTipOffService: () => QunDomainKeyPort | null | undefined;
  readonly accountId: string;
  readonly fetchImpl?: typeof fetch;
  readonly signal: AbortSignal;
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}
export async function requestQunPage(
  context: QunWebReadContext,
  endpoint: 'notices' | 'essence',
  parameters: URLSearchParams,
): Promise<unknown> {
  const { accountId, signal, fetchImpl = fetch, awaitAlive } = context;
  const capturedParameters = new URLSearchParams(parameters);
  if (!/^\d+$/.test(accountId)) throw new Error('accountId must be a numeric string');
  const label = endpoint === 'notices' ? 'Group notice' : 'Group essence';
  const ensureActive = (activeSignal = signal) => {
    if (activeSignal.aborted) throw new Error(`${label} listing cancelled`);
  };
  const wait = async <T>(value: T | PromiseLike<T>, activeSignal = signal): Promise<T> => {
    const pending = Promise.resolve(value);
    if (activeSignal.aborted) {
      void pending.catch(() => {});
      ensureActive(activeSignal);
    }
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new Error(`${label} listing cancelled`));
      activeSignal.addEventListener('abort', abort, { once: true });
    });
    try {
      const result = await Promise.race([awaitAlive(pending), stopped]);
      ensureActive(activeSignal);
      return result;
    } finally {
      activeSignal.removeEventListener('abort', abort);
    }
  };
  ensureActive();
  const request = async (url: string, init: RequestInit = {}) => {
    ensureActive();
    const activeSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    let received: Response | undefined;
    let cancellation: Promise<void> | undefined;
    const cancelBody = () =>
      (cancellation ??= Promise.resolve()
        .then(() => received?.body?.cancel())
        .then(() => {}));
    const cancelLate = () => {
      if (received) void cancelBody().catch(() => {});
    };
    try {
      ensureActive(activeSignal);
      const pending = Promise.resolve(
        fetchImpl(url, {
          ...init,
          redirect: 'manual',
          signal: activeSignal,
        }),
      ).then((response) => {
        received = response;
        if (activeSignal.aborted) cancelLate();
        return response;
      });
      const response = await wait(pending, activeSignal);
      return { response, activeSignal, cancelBody };
    } catch {
      cancelLate();
      throw new Error(`${label} HTTP request failed`);
    }
  };
  let clientKey: string;
  try {
    ensureActive();
    const service = context.getTicketService();
    ensureActive();
    const method = service?.forceFetchClientKey;
    ensureActive();
    if (typeof method !== 'function') throw new Error('Missing ticket method');
    const ticket = record(await wait(Reflect.apply(method, service, ['']) as unknown));
    const status = ticket?.result,
      key = ticket?.clientKey;
    ensureActive();
    if (status !== 0 || typeof key !== 'string' || !key) throw new Error('Invalid ticket');
    clientKey = key;
  } catch {
    ensureActive();
    throw new Error('Native client key acquisition failed');
  }
  let url =
    'https://ssl.ptlogin2.qq.com/jump?ptlang=1033&clientuin=' +
    accountId +
    '&clientkey=' +
    encodeURIComponent(clientKey) +
    '&u1=https%3A%2F%2Fqun.qq.com%2F' +
    accountId +
    '%2Finfocenter&keyindex=19%27';
  const cookies: Record<string, string> = Object.create(null);
  for (let redirects = 0; ; redirects++) {
    const { response, activeSignal, cancelBody } = await request(url);
    try {
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';', 1)[0]!;
        const at = pair.indexOf('=');
        if (at > 0 && at < pair.length - 1) cookies[pair.slice(0, at)] = pair.slice(at + 1);
      }
      await wait(cancelBody(), activeSignal);
    } catch {
      void cancelBody().catch(() => {});
      throw new Error(`${label} cookie exchange failed`);
    }
    let status: number, ok: boolean;
    try {
      status = response.status;
      ok = response.ok;
      ensureActive(activeSignal);
    } catch {
      void cancelBody().catch(() => {});
      throw new Error(`${label} cookie exchange failed`);
    }
    if (status !== 301 && status !== 302) {
      if (!ok) throw new Error(`${label} cookie exchange failed`);
      break;
    }
    let location: string | null;
    try {
      location = response.headers.get('location');
      ensureActive(activeSignal);
    } catch {
      throw new Error(`${label} cookie redirect failed`);
    }
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
    let key: string;
    try {
      ensureActive();
      const service = context.getTipOffService();
      ensureActive();
      const method = service?.getPskey;
      ensureActive();
      if (typeof method !== 'function') throw new Error('Missing domain key method');
      const keys = record(
        await wait(Reflect.apply(method, service, [['qun.qq.com'], true]) as unknown),
      );
      const status = keys?.result,
        domainMap = keys?.domainPskeyMap;
      ensureActive();
      const value = domainMap instanceof Map ? domainMap.get('qun.qq.com') : undefined;
      ensureActive();
      if (status !== 0 || typeof value !== 'string' || !value)
        throw new Error('Invalid domain key');
      key = value;
    } catch {
      ensureActive();
      throw new Error('Native domain key acquisition failed');
    }
    cookies.p_skey = key;
  }
  if (!cookies.skey) throw new Error(`${label} cookie exchange omitted skey`);
  let hash = 5381;
  for (let i = 0; i < cookies.skey.length; i++) hash += (hash << 5) + cookies.skey.charCodeAt(i);

  const query = new URLSearchParams({ bkn: (hash & 0x7fffffff).toString() });
  for (const [key, value] of capturedParameters) query.append(key, value);
  const urlPrefix =
    endpoint === 'notices'
      ? 'https://web.qun.qq.com/cgi-bin/announce/get_t_list'
      : 'https://qun.qq.com/cgi-bin/group_digest/digest_list';
  const { response, activeSignal, cancelBody } = await request(`${urlPrefix}?${query}`, {
    headers: {
      Cookie: Object.entries(cookies)
        .map(([key, value]) => `${key}=${value}`)
        .join('; '),
    },
  });
  try {
    if (!response.ok) throw new Error('HTTP failure');
    ensureActive(activeSignal);
  } catch {
    void cancelBody().catch(() => {});
    throw new Error(`${label} list HTTP request failed`);
  }
  let raw: unknown;
  try {
    ensureActive(activeSignal);
    raw = await wait(response.json(), activeSignal);
  } catch {
    void cancelBody().catch(() => {});
    throw new Error(`${label} list returned invalid JSON`);
  }
  ensureActive(activeSignal);
  ensureActive();
  return raw;
}
