import assert from 'node:assert/strict';
import test from 'node:test';
import { captureGroupEssenceList } from '../src/features/groups/group-essence-input.ts';
import { listGroupEssenceMessages } from '../src/features/groups/group-essence-list.ts';
import { prepareCommand, validateCommandFlags } from '../src/cli/command-plan.ts';
import type { QQClient } from '../src/index.ts';
import { createNativeServices } from '../src/native-services.ts';

function row(sequence: number, random = 1) {
  return {
    group_code: '123',
    msg_seq: sequence,
    msg_random: random,
    sender_uin: '18446744073709551615',
    sender_nick: 'sender',
    sender_time: 1,
    add_digest_uin: '456',
    add_digest_nick: 'operator',
    add_digest_time: 2,
    msg_content: [{ msg_type: 987654, text: 'text' }],
    can_be_removed: false,
  };
}
function page(sequences: number[], end: boolean) {
  return {
    retcode: 0,
    retmsg: 'synthetic-private-wording',
    data: {
      msg_list: sequences.map((sequence) => row(sequence)),
      is_end: end,
      group_role: 2,
      config_page_url: 'https://example.test/?ticket=synthetic-private-config',
    },
  };
}
function fixture(pages: unknown[]) {
  const requested: URL[] = [];
  let tickets = 0;
  const session = {
    getTicketService: () => ({
      forceFetchClientKey: async () => {
        tickets++;
        return { result: 0, clientKey: 'synthetic-private-ticket' };
      },
    }),
  };
  const fetchImpl = (async (url: string) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'ssl.ptlogin2.qq.com') {
      const headers = new Headers();
      headers.append('set-cookie', 'skey=abc; Path=/');
      headers.append('set-cookie', 'p_skey=synthetic-private-domain; Path=/');
      return new Response(null, { headers });
    }
    requested.push(parsed);
    assert.ok(requested.length <= pages.length, 'no extra page after failure or termination');
    return { ok: true, json: async () => pages[requested.length - 1] } as Response;
  }) as typeof fetch;
  return { context: { session, accountId: '789', fetchImpl }, requested, tickets: () => tickets };
}

test('complete read uses numbered 50-row pages and stops on the explicit end marker', async () => {
  const f = fixture([page([9, 10], false), page([11], true)]);
  const result = await listGroupEssenceMessages(f.context, '000123');
  assert.deepEqual(
    result.map((message) => message.sequence),
    [9, 10, 11],
  );
  assert.deepEqual(
    f.requested.map((url) => Object.fromEntries(url.searchParams)),
    [
      { bkn: '193485963', page_start: '0', page_limit: '50', group_code: '000123' },
      { bkn: '193485963', page_start: '1', page_limit: '50', group_code: '000123' },
    ],
  );
  assert.equal(f.tickets(), 2, 'each page acquires credentials through the existing transport');
  assert.equal(result[0]!.senderId, '18446744073709551615');
  assert.deepEqual(result[0]!.content, [{ type: 987654, text: 'text' }]);
  assert.equal(result[0]!.removable, false);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|config_page_url|clientKey/);
});

test('empty nonterminal pages keep reading; an empty terminal page returns the complete list', async () => {
  const f = fixture([page([], false), page([9], false), page([], true)]);
  assert.deepEqual(
    (await listGroupEssenceMessages(f.context, '123')).map((value) => value.sequence),
    [9],
  );
  assert.equal(f.requested.length, 3);
  assert.deepEqual(await listGroupEssenceMessages(fixture([page([], true)]).context, '123'), []);
});

test('the last allowed terminal page succeeds, while a missing end marker rejects without another request', async () => {
  const terminal = fixture([page([9], false), page([10], true)]);
  assert.equal(
    (await listGroupEssenceMessages(terminal.context, '123', { maxPages: 2 })).length,
    2,
  );
  const limited = fixture([page([9], false), page([10], false)]);
  await assert.rejects(listGroupEssenceMessages(limited.context, '123', { maxPages: 2 }), {
    code: 'pagination-limit',
  });
  assert.equal(limited.requested.length, 2);
});

test('the default 20-page budget never reports an unterminated traversal as complete', async () => {
  const f = fixture(Array.from({ length: 20 }, (_, index) => page([index], false)));
  await assert.rejects(listGroupEssenceMessages(f.context, '123'), { code: 'pagination-limit' });
  assert.equal(f.requested.length, 20);
});

test('a later server failure preserves only its error code and discards accumulated results', async () => {
  const f = fixture([page([9], false), { retcode: 11007, retmsg: 'synthetic-private-wording' }]);
  await assert.rejects(
    listGroupEssenceMessages(f.context, '123'),
    (error: Error & { code?: number }) => {
      assert.equal(error.code, 11007);
      assert.doesNotMatch(error.message, /synthetic-private|sender/);
      return true;
    },
  );
  assert.equal(f.requested.length, 2);
});

test('a malformed later page rejects instead of exposing a valid prefix', async () => {
  const bad = page([10], true);
  bad.data.msg_list[0]!.group_code = '999';
  const f = fixture([page([9], false), bad]);
  await assert.rejects(listGroupEssenceMessages(f.context, '123'), { code: 'invalid-result' });
  assert.equal(f.requested.length, 2);
});

test('overlapping page identities reject rather than silently deduplicating a changing traversal', async () => {
  const f = fixture([page([9], false), page([9], true)]);
  await assert.rejects(listGroupEssenceMessages(f.context, '123'), {
    code: 'inconsistent-pagination',
  });
  const next = page([9], true);
  next.data.msg_list[0]!.msg_random = 2;
  assert.equal(
    (await listGroupEssenceMessages(fixture([page([9], false), next]).context, '123')).length,
    2,
  );
});

