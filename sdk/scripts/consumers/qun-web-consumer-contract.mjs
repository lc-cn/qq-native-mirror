import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Installed compiled transports and composition, controlled native/HTTP ports only. */
/** @param {string} installedRoot */
export async function verifyQunWebConsumer(installedRoot) {
  const [
    { requestQunPage },
    { listWebGroupNotices },
    { createNativeServices },
    { prepareCommand },
  ] = await Promise.all([
    /** @type {Promise<typeof import('../../src/features/groups/qun-web-read.ts')>} */ (
      import(pathToFileURL(join(installedRoot, 'dist/features/groups/qun-web-read.js')).href)
    ),
    /** @type {Promise<typeof import('../../src/features/groups/web-group-notices.ts')>} */ (
      import(pathToFileURL(join(installedRoot, 'dist/features/groups/web-group-notices.js')).href)
    ),
    /** @type {Promise<typeof import('../../src/native-services.ts')>} */ (
      import(pathToFileURL(join(installedRoot, 'dist/native-services.js')).href)
    ),
    /** @type {Promise<typeof import('../../src/cli.ts')>} */ (
      import(pathToFileURL(join(installedRoot, 'dist/cli.js')).href)
    ),
  ]);
  /** @template [T=unknown]
   * @returns {{promise:Promise<T>,resolve(value?:T):void,reject(reason:unknown):void}} */
  const deferred = () => {
    /** @type {(value?:T)=>void} */
    let resolve = () => assert.fail('Deferred resolver not initialized');
    /** @type {(reason:unknown)=>void} */
    let reject = () => assert.fail('Deferred rejecter not initialized');
    /** @type {Promise<T>} */
    const promise = new Promise((a, b) => {
      resolve = (value) => a(/** @type {T} */ (value));
      reject = b;
    });
    return { promise, resolve, reject };
  };
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  /** @template T
   * @param {Promise<T>} promise
   * @returns {Promise<T>} */
  const bounded = async (promise) => {
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('Qun settlement deadline exceeded')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  /** @param {Promise<unknown>} promise */
  const safeFailure = async (promise) =>
    assert.rejects(bounded(promise), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(typeof error.message, 'string');
      assert.notEqual(error.message, 'Qun settlement deadline exceeded');
      assert.ok(!error.message.includes('synthetic-sensitive'));
      return true;
    });
  const body = {
    ec: 0,
    feeds: [{ fid: 'notice', u: 456, pubt: 100, msg: { text: 'fixture', pics: [] } }],
  };
  /** @param {PropertyDescriptorMap} properties */
  const responseWith = (properties) => Object.defineProperties(new Response(null), properties);
  const fixture = () => {
    const controller = new AbortController();
    /** @type {[string,...unknown[]][]} */
    const calls = [];
    /** @type {Required<import('../../src/features/groups/qun-web-read.ts').QunTicketPort>} */
    const ticket = {
      forceFetchClientKey(value) {
        assert.equal(this, ticket);
        calls.push(['ticket', value]);
        return { result: 0, clientKey: 'synthetic-sensitive-client' };
      },
    };
    /** @type {Required<import('../../src/features/groups/qun-web-read.ts').QunDomainKeyPort>} */
    const tip = {
      getPskey(...args) {
        assert.equal(this, tip);
        calls.push(['pskey', ...args]);
        return {
          result: 0,
          domainPskeyMap: new Map([['qun.qq.com', 'synthetic-sensitive-domain']]),
        };
      },
    };
    /** @type {{-readonly [K in keyof import('../../src/features/groups/qun-web-read.ts').QunWebReadContext]:import('../../src/features/groups/qun-web-read.ts').QunWebReadContext[K]} & {fetchImpl:typeof fetch}} */
    const context = {
      accountId: '789',
      signal: controller.signal,
      awaitAlive: async (value) => value,
      getTicketService: () => ticket,
      getTipOffService: () => tip,
      fetchImpl: async (url, init) => {
        assert.equal(init?.redirect, 'manual');
        const parsed = new URL(url instanceof Request ? url.url : url);
        calls.push(['http', parsed]);
        if (parsed.hostname === 'ssl.ptlogin2.qq.com')
          return new Response(null, { headers: { 'set-cookie': 'skey=abc; Path=/' } });
        return Response.json(body);
      },
    };
    return { controller, calls, ticket, tip, context };
  };
  const normal = fixture();
  /** @type {URLSearchParams|undefined} */
  let capturedQuery;
  const notices = await listWebGroupNotices(
    {
      accountId: '789',
      signal: normal.controller.signal,
      readPage: (params) => {
        capturedQuery = new URLSearchParams(params);
        return requestQunPage(normal.context, 'notices', params);
      },
    },
    '123',
  );
  assert.equal(notices.notices[0].noticeId, 'notice');
  assert.deepEqual(
    [...(assert.ok(capturedQuery), capturedQuery)],
    [
      ['qid', '123'],
      ['ft', '23'],
      ['ni', '1'],
      ['n', '1'],
      ['i', '1'],
      ['log_read', '1'],
      ['platform', '1'],
      ['s', '-1'],
      ['n', '20'],
    ],
  );
  assert.deepEqual(
    normal.calls.filter(([name]) => name !== 'http'),
    [
      ['ticket', ''],
      ['pskey', ['qun.qq.com'], true],
    ],
  );
  const listUrl = normal.calls.filter(([name]) => name === 'http')[1][1];
  assert.ok(listUrl instanceof URL);
  assert.equal(
    listUrl.origin + listUrl.pathname,
    'https://web.qun.qq.com/cgi-bin/announce/get_t_list',
  );
  assert.deepEqual(listUrl.searchParams.getAll('n'), ['1', '20']);
  const essence = fixture();
  await requestQunPage(
    essence.context,
    'essence',
    new URLSearchParams({ group_code: '123', page_start: '0', page_limit: '50' }),
  );
  const essenceUrl = essence.calls.filter(([name]) => name === 'http')[1][1];
  assert.ok(essenceUrl instanceof URL);
  assert.equal(
    essenceUrl.origin + essenceUrl.pathname,
    'https://qun.qq.com/cgi-bin/group_digest/digest_list',
  );
  const snapshot = fixture(),
    ticketWait = deferred();
  snapshot.ticket.forceFetchClientKey = () => ticketWait.promise;
  const parameters = new URLSearchParams('qid=123&n=1&n=20');
  const snapshotPromise = requestQunPage(snapshot.context, 'notices', parameters);
  parameters.set('qid', '999');
  parameters.delete('n');
  ticketWait.resolve({ result: 0, clientKey: 'synthetic-sensitive-client' });
  await snapshotPromise;
  const frozenUrl = snapshot.calls.filter(([name]) => name === 'http')[1][1];
  assert.ok(frozenUrl instanceof URL);
  assert.equal(frozenUrl.searchParams.get('qid'), '123');
  assert.deepEqual(frozenUrl.searchParams.getAll('n'), ['1', '20']);
  for (const stage of ['ticket', 'pskey', 'http', 'json']) {
    const f = fixture(),
      pending = deferred(),
      began = deferred();
    if (stage === 'ticket')
      f.ticket.forceFetchClientKey = () => {
        began.resolve();
        return pending.promise;
      };
    if (stage === 'pskey')
      f.tip.getPskey = () => {
        began.resolve();
        return pending.promise;
      };
    if (stage === 'http')
      f.context.fetchImpl = () => {
        began.resolve();
        return pending.promise.then((value) => {
          assert.ok(value instanceof Response);
          return value;
        });
      };
    if (stage === 'json') {
      const prior = f.context.fetchImpl;
      f.context.fetchImpl = async (...args) => {
        const response = await prior(...args);
        if (
          new URL(args[0] instanceof Request ? args[0].url : args[0]).hostname ===
          'ssl.ptlogin2.qq.com'
        )
          return response;
        return responseWith({
          json: {
            value: () => {
              began.resolve();
              return pending.promise;
            },
          },
        });
      };
    }
    const read = requestQunPage(f.context, 'notices', new URLSearchParams('qid=123'));
    await bounded(began.promise);
    f.controller.abort(Error('Synthetic cancelled'));
    await safeFailure(read);
    pending.reject(Error('synthetic-sensitive late failure'));
    await turn();
    const httpCalls = f.calls.filter(([name]) => name === 'http').length;
    assert.ok(httpCalls <= (stage === 'json' ? 2 : stage === 'pskey' ? 1 : 0));
  }
  for (const stage of ['ticket-service', 'ticket-method', 'pskey-service', 'pskey-method']) {
    const f = fixture();
    let dispatches = 0;
    const close = () => f.controller.abort(Error('Synthetic cancelled'));
    if (stage === 'ticket-service')
      f.context.getTicketService = () => {
        close();
        return f.ticket;
      };
    if (stage === 'ticket-method')
      Object.defineProperty(f.ticket, 'forceFetchClientKey', {
        get() {
          close();
          return () => {
            dispatches++;
          };
        },
      });
    if (stage === 'pskey-service')
      f.context.getTipOffService = () => {
        close();
        return f.tip;
      };
    if (stage === 'pskey-method')
      Object.defineProperty(f.tip, 'getPskey', {
        get() {
          close();
          return () => {
            dispatches++;
          };
        },
      });
    await safeFailure(requestQunPage(f.context, 'notices', new URLSearchParams('qid=123')));
    assert.equal(dispatches, 0);
    assert.equal(f.calls.filter(([name]) => name === 'pskey').length, 0);
    if (stage.startsWith('ticket'))
      assert.equal(f.calls.filter(([name]) => name === 'http').length, 0);
  }
  for (const stage of ['ticket-result', 'ticket-key', 'pskey-map', 'map-get']) {
    const f = fixture();
    const fail = () => {
      throw Error('synthetic-sensitive accessor');
    };
    if (stage === 'ticket-result')
      f.ticket.forceFetchClientKey = () => ({
        get result() {
          return fail();
        },
      });
    if (stage === 'ticket-key')
      f.ticket.forceFetchClientKey = () => ({
        result: 0,
        get clientKey() {
          return fail();
        },
      });
    if (stage === 'pskey-map')
      f.tip.getPskey = () => ({
        result: 0,
        get domainPskeyMap() {
          return fail();
        },
      });
    if (stage === 'map-get') {
      const map = new Map();
      Object.defineProperty(map, 'get', { get: fail });
      f.tip.getPskey = () => ({ result: 0, domainPskeyMap: map });
    }
    await safeFailure(requestQunPage(f.context, 'notices', new URLSearchParams('qid=123')));
  }
  const late = fixture(),
    lateResponse = deferred(),
    lateBegan = deferred(),
    cancellation = deferred();
  let cancelledBodies = 0;
  late.context.fetchImpl = () => {
    lateBegan.resolve();
    return lateResponse.promise.then((value) => {
      assert.ok(value instanceof Response);
      return value;
    });
  };
  const lateRead = requestQunPage(late.context, 'notices', new URLSearchParams('qid=123'));
  await bounded(lateBegan.promise);
  late.controller.abort(Error('Synthetic cancelled'));
  await safeFailure(lateRead);
  lateResponse.resolve(
    responseWith({
      body: {
        value: {
          cancel() {
            cancelledBodies++;
            return cancellation.promise;
          },
        },
      },
    }),
  );
  await turn();
  assert.equal(cancelledBodies, 1);
  cancellation.reject(Error('synthetic-sensitive late body cancellation'));
  await turn();
  assert.equal(cancelledBodies, 1);
  for (const field of ['headers', 'ok', 'location']) {
    const f = fixture();
    f.context.fetchImpl = async () => {
      if (field === 'headers')
        return responseWith({
          headers: {
            get() {
              throw Error('synthetic-sensitive headers');
            },
          },
        });
      if (field === 'ok')
        return responseWith({
          ok: {
            get() {
              throw Error('synthetic-sensitive ok');
            },
          },
        });
      const headers = new Headers();
      headers.get = () => {
        throw Error('synthetic-sensitive location');
      };
      return responseWith({ headers: { value: headers }, status: { value: 302 } });
    };
    await safeFailure(requestQunPage(f.context, 'notices', new URLSearchParams('qid=123')));
  }
  for (const stage of ['fetch', 'body', 'json']) {
    const f = fixture(),
      timeoutController = new AbortController(),
      began = deferred(),
      stalled = deferred();
    const originalTimeout = AbortSignal.timeout;
    AbortSignal.timeout = () => timeoutController.signal;
    try {
      if (stage === 'fetch')
        f.context.fetchImpl = () => {
          began.resolve();
          return stalled.promise.then((value) => {
            assert.ok(value instanceof Response);
            return value;
          });
        };
      if (stage === 'body')
        f.context.fetchImpl = async () =>
          responseWith({
            body: {
              value: {
                cancel() {
                  began.resolve();
                  return stalled.promise;
                },
              },
            },
          });
      if (stage === 'json') {
        const originalFetch = f.context.fetchImpl;
        f.context.fetchImpl = async (...args) => {
          const response = await originalFetch(...args);
          if (
            new URL(args[0] instanceof Request ? args[0].url : args[0]).hostname ===
            'ssl.ptlogin2.qq.com'
          )
            return response;
          return responseWith({
            json: {
              value: () => {
                began.resolve();
                return stalled.promise;
              },
            },
          });
        };
      }
      const pending = requestQunPage(f.context, 'notices', new URLSearchParams('qid=123'));
      await bounded(began.promise);
      timeoutController.abort(Error('Synthetic timeout'));
      await safeFailure(pending);
      assert.equal(f.controller.signal.aborted, false);
      stalled.reject(Error('synthetic-sensitive late timeout failure'));
      await turn();
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
    assert.equal(AbortSignal.timeout, originalTimeout);
  }
  const composition = fixture();
  const services = createNativeServices({
    session: {
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getTicketService: () => composition.ticket,
      getTipOffService: () => composition.tip,
    },
    version: '7.0.2-53644',
    identity: { userId: '789' },
    events: { emit() {} },
  });
  const priorFetch = globalThis.fetch;
  try {
    globalThis.fetch = composition.context.fetchImpl;
    await assert.rejects(services.invokeOperation('listGroupNotices', { groupId: 123 }));
    assert.equal(composition.calls.length, 0);
    const projected = await services.invokeOperation('listGroupNotices', { groupId: '123' });
    assert.ok(
      projected &&
        typeof projected === 'object' &&
        'notices' in projected &&
        Array.isArray(projected.notices),
    );
    assert.equal(projected.notices[0].noticeId, 'notice');
    assert.equal(composition.calls.filter(([name]) => name === 'http').length, 2);
    const cancelled = new AbortController();
    const reason = Error('Synthetic request retired before dispatch');
    cancelled.abort(reason);
    for (const method of /** @type {const} */ ([
      'listGroupNotices',
      'getGroupEssencePage',
      'listGroupEssenceMessages',
    ]))
      await assert.rejects(
        services.invokeOperation(method, { groupId: '123' }, cancelled.signal),
        (error) => error === reason,
      );
    assert.equal(composition.calls.filter(([name]) => name === 'http').length, 2);
    globalThis.fetch = async (...args) => {
      const response = await composition.context.fetchImpl(...args);
      return new URL(args[0] instanceof Request ? args[0].url : args[0]).pathname ===
        '/cgi-bin/group_digest/digest_list'
        ? Response.json({
            retcode: 0,
            data: { msg_list: [], is_end: true, group_role: 2, config_page_url: 'synthetic' },
          })
        : response;
    };
    const page = await services.invokeOperation('getGroupEssencePage', { groupId: '123' });
    assert.ok(page && typeof page === 'object' && 'messages' in page && 'isEnd' in page);
    assert.deepEqual(page.messages, []);
    assert.equal(page.isEnd, true);
    assert.deepEqual(
      await services.invokeOperation('listGroupEssenceMessages', { groupId: '123' }),
      [],
    );
  } finally {
    globalThis.fetch = priorFetch;
    services.close();
  }
  const command = await prepareCommand('group-notices', { 'group-id': '123' });
  let cliCalls = 0;
  /** @type {Promise<typeof import('../../src/index.ts')>} */
  const clientModule = import(pathToFileURL(join(installedRoot, 'dist/index.js')).href);
  const { QQClient } = await clientModule;
  const facadeWorker = new ChildProcess();
  Object.defineProperty(facadeWorker, 'exitCode', { value: 0, configurable: true });
  const facade = new QQClient(facadeWorker, 5000);
  facadeWorker.emit('exit', 0, null);
  try {
    facade.listGroupNotices = async (group) => {
      assert.equal(group, '123');
      cliCalls++;
      return notices;
    };
    await command(facade);
    assert.equal(cliCalls, 1);
  } finally {
    await facade.close();
  }
  return {
    groupWebNarrowPortContract: true,
    groupWebFixedQueryContract: true,
    groupWebSnapshotContract: true,
    groupWebPendingCancelContract: true,
    groupWebLateFailureObserved: true,
    groupWebGetterAbortContract: true,
    groupWebSensitiveErrorIsolationContract: true,
    groupWebLateResponseBodyCleanupContract: true,
    groupWebRequestTimeoutContract: true,
    groupWebHttpAccessorIsolationContract: true,
    groupWebInstalledCompositionPreflight: true,
    groupWebInstalledCompositionContract: true,
    groupWebInstalledReadOwnerContract: true,
    groupWebInstalledCliContract: true,
    nativeExecuted: false,
    accountUsed: false,
    realGroupHttpAttempted: false,
  };
}
