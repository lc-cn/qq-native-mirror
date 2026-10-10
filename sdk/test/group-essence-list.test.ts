import assert from 'node:assert/strict';
import test from 'node:test';
import { captureGroupEssencePage } from '../src/features/groups/group-essence-input.ts';
import { requestQunPage } from '../src/features/groups/qun-web-read.ts';
import { getGroupEssencePage } from '../src/features/groups/group-essence-list.ts';
import { createNativeServices } from '../src/native-services.ts';
import { prepareCommand, validateCommandFlags } from '../src/cli/command-plan.ts';

const row = () => ({
  group_code: '123',
  msg_seq: 9,
  msg_random: 4294967295,
  sender_uin: '18446744073709551615',
  sender_nick: 'sender',
  sender_time: 1,
  add_digest_uin: '456',
  add_digest_nick: 'operator',
  add_digest_time: 2,
  msg_content: [{ msg_type: 987654, text: 'text', image_url: 'https://example.test/image' }],
  can_be_removed: false,
});
const reply = () => ({
  retcode: 0,
  retmsg: 'unused',
  data: {
    msg_list: [row()],
    is_end: false,
    group_role: 9876,
    config_page_url: 'https://example.test/?key=synthetic-private-config',
  },
});
function fixture(raw: unknown = reply()) {
  const requests: { url: URL; init: RequestInit }[] = [];
  const native: unknown[][] = [];
  const session = {
    getTicketService: () => ({
      forceFetchClientKey: async (...args: unknown[]) => {
        native.push(['ticket', ...args]);
        return { result: 0, clientKey: 'synthetic-ticket' };
      },
    }),
    getTipOffService: () => ({
      getPskey: async (...args: unknown[]) => {
        native.push(['pskey', ...args]);
        return { result: 0, domainPskeyMap: new Map([['qun.qq.com', 'synthetic-domain']]) };
      },
    }),
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url: new URL(url), init });
    if (requests.length === 1)
      return new Response(null, { headers: { 'set-cookie': 'skey=abc; Path=/' } });
    assert.equal(requests.length, 2, 'no retry or speculative native fallback');
    return { ok: true, json: async () => raw } as Response;
  }) as typeof fetch;
  const context = {
    getTicketService: () => session.getTicketService(),
    getTipOffService: () => session.getTipOffService(),
    accountId: '789',
    fetchImpl,
    signal: new AbortController().signal,
    awaitAlive: async <T>(value: T | PromiseLike<T>) => value,
  };
  return { context, session, native, requests };
}

test('one HTTP page preserves identifiers, content, flags and exact query while withholding credentials', async () => {
  const f = fixture();
  const result = await getGroupEssencePage(f.context, '000123', { pageStart: 17, pageLimit: 2 });
  assert.deepEqual(f.native, [
    ['ticket', ''],
    ['pskey', ['qun.qq.com'], true],
  ]);
  assert.equal(
    f.requests[1]!.url.origin + f.requests[1]!.url.pathname,
    'https://qun.qq.com/cgi-bin/group_digest/digest_list',
  );
  assert.deepEqual(Object.fromEntries(f.requests[1]!.url.searchParams), {
    bkn: '193485963',
    page_start: '17',
    page_limit: '2',
    group_code: '000123',
  });
  assert.equal(result.pageStart, 17);
  assert.equal(result.pageLimit, 2);
  assert.equal(result.isEnd, false);
  assert.equal(result.groupRole, 9876);
  assert.equal(result.messages[0]!.senderId, '18446744073709551615');
  assert.equal(result.messages[0]!.operatorId, '456');
  assert.deepEqual(result.messages[0]!.content, [
    { type: 987654, text: 'text', imageUrl: 'https://example.test/image' },
  ]);
  assert.equal(result.messages[0]!.removable, false);
  assert.equal('messageId' in result.messages[0]!, false);
  assert.ok(!JSON.stringify(result).includes('synthetic-'));
  assert.equal(f.requests.length, 2, 'isEnd=false does not start an inferred next page');
});

test('an explicit empty terminal page is preserved without inventing messages or identities', async () => {
  const raw = reply();
  raw.data.msg_list = [];
  raw.data.is_end = true;
  const f = fixture(raw);
  assert.deepEqual(await getGroupEssencePage(f.context, '123'), {
    groupId: '123',
    pageStart: 0,
    pageLimit: 50,
    messages: [],
    isEnd: true,
    groupRole: 9876,
  });
});

for (const [group, options] of [
  ['0', undefined],
  ['123', null],
  ['123', []],
  ['123', { pageStart: -1 }],
  ['123', { pageStart: 4294967296 }],
  ['123', { pageStart: '0' }],
  ['123', { pageLimit: 0 }],
  ['123', { pageLimit: 51 }],
  ['123', { pageLimit: null }],
] as const)
  test(`invalid essence pagination ${JSON.stringify([group, options])} fails before ticket or HTTP`, async () => {
    const f = fixture();
    await assert.rejects(getGroupEssencePage(f.context, group, options));
    assert.equal(f.native.length, 0);
    assert.equal(f.requests.length, 0);
  });

test('input options are copied before native awaits without executing getters or coercion', async () => {
  let getter = 0;
  assert.throws(
    () =>
      captureGroupEssencePage('123', {
        get pageStart() {
          getter++;
          return 0;
        },
      }),
    /data property/,
  );
  assert.equal(getter, 0);
  const f = fixture();
  const options = { pageStart: 1, pageLimit: 2 };
  const operation = getGroupEssencePage(f.context, '123', options);
  options.pageStart = 99;
  assert.equal((await operation).pageStart, 1);
});