for (const options of [
  null,
  [],
  { maxPages: 0 },
  { maxPages: 1001 },
  { maxPages: 1.5 },
  { maxPages: '2' },
])
  test(`invalid full read budget ${JSON.stringify(options)} fails before native tickets`, async () => {
    const f = fixture([]);
    await assert.rejects(listGroupEssenceMessages(f.context, '123', options));
    assert.equal(f.tickets(), 0);
    assert.equal(f.requested.length, 0);
  });

test('full read budget is captured before awaiting the first ticket and accessors never execute', async () => {
  let resume!: () => void;
  const wait = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const f = fixture([page([9], false)]);
  const original = f.context.session.getTicketService;
  f.context.session.getTicketService = () => ({
    forceFetchClientKey: async () => {
      await wait;
      return original().forceFetchClientKey();
    },
  });
  const options = { maxPages: 1 };
  const result = listGroupEssenceMessages(f.context, '123', options);
  options.maxPages = 2;
  resume();
  await assert.rejects(result, { code: 'pagination-limit' });
  assert.equal(f.requested.length, 1);
  let getters = 0;
  assert.throws(
    () =>
      captureGroupEssenceList('123', {
        get maxPages() {
          getters++;
          return 2;
        },
      }),
    /data property/,
  );
  assert.equal(getters, 0);
  assert.deepEqual(captureGroupEssenceList('123', { maxPages: undefined }), {
    groupId: '123',
    maxPages: 20,
  });
});

test('close after an HTTP response prevents the next page and suppresses the accumulated list', async () => {
  const abort = new AbortController();
  const f = fixture([page([9], false)]);
  const original = f.context.fetchImpl;
  f.context.fetchImpl = (async (...args: Parameters<typeof fetch>) => {
    const response = await original(...args);
    if (f.requested.length) abort.abort(new Error('Session closed'));
    return response;
  }) as typeof fetch;
  await assert.rejects(
    listGroupEssenceMessages({ ...f.context, signal: abort.signal }, '123'),
    /Group essence HTTP request failed/,
  );
  assert.equal(f.requested.length, 1);
  assert.equal(f.tickets(), 1);
});

test('native dispatch uses the full HTTP reader and guarded account lifetime, never the native stub', async () => {
  const f = fixture([page([9], false), page([10], true)]);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = f.context.fetchImpl;
  const services = createNativeServices({
    session: {
      ...f.context.session,
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getGroupService: () => ({
        addKernelGroupListener() {},
        fetchGroupEssenceList() {
          throw new Error('Native stub must not dispatch');
        },
      }),
    },
    version: 'fixture',
    identity: { userId: '789' },
    events: { emit() {} },
  });
  try {
    const messages = await services.invokeOperation('listGroupEssenceMessages', {
      groupId: '123',
      options: { maxPages: 2 },
    });
    assert.deepEqual(
      (messages as { sequence: number }[]).map((message) => message.sequence),
      [9, 10],
    );
    assert.equal(f.requested.length, 2);
    services.close();
    await assert.rejects(
      services.invokeOperation('listGroupEssenceMessages', { groupId: '123' }),
      /closed/,
    );
    assert.equal(f.tickets(), 2);
  } finally {
    services.close();
    globalThis.fetch = previousFetch;
  }
});

test('CLI full read captures the budget and rejects page flags before client creation', async () => {
  const flags = { 'group-id': '123', 'max-pages': '2' };
  validateCommandFlags('group-essence-all', flags);
  const action = await prepareCommand('group-essence-all', flags);
  flags['max-pages'] = '999';
  const calls: unknown[][] = [];
  await action({
    listGroupEssenceMessages: async (...args: unknown[]) => {
      calls.push(args);
      return [];
    },
  } as unknown as QQClient);
  assert.deepEqual(calls, [['123', { maxPages: 2 }]]);
  for (const value of ['', '-1', '1e2', '0', '1001'])
    await assert.rejects(
      prepareCommand('group-essence-all', { 'group-id': '123', 'max-pages': value }),
    );
  assert.throws(() => validateCommandFlags('group-essence-all', { 'page-start': '1' }));
});

for (const method of [
  'getGroupEssencePage',
  'listGroupEssenceMessages',
  'listGroupNotices',
] as const)
  test(
    `${method}: service close interrupts a stalled native ticket wait`,
    { timeout: 5000 },
    async () => {
      let tickets = 0;
      let httpCalls = 0;
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        httpCalls++;
        throw new Error('Unexpected HTTP after close');
      };
      let settle!: (value: unknown) => void;
      const pending = new Promise((resolve) => {
        settle = resolve;
      });
      const services = createNativeServices({
        session: {
          getTicketService: () => ({
            forceFetchClientKey: () => {
              tickets++;
              return pending;
            },
          }),
          getBuddyService: () => ({ addKernelBuddyListener() {} }),
          getMsgService: () => ({ addKernelMsgListener() {} }),
          getGroupService: () => ({ addKernelGroupListener() {} }),
        },
        version: 'fixture',
        identity: { userId: '789' },
        events: { emit() {} },
      });
      try {
        const result = services.invokeOperation(method, { groupId: '123' });
        assert.equal(tickets, 1);
        services.close();
        await assert.rejects(result, /closed/);
        // The issued native call is not cancelled. Its late completion is observed,
        // and the feature's own signal guard prevents the first HTTP request.
        settle({ result: 0, clientKey: 'synthetic-private-ticket' });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(tickets, 1);
        assert.equal(httpCalls, 0);
      } finally {
        services.close();
        globalThis.fetch = previousFetch;
      }
    },
  );
