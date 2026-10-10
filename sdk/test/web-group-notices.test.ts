import test from 'node:test';
import assert from 'node:assert/strict';
import { listWebGroupNotices } from '../src/features/groups/web-group-notices.ts';
function fixture(responses: Response[]) {
  const requests: { url: string; init: RequestInit }[] = [];
  const native: unknown[][] = [];
  const session = {
    getTicketService: () => ({
      forceFetchClientKey: async (...args: unknown[]) => {
        native.push(['ticket', ...args]);
        return { result: 0, clientKey: 'test-secret-key' };
      },
    }),
    getTipOffService: () => ({
      getPskey: async (...args: unknown[]) => {
        native.push(['pskey', ...args]);
        return { result: 0, domainPskeyMap: new Map([['qun.qq.com', 'test-domain-key']]) };
      },
    }),
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const response = responses.shift();
    assert.ok(response);
    return response;
  }) as typeof fetch;
  return { session, fetchImpl, requests, native };
}
const success = () =>
  Response.json({
    ec: 0,
    feeds: [
      {
        fid: 'notice',
        u: 123,
        pubt: 1,
        msg: { text: 'fixture', pics: [{ id: 'image', w: '20', h: '30' }] },
        read_num: 4,
      },
    ],
  });

test('session cancellation while awaiting a native ticket prevents subsequent HTTP exchange', async () => {
  const controller = new AbortController();
  let release!: (value: unknown) => void,
    fetches = 0;
  const ticket = new Promise((resolve) => {
    release = resolve;
  });
  const session = { getTicketService: () => ({ forceFetchClientKey: () => ticket }) };
  const fetchImpl = (async () => {
    fetches++;
    throw new Error('must not fetch');
  }) as typeof fetch;
  const pending = listWebGroupNotices(session, '123', '456', fetchImpl, controller.signal);
  const rejected = assert.rejects(pending, /cancelled/);
  controller.abort();
  release({ result: 0, clientKey: 'fixture-key' });
  await rejected;
  assert.equal(fetches, 0);
  const f = fixture([]);
  await assert.rejects(
    listWebGroupNotices(f.session, '123', '456', f.fetchImpl, controller.signal),
    /cancelled/,
  );
  assert.equal(f.native.length, 0, 'already closed Session never requests a ticket');
});

test('session cancellation aborts an active HTTP exchange without another native request', async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = fixture([]);
  const fetchImpl = (async (_url: unknown, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('fixture cancellation')), {
        once: true,
      });
      entered();
    })) as typeof fetch;
  const rejected = assert.rejects(
    listWebGroupNotices(f.session, '123', '456', fetchImpl, controller.signal),
    /HTTP request failed/,
  );
  await started;
  controller.abort();
  await rejected;
  assert.deepEqual(f.native, [['ticket', '']]);
});
test('HTTP notice path exchanges native ticket, gathers redirects and domain fallback, preserves exact query', async () => {
  const f = fixture([
    new Response(null, {
      status: 302,
      headers: { location: 'https://qun.qq.com/landing', 'set-cookie': 'skey=abc; Path=/' },
    }),
    new Response(null),
    success(),
  ]);
  const ret = await listWebGroupNotices(f.session, '123', '456', f.fetchImpl);
  assert.deepEqual(f.native, [
    ['ticket', ''],
    ['pskey', ['qun.qq.com'], true],
  ]);
  assert.equal(new URL(f.requests[0]!.url).searchParams.get('clientkey'), 'test-secret-key');
  assert.deepEqual(new URL(f.requests[2]!.url).searchParams.getAll('n'), ['1', '20']);
  assert.equal(new URL(f.requests[2]!.url).searchParams.get('bkn'), '193485963');
  assert.deepEqual(f.requests[2]!.init.headers, { Cookie: 'skey=abc; p_skey=test-domain-key' });
  assert.deepEqual(ret.notices[0]!.images, [{ id: 'image', width: '20', height: '30' }]);
  assert.equal(ret.notices[0]!.senderId, '123');
  assert.ok(!JSON.stringify(ret).includes('test-secret'));
});
test('cookie p_skey avoids unnecessary native domain key acquisition', async () => {
  const headers = new Headers();
  headers.append('set-cookie', 'skey=abc; Path=/');
  headers.append('set-cookie', 'p_skey=provided; Path=/');
  const f = fixture([new Response(null, { headers }), success()]);
  await listWebGroupNotices(f.session, '123', '456', f.fetchImpl);
  assert.deepEqual(f.native, [['ticket', '']]);
});
test('validation, redirects, response errors and fetch errors fail without credential leakage', async () => {
  const f = fixture([]);
  await assert.rejects(listWebGroupNotices(f.session, 'x', '456', f.fetchImpl), /numeric/);
  assert.equal(f.native.length, 0);
  const redirect = fixture([
    new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
  ]);
  await assert.rejects(
    listWebGroupNotices(redirect.session, '123', '456', redirect.fetchImpl),
    /redirect failed/,
  );
  assert.equal(redirect.requests.length, 1);
  const invalid = fixture([
    new Response(null, { headers: { 'set-cookie': 'skey=abc' } }),
    Response.json({ ec: 1, em: 'server details' }),
  ]);
  await assert.rejects(
    listWebGroupNotices(invalid.session, '123', '456', invalid.fetchImpl),
    /failure/,
  );
  await assert.rejects(
    listWebGroupNotices(f.session, '123', '456', (async () => {
      throw new Error('URL clientkey=test-secret-key');
    }) as typeof fetch),
    (error: Error) => error.message === 'Group notice HTTP request failed',
  );
});