for (const corrupt of [
  (raw: any) => {
    raw.retcode = '0';
  },
  (raw: any) => {
    raw.data.is_end = 1;
  },
  (raw: any) => {
    raw.data.msg_list[0].group_code = '124';
  },
  (raw: any) => {
    raw.data.msg_list[0].msg_seq = '9';
  },
  (raw: any) => {
    raw.data.msg_list[0].sender_uin = 123;
  },
  (raw: any) => {
    raw.data.msg_list[0].add_digest_uin = undefined;
  },
  (raw: any) => {
    raw.data.msg_list[0].msg_content[0].text = false;
  },
  (raw: any) => {
    raw.data.msg_list.push(row());
  },
])
  test('malformed or ambiguous page rejects the complete result', async () => {
    const raw = reply();
    corrupt(raw);
    const f = fixture(raw);
    await assert.rejects(
      getGroupEssencePage(f.context, '123'),
      (error: any) => error.code === 'invalid-result',
    );
    assert.equal(f.requests.length, 2);
  });

test('HTTP business failure retains only the numeric code, with no success result or ticket wording', async () => {
  const f = fixture({ retcode: 11007, retmsg: 'synthetic-ticket' });
  await assert.rejects(
    getGroupEssencePage(f.context, '123'),
    (error: any) => error.code === 11007 && !error.message.includes('synthetic'),
  );
});

test('accessor or sparse response fields are rejected without invoking them', async () => {
  const raw = reply();
  let accessed = 0;
  Object.defineProperty(raw.data, 'is_end', {
    get() {
      accessed++;
      return true;
    },
  });
  await assert.rejects(getGroupEssencePage(fixture(raw).context, '123'));
  assert.equal(accessed, 0);
  const missing = reply();
  delete (missing.data.msg_list as any)[0];
  await assert.rejects(getGroupEssencePage(fixture(missing).context, '123'));
});

test('close during native ticket wait prevents HTTP and suppresses a late result', async () => {
  const controller = new AbortController();
  let release!: (value: unknown) => void;
  const ticket = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture();
  f.context.getTicketService = () => ({ forceFetchClientKey: () => ticket as any });
  const operation = getGroupEssencePage({ ...f.context, signal: controller.signal }, '123');
  const rejected = assert.rejects(operation, /cancelled/);
  controller.abort();
  release({ result: 0, clientKey: 'synthetic-ticket' });
  await rejected;
  assert.equal(f.requests.length, 0);
});

test('actual service dispatch chooses HTTP/ticket path and never calls the native stub', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = f.context.fetchImpl;
  const services = createNativeServices({
    session: {
      ...f.session,
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getGroupService: () => ({
        addKernelGroupListener() {},
        fetchGroupEssenceList() {
          throw new Error('native stub must not dispatch');
        },
      }),
    },
    version: 'fixture',
    identity: { userId: '789' },
    events: { emit() {} },
  });
  try {
    const page = await services.invokeOperation('getGroupEssencePage', {
      groupId: '123',
      options: { pageStart: 17, pageLimit: 2 },
    });
    assert.equal((page as any).messages[0].operatorId, '456');
    assert.equal(f.requests.length, 2);
  } finally {
    services.close();
    globalThis.fetch = original;
  }
});

test('CLI preflights complete pagination and captures flags before login', async () => {
  const flags = { 'group-id': '123', 'page-start': '17', 'page-limit': '2' };
  validateCommandFlags('group-essence-list', flags);
  const action = await prepareCommand('group-essence-list', flags);
  flags['page-start'] = '99';
  const calls: unknown[] = [];
  await action({ getGroupEssencePage: async (...args: unknown[]) => calls.push(args) } as any);
  assert.deepEqual(calls, [['123', { pageStart: 17, pageLimit: 2 }]]);
  for (const value of ['', '2e1', '-1', '0.5'])
    await assert.rejects(
      prepareCommand('group-essence-list', { 'group-id': '123', 'page-start': value }),
    );
  assert.throws(
    () => validateCommandFlags('group-essence-list', { ...flags, unknown: '1' }),
    /Unknown option/,
  );
});

test('malformed cookie redirect errors never contain the native ticket or redirect input', async () => {
  const f = fixture();
  const fetchImpl = (async () =>
    new Response(null, {
      status: 302,
      headers: { location: 'https://[synthetic-ticket' },
    })) as typeof fetch;
  await assert.rejects(
    getGroupEssencePage({ ...f.context, fetchImpl }, '123'),
    (error) =>
      error instanceof Error &&
      /cookie redirect failed/.test(error.message) &&
      !error.message.includes('synthetic'),
  );
});

for (const endpoint of ['notices', 'essence'] as const)
  test(`${endpoint}: cookie response cancellation failure cannot expose ticket-bearing errors`, async () => {
    const f = fixture();
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          cancel() {
            throw new Error('https://example.test/?clientkey=synthetic-ticket');
          },
        }),
      )) as typeof fetch;
    await assert.rejects(
      requestQunPage({ ...f.context, fetchImpl }, endpoint, new URLSearchParams()),
      (error) =>
        error instanceof Error &&
        /cookie exchange failed/.test(error.message) &&
        !error.message.includes('synthetic'),
    );
  });
