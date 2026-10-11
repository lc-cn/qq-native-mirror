import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Installed JavaScript contracts only: every ticket and HTTP response is synthetic.
 * @param {string} packageRoot
 */
export async function verifyGroupEssenceConsumer(packageRoot) {
  /** @type {Promise<typeof import('../../src/features/groups/group-essence-list.ts')>} */
  const essenceModule = import(
    pathToFileURL(join(packageRoot, 'dist/features/groups/group-essence-list.js')).href
  );
  /** @type {Promise<typeof import('../../src/cli.ts')>} */
  const cliModule = import(pathToFileURL(join(packageRoot, 'dist/cli.js')).href);
  /** @type {Promise<typeof import('../../src/index.ts')>} */
  const clientModule = import(pathToFileURL(join(packageRoot, 'dist/index.js')).href);
  /** @type {Promise<typeof import('../../src/runtime/worker-termination.ts')>} */
  const terminationModule = import(
    pathToFileURL(join(packageRoot, 'dist/runtime/worker-termination.js')).href
  );
  const [{ listGroupEssenceMessages }, { prepareCommand }, { QQClient }, { terminateWorker }] =
    await Promise.all([essenceModule, cliModule, clientModule, terminationModule]);
  /** @param {number} sequence */
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
  /** @param {number|undefined} sequence
   * @param {boolean} end
   */
  const page = (sequence, end) => ({
    retcode: 0,
    data: {
      msg_list: sequence === undefined ? [] : [row(sequence)],
      is_end: end,
      group_role: 9876,
      config_page_url: 'https://example.test/?key=private-fixture-config',
    },
  });
  /** @param {ReturnType<typeof page>[]} pages */
  function fixture(pages) {
    /** @type {Record<string,string>[]} */
    const queries = [];
    let ticketCalls = 0;
    /** @type {import('../../src/features/groups/qun-web-read.ts').QunWebReadContext} */
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
        assert.equal(init?.redirect, 'manual');
        assert.ok(typeof url === 'string' || url instanceof URL);
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
  /** @satisfies {import('../../src/contracts/groups.ts').GroupEssenceMessage} */
  const expected = {
    groupId: '123',
    sequence: 9,
    random: 4294967295,
    senderId: '18446744073709551615',
    senderNickname: 'fixture',
    sentAt: 1,
    operatorId: '000456',
    operatorNickname: 'operator',
    setAt: 2,
    content: [{ type: 987654, text: 'fixture', imageUrl: 'https://example.test/image' }],
    removable: false,
  };
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
  assert.deepEqual(messages, [expected, { ...expected, sequence: 10 }]);
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
  const action = await prepareCommand('group-essence-all', {
    'group-id': '000123',
    'max-pages': '2',
  });
  const directory = await mkdtemp(join(tmpdir(), 'qq-essence-worker-'));
  /** @type {import('../../src/index.ts').QQClient|undefined} */
  let client;
  /** @type {import('node:child_process').ChildProcess|undefined} */
  let child;
  try {
    const kernelUrl = pathToFileURL(await realpath(join(packageRoot, 'dist/kernel.js'))).href;
    const hook = join(directory, 'hook.mjs');
    await writeFile(
      hook,
      `import {registerHooks} from 'node:module';process.dlopen=()=>{};registerHooks({load(url,context,next){if(url!==${JSON.stringify(kernelUrl)})return next(url,context);return {format:'module',shortCircuit:true,source:${JSON.stringify(`export function createKernel(native,options,emit){return {async prepare(){},async close(){},async login(){const account={uin:'123',uid:'u_fixture'};emit('ready',account);return account;},async invokeOperation(method,payload){if(method!=='listGroupEssenceMessages'||payload.groupId!=='000123'||payload.options?.maxPages!==2)throw Error('Unexpected essence RPC');return ${JSON.stringify(messages)};}}}`)}}}});`,
    );
    child = fork(join(packageRoot, 'dist/worker.js'), [], {
      execArgv: ['--import', pathToFileURL(hook).href],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    client = new QQClient(child, 5000);
    await client.request('init', {
      options: {
        dataDir: directory,
        wrapperPath: join(directory, 'fixture.node'),
        version: '7.0.2-53644',
        preloadLibraries: [],
      },
    });
    await client.login({ method: 'restore', uin: '123' });
    // The actual installed facade preserves the full public DTO through worker IPC.
    const received = await action(client);
    assert.deepEqual(received, [expected, { ...expected, sequence: 10 }]);
    const completedClient = client;
    client = undefined;
    await completedClient.close();
    assert.equal(completedClient.state, 'closed');
  } finally {
    try {
      if (client) await client.close();
    } finally {
      try {
        // Reuse the worker owner's bounded termination rather than waiting forever
        // if setup failed before the facade took ownership of the child.
        if (child) await terminateWorker(child);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
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
    nativeExecuted: false,
    accountUsed: false,
  };
}
