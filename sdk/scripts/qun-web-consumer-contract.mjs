import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Installed compiled transports and composition, controlled native/HTTP ports only. */
export async function verifyQunWebConsumer(installedRoot) {
  const load = (name) => import(pathToFileURL(join(installedRoot, 'dist', name)).href);
  const [
    { requestQunPage },
    { listWebGroupNotices },
    { createNativeServices },
    { prepareCommand },
  ] = await Promise.all([
    load('features/groups/qun-web-read.js'),
    load('features/groups/web-group-notices.js'),
    load('native-services.js'),
    load('cli.js'),
  ]);
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => {
      resolve = a;
      reject = b;
    });
    return { promise, resolve, reject };
  };
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  const bounded = async (promise) => {
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
  const safeFailure = async (promise) =>
    assert.rejects(bounded(promise), (error) => {
      assert.equal(typeof error.message, 'string');
      assert.notEqual(error.message, 'Qun settlement deadline exceeded');
      assert.ok(!error.message.includes('synthetic-sensitive'));
      return true;
    });
  const body = {
    ec: 0,
    feeds: [{ fid: 'notice', u: 456, pubt: 100, msg: { text: 'fixture', pics: [] } }],
  };
  const fixture = () => {
    const controller = new AbortController(),
      calls = [];
    const ticket = {
      forceFetchClientKey(value) {
        assert.equal(this, ticket);
        calls.push(['ticket', value]);
        return { result: 0, clientKey: 'synthetic-sensitive-client' };
      },
    };
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
    const context = {
      accountId: '789',
      signal: controller.signal,
      awaitAlive: async (value) => value,
      getTicketService: () => ticket,
      getTipOffService: () => tip,
      fetchImpl: async (url, init) => {
        assert.equal(init.redirect, 'manual');
        const parsed = new URL(url);
        calls.push(['http', parsed]);
        if (parsed.hostname === 'ssl.ptlogin2.qq.com')
          return new Response(null, { headers: { 'set-cookie': 'skey=abc; Path=/' } });
        return Response.json(body);
      },
    };
    return { controller, calls, ticket, tip, context };
  };
  const normal = fixture();
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
    [...capturedQuery],
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
  assert.equal(
    essence.calls.filter(([name]) => name === 'http')[1][1].origin +
      essence.calls.filter(([name]) => name === 'http')[1][1].pathname,
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
        return pending.promise;
      };
    if (stage === 'json') {
      const prior = f.context.fetchImpl;
      f.context.fetchImpl = async (...args) => {
        const response = await prior(...args);
        if (new URL(args[0]).hostname === 'ssl.ptlogin2.qq.com') return response;
        return {
          ok: true,
          json() {
            began.resolve();
            return pending.promise;
          },
        };
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
    return lateResponse.promise;
  };
  const lateRead = requestQunPage(late.context, 'notices', new URLSearchParams('qid=123'));
  await bounded(lateBegan.promise);
  late.controller.abort(Error('Synthetic cancelled'));
  await safeFailure(lateRead);
  lateResponse.resolve({
    body: {
      cancel() {
        cancelledBodies++;
        return cancellation.promise;
      },
    },
  });
  await turn();
  assert.equal(cancelledBodies, 1);
  cancellation.reject(Error('synthetic-sensitive late body cancellation'));
  await turn();
  assert.equal(cancelledBodies, 1);
  for (const field of ['headers', 'ok', 'location']) {
    const f = fixture();
    f.context.fetchImpl = async () => {
      if (field === 'headers')
        return {
          get headers() {
            throw Error('synthetic-sensitive headers');
          },
        };
      if (field === 'ok')
        return {
          headers: { getSetCookie: () => [] },
          status: 200,
          get ok() {
            throw Error('synthetic-sensitive ok');
          },
        };
      return {
        headers: {
          getSetCookie: () => [],
          get() {
            throw Error('synthetic-sensitive location');
          },
        },
        status: 302,
      };
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
          return stalled.promise;
        };
      if (stage === 'body')
        f.context.fetchImpl = async () => ({
          headers: { getSetCookie: () => [] },
          status: 200,
          ok: true,
          body: {
            cancel() {
              began.resolve();
              return stalled.promise;
            },
          },
        });
      if (stage === 'json') {
        const originalFetch = f.context.fetchImpl;
        f.context.fetchImpl = async (...args) => {
          const response = await originalFetch(...args);
          if (new URL(args[0]).hostname === 'ssl.ptlogin2.qq.com') return response;
          return {
            ok: true,
            json() {
              began.resolve();
              return stalled.promise;
            },
          };
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
    assert.equal(projected.notices[0].noticeId, 'notice');
    assert.equal(composition.calls.filter(([name]) => name === 'http').length, 2);
  } finally {
    globalThis.fetch = priorFetch;
    services.close();
  }
  const command = await prepareCommand('group-notices', { 'group-id': '123' });
  let cliCalls = 0;
  await command({
    listGroupNotices: async (group) => {
      assert.equal(group, '123');
      cliCalls++;
      return notices;
    },
  });
  assert.equal(cliCalls, 1);
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
    groupWebInstalledCliContract: true,
    nativeExecuted: false,
    accountUsed: false,
    realGroupHttpAttempted: false,
  };
}
