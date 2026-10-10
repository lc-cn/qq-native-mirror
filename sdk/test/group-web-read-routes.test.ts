import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeServices } from '../src/native-services.ts';

const routes = ['listGroupNotices', 'getGroupEssencePage', 'listGroupEssenceMessages'] as const;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(ticket: () => unknown) {
  return createNativeServices({
    session: {
      getTicketService: () => ({ forceFetchClientKey: ticket }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
    },
    identity: { userId: '789' },
    version: 'fixture',
    events: { emit() {} },
  });
}
function payload(route: (typeof routes)[number]) {
  return { groupId: '123', options: route === 'listGroupEssenceMessages' ? { maxPages: 2 } : {} };
}
function result(route: (typeof routes)[number]) {
  return route === 'listGroupNotices'
    ? { ec: 0, feeds: [] }
    : {
        retcode: 0,
        data: {
          msg_list: [],
          is_end: true,
          group_role: 2,
          config_page_url: 'https://synthetic.test/',
        },
      };
}
function cookie() {
  const headers = new Headers();
  headers.append('set-cookie', 'skey=synthetic; Path=/');
  headers.append('set-cookie', 'p_skey=synthetic; Path=/');
  return new Response(null, { headers });
}

for (const route of routes) {
  test(`${route}: synchronous ticket close observes late native rejection with no HTTP`, async () => {
    const original = globalThis.fetch;
    let reject!: (reason: unknown) => void;
    const late = new Promise<never>((_, fail) => {
      reject = fail;
    });
    let http = 0;
    const unhandled: unknown[] = [];
    const observe = (reason: unknown) => unhandled.push(reason);
    const services = fixture(() => {
      services.close();
      return late;
    });
    process.on('unhandledRejection', observe);
    globalThis.fetch = async () => {
      http++;
      throw new Error('No HTTP after close');
    };
    try {
      await assert.rejects(
        services.invokeOperation(route, payload(route)),
        /closed|cancelled|aborted/,
      );
      reject(new Error('late ticket rejection'));
      await flush();
      await flush();
      assert.deepEqual(unhandled, []);
      assert.equal(http, 0);
    } finally {
      services.close();
      globalThis.fetch = original;
      process.off('unhandledRejection', observe);
    }
  });

  test(`${route}: cancelling a stalled HTTP request leaves sibling request and session alive`, async () => {
    const original = globalThis.fetch;
    const services = fixture(() => ({ result: 0, clientKey: 'synthetic' }));
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let pageCalls = 0;
    let lateReject!: (reason: unknown) => void;
    const late = new Promise<never>((_, reject) => {
      lateReject = reject;
    });
    globalThis.fetch = async (url) => {
      if (new URL(String(url)).hostname === 'ssl.ptlogin2.qq.com') return cookie();
      if (++pageCalls === 1) {
        start();
        return late;
      }
      return Response.json(result(route));
    };
    const controller = new AbortController();
    try {
      const first = services.invokeOperation(route, payload(route), controller.signal);
      await started;
      const sibling = services.invokeOperation(route, payload(route));
      controller.abort();
      await assert.rejects(first, /closed|cancelled|aborted/);
      await sibling;
      lateReject(new Error('late HTTP rejection'));
      await flush();
      await services.invokeOperation(route, payload(route));
      assert.equal(pageCalls, 3);
    } finally {
      services.close();
      globalThis.fetch = original;
    }
  });

  test(`${route}: JSON completion closing session cannot publish or request another page`, async () => {
    const original = globalThis.fetch;
    const services = fixture(() => ({ result: 0, clientKey: 'synthetic' }));
    let pages = 0;
    globalThis.fetch = async (url) => {
      if (new URL(String(url)).hostname === 'ssl.ptlogin2.qq.com') return cookie();
      pages++;
      return Object.assign(Response.json({}), {
        json: async () => {
          services.close();
          return route === 'listGroupNotices'
            ? result(route)
            : { retcode: 0, data: { msg_list: [], is_end: false, group_role: 2 } };
        },
      });
    };
    try {
      await assert.rejects(
        services.invokeOperation(route, payload(route)),
        /closed|cancelled|aborted|invalid JSON/,
      );
      assert.equal(pages, 1);
    } finally {
      services.close();
      globalThis.fetch = original;
    }
  });
}
