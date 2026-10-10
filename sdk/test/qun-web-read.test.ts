import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { requestQunPage, type QunWebReadContext } from '../src/features/groups/qun-web-read.ts';
const key = { result: 0, clientKey: 'synthetic' };
function fixture() {
  const controller = new AbortController();
  let http = 0;
  const context: { -readonly [K in keyof QunWebReadContext]: QunWebReadContext[K] } = {
    accountId: '123',
    signal: controller.signal,
    awaitAlive: async (value) => value,
    getTicketService: () => ({ forceFetchClientKey: () => key }),
    getTipOffService: () => ({
      getPskey: () => ({
        result: 0,
        domainPskeyMap: new Map([['qun.qq.com', 'synthetic-domain']]),
      }),
    }),
    fetchImpl: async () => {
      http++;
      return http === 1
        ? new Response('', { headers: { 'set-cookie': 'skey=synthetic; Path=/;' } })
        : Response.json({ ec: 0, feeds: [] });
    },
  };
  return { context, controller, http: () => http };
}
for (const stage of ['service', 'method'] as const) {
  test(`ticket ${stage} getter cancellation prevents native invocation`, async () => {
    const f = fixture();
    let calls = 0;
    f.context.getTicketService = () => {
      if (stage === 'service') f.controller.abort();
      return {
        get forceFetchClientKey() {
          if (stage === 'method') f.controller.abort();
          return () => {
            calls++;
            return key;
          };
        },
      };
    };
    await assert.rejects(requestQunPage(f.context, 'notices', new URLSearchParams()), /cancelled/);
    assert.equal(calls, 0);
    assert.equal(f.http(), 0);
  });
}
for (const stage of ['ticket-status', 'ticket-key', 'domain-map'] as const) {
  test(`${stage} projection exception is sanitized without private wording`, async () => {
    const f = fixture();
    const failure = () => {
      throw new Error('synthetic-private-native-wording');
    };
    if (stage === 'ticket-status')
      f.context.getTicketService = () => ({
        forceFetchClientKey: () => ({
          get result() {
            return failure();
          },
        }),
      });
    if (stage === 'ticket-key')
      f.context.getTicketService = () => ({
        forceFetchClientKey: () => ({
          result: 0,
          get clientKey() {
            return failure();
          },
        }),
      });
    if (stage === 'domain-map')
      f.context.getTipOffService = () => ({
        getPskey: () => ({
          result: 0,
          get domainPskeyMap() {
            return failure();
          },
        }),
      });
    await assert.rejects(requestQunPage(f.context, 'notices', new URLSearchParams()), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        stage === 'domain-map'
          ? 'Native domain key acquisition failed'
          : 'Native client key acquisition failed',
      );
      return true;
    });
  });
}
for (const stage of ['ticket', 'domain', 'http', 'json', 'body'] as const) {
  test(`cancellation settles stalled ${stage}, observes late failure and removes wait listeners`, async () => {
    const f = fixture();
    let started!: () => void, fail!: (error: unknown) => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stalled = new Promise<never>((_, reject) => {
      fail = reject;
    });
    const stall = () => {
      started();
      return stalled;
    };
    if (stage === 'ticket') f.context.getTicketService = () => ({ forceFetchClientKey: stall });
    if (stage === 'domain') f.context.getTipOffService = () => ({ getPskey: stall });
    if (stage === 'http') f.context.fetchImpl = stall;
    if (stage === 'body')
      f.context.fetchImpl = async () =>
        new Response(new ReadableStream({ cancel: stall }), {
          headers: { 'set-cookie': 'skey=synthetic' },
        });
    if (stage === 'json') {
      let calls = 0;
      f.context.fetchImpl = async () =>
        ++calls === 1
          ? new Response('', { headers: { 'set-cookie': 'skey=synthetic' } })
          : Object.assign(Response.json({}), { json: stall });
    }
    const pending = requestQunPage(f.context, 'notices', new URLSearchParams());
    await began;
    f.controller.abort();
    await assert.rejects(pending, /cancelled|failed|invalid JSON/);
    fail(new Error('late synthetic rejection'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
  });
}

test('query parameters snapshot before ticket wait retains duplicate order and receiver', async () => {
  const f = fixture();
  let finish!: (value: typeof key) => void;
  const service = {
    forceFetchClientKey(selector: string) {
      assert.equal(this, service);
      assert.equal(selector, '');
      return new Promise<typeof key>((resolve) => {
        finish = resolve;
      });
    },
  };
  f.context.getTicketService = () => service;
  const query = new URLSearchParams([
    ['n', '1'],
    ['n', '20'],
  ]);
  const urls: string[] = [];
  let calls = 0;
  f.context.fetchImpl = async (input) => {
    urls.push(String(input));
    return ++calls === 1
      ? new Response('', { headers: { 'set-cookie': 'skey=synthetic;' } })
      : Response.json({});
  };
  const pending = requestQunPage(f.context, 'notices', query);
  query.set('n', '999');
  finish(key);
  await pending;
  assert.deepEqual(new URL(urls[1]!).searchParams.getAll('n'), ['1', '20']);
});

for (const rejecting of [false, true]) {
  test(`late ignored-abort fetch response releases body once; cancellation rejection=${rejecting} observed`, async () => {
    const f = fixture();
    let began!: () => void,
      finish!: (response: Response) => void,
      cancels = 0;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    f.context.fetchImpl = () => {
      began();
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    };
    const pending = requestQunPage(f.context, 'notices', new URLSearchParams());
    await started;
    f.controller.abort();
    await assert.rejects(pending, /HTTP request failed/);
    finish(
      new Response(
        new ReadableStream({
          cancel() {
            cancels++;
            if (rejecting) return Promise.reject(new Error('late synthetic private cancellation'));
          },
        }),
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cancels, 1);
  });
}

for (const stage of ['fetch', 'json', 'body'] as const) {
  test(`HTTP15s timeout signal bounds ignored-abort ${stage} wait`, async () => {
    const original = AbortSignal.timeout;
    const timeout = new AbortController();
    AbortSignal.timeout = (milliseconds) => {
      assert.equal(milliseconds, 15000);
      return timeout.signal;
    };
    try {
      const f = fixture();
      let began!: () => void;
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      const stalled = () => {
        began();
        return new Promise<never>(() => {});
      };
      if (stage === 'fetch') f.context.fetchImpl = stalled;
      if (stage === 'body')
        f.context.fetchImpl = async () =>
          new Response(new ReadableStream({ cancel: stalled }), {
            headers: { 'set-cookie': 'skey=synthetic' },
          });
      if (stage === 'json') {
        let calls = 0;
        f.context.fetchImpl = async () =>
          ++calls === 1
            ? new Response('', { headers: { 'set-cookie': 'skey=synthetic' } })
            : Object.assign(Response.json({}), { json: stalled });
      }
      const pending = requestQunPage(f.context, 'notices', new URLSearchParams());
      await started;
      timeout.abort();
      await assert.rejects(pending, /HTTP request failed|cookie exchange failed|invalid JSON/);
    } finally {
      AbortSignal.timeout = original;
    }
  });
}

for (const stage of ['headers', 'status', 'cookie-ok', 'location', 'list-ok'] as const) {
  test(`credential-bearing response ${stage} exception is fixed and sanitized`, async () => {
    const f = fixture();
    let calls = 0;
    const fail = () => {
      throw new Error('synthetic-private-cookie-url');
    };
    f.context.fetchImpl = async () => {
      const response =
        ++calls === 1
          ? new Response('', { headers: { 'set-cookie': 'skey=synthetic' } })
          : Response.json({});
      if (stage === 'headers' && calls === 1)
        Object.defineProperty(response, 'headers', { get: fail });
      if (stage === 'status' && calls === 1)
        Object.defineProperty(response, 'status', { get: fail });
      if (stage === 'cookie-ok' && calls === 1)
        Object.defineProperty(response, 'ok', { get: fail });
      if (stage === 'location' && calls === 1) {
        Object.defineProperty(response, 'status', { value: 302 });
        Object.defineProperty(response.headers, 'get', { value: fail });
      }
      if (stage === 'list-ok' && calls === 2) Object.defineProperty(response, 'ok', { get: fail });
      return response;
    };
    await assert.rejects(requestQunPage(f.context, 'notices', new URLSearchParams()), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        stage === 'location'
          ? 'Group notice cookie redirect failed'
          : stage === 'list-ok'
            ? 'Group notice list HTTP request failed'
            : 'Group notice cookie exchange failed',
      );
      return true;
    });
  });
}

test('already-aborted combined timeout prevents fetch invocation', async () => {
  const original = AbortSignal.timeout;
  const timeout = new AbortController();
  timeout.abort();
  AbortSignal.timeout = () => timeout.signal;
  try {
    const f = fixture();
    await assert.rejects(
      requestQunPage(f.context, 'notices', new URLSearchParams()),
      /HTTP request failed/,
    );
    assert.equal(f.http(), 0);
  } finally {
    AbortSignal.timeout = original;
  }
});

test('timeout retirement after JSON wait check but before returning raw cannot succeed', async () => {
  const original = AbortSignal.timeout;
  const timeout = new AbortController();
  AbortSignal.timeout = () => timeout.signal;
  try {
    const f = fixture();
    let calls = 0;
    f.context.fetchImpl = async () =>
      ++calls === 1
        ? new Response('', { headers: { 'set-cookie': 'skey=synthetic' } })
        : Object.assign(Response.json({}), { json: () => Promise.resolve({ terminal: true }) });
    f.context.awaitAlive = async (value) => {
      const result = await value;
      if (result && typeof result === 'object' && 'terminal' in result)
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => timeout.abort())));
      return result;
    };
    await assert.rejects(requestQunPage(f.context, 'notices', new URLSearchParams()), /cancelled/);
    assert.equal(timeout.signal.aborted, true);
  } finally {
    AbortSignal.timeout = original;
  }
});
