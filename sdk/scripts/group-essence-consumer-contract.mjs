import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Installed JavaScript contracts only: every ticket and HTTP response is synthetic. */
export async function verifyGroupEssenceConsumer(packageRoot) {
  const { listGroupEssenceMessages } = await import(
    pathToFileURL(join(packageRoot, 'dist/features/groups/group-essence-list.js')).href
  );
  const { prepareCommand } = await import(pathToFileURL(join(packageRoot, 'dist/cli.js')).href);
  const row = (sequence) => ({
    group_code: '123',
    msg_seq: sequence,
    msg_random: 4294967295,
    sender_uin: '18446744073709551615',
    sender_nick: 'fixture',
    sender_time: 1,
    add_digest_uin: '000456',
    add_digest_nick: 'operator',
    add_digest_time: 2,
    msg_content: [{ msg_type: 987654, text: 'fixture', image_url: 'https://example.test/image' }],
    can_be_removed: false,
  });
  const page = (sequence, end) => ({
    retcode: 0,
    data: {
      msg_list: sequence === undefined ? [] : [row(sequence)],
      is_end: end,
      group_role: 9876,
      config_page_url: 'https://example.test/?key=private-fixture-config',
    },
  });
  function fixture(pages) {
    const queries = [];
    let ticketCalls = 0;
    const context = {
      accountId: '789',
      signal: new AbortController().signal,
      awaitAlive: async (value) => value,
      getTicketService: () => ({
        forceFetchClientKey: async () => {
          ticketCalls++;
          return { result: 0, clientKey: 'private-fixture-ticket' };
        },
      }),
      getTipOffService: () => ({
        getPskey: async () => ({
          result: 0,
          domainPskeyMap: new Map([['qun.qq.com', 'private-fixture-domain']]),
        }),
      }),
      fetchImpl: async (url, init) => {
        assert.equal(init.redirect, 'manual');
        const parsed = new URL(url);
        if (parsed.hostname === 'ssl.ptlogin2.qq.com')
          return new Response(null, { headers: { 'set-cookie': 'skey=abc; Path=/' } });
        assert.equal(
          parsed.origin + parsed.pathname,
          'https://qun.qq.com/cgi-bin/group_digest/digest_list',
        );
        queries.push(Object.fromEntries(parsed.searchParams));
        assert.ok(queries.length <= pages.length, 'no extra page or retry');
        return Response.json(pages[queries.length - 1]);
      },
    };
    return { context, queries, tickets: () => ticketCalls };
  }
  const success = fixture([page(9, false), page(10, true)]);
  const messages = await listGroupEssenceMessages(success.context, '000123', { maxPages: 2 });
  assert.deepEqual(
    success.queries.map(({ page_start, page_limit, group_code }) => [
      page_start,
      page_limit,
      group_code,
    ]),
    [
      ['0', '50', '000123'],
      ['1', '50', '000123'],
    ],
  );
  assert.equal(success.tickets(), 2);
  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages.map((message) => message.sequence),
    [9, 10],
  );
  assert.equal(messages[0].senderId, '18446744073709551615');
  assert.equal(messages[0].operatorId, '000456');
  assert.equal(messages[0].removable, false);
  assert.deepEqual(messages[0].content, [
    { type: 987654, text: 'fixture', imageUrl: 'https://example.test/image' },
  ]);
  assert.ok(!JSON.stringify(messages).includes('private-fixture'));
  assert.ok(!JSON.stringify(messages).includes('config_page_url'));
  const empty = fixture([page(undefined, true)]);
  assert.deepEqual(await listGroupEssenceMessages(empty.context, '123'), []);
  assert.equal(empty.queries.length, 1);
  const exhausted = fixture([page(9, false), page(10, false)]);
  await assert.rejects(listGroupEssenceMessages(exhausted.context, '123', { maxPages: 2 }), {
    code: 'pagination-limit',
  });
  assert.equal(exhausted.queries.length, 2);
  const overlap = fixture([page(9, false), page(9, false)]);
  await assert.rejects(listGroupEssenceMessages(overlap.context, '123', { maxPages: 3 }), {
    code: 'inconsistent-pagination',
  });
  assert.equal(overlap.queries.length, 2);
  const calls = [];
  const action = await prepareCommand('group-essence-all', {
    'group-id': '000123',
    'max-pages': '2',
  });
  await action({ listGroupEssenceMessages: async (...args) => calls.push(args) });
  assert.deepEqual(calls, [['000123', { maxPages: 2 }]]);
  await assert.rejects(
    prepareCommand('group-essence-all', { 'group-id': '123', 'max-pages': '0' }),
  );
  return {
    groupEssenceFullPaginationContract: true,
    groupEssencePaginationLimitContract: true,
    groupEssenceOverlapContract: true,
    groupEssenceCredentialIsolationContract: true,
    groupEssenceInstalledCliContract: true,
    realGroupEssenceHttpAttempted: false,
  };
}
