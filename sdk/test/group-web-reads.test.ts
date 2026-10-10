import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroupWebReads } from '../src/features/groups/group-web-reads.ts';
import { NativeServiceLifetime } from '../src/runtime/native-service-lifetime.ts';

function fixture(accountId: string | undefined = '123') {
  const lifetime = new NativeServiceLifetime();
  const tickets: { resolve(value: unknown): void; reject(error: unknown): void }[] = [];
  let calls = 0;
  let httpCalls = 0;
  const ticket = {
    forceFetchClientKey(selector: string) {
      assert.equal(this, ticket);
      assert.equal(selector, '');
      calls++;
      return new Promise<unknown>((resolve, reject) => tickets.push({ resolve, reject }));
    },
  };
  const api = createGroupWebReads({
    accountId,
    signal: lifetime.signal,
    awaitAlive: lifetime.awaitAlive,
    getTicketService: () => ticket,
    getTipOffService: () => ({
      getPskey(domains: string[], force: boolean) {
        assert.deepEqual(domains, ['qun.qq.com']);
        assert.equal(force, true);
        return { result: 0, domainPskeyMap: new Map([['qun.qq.com', 'fixture']]) };
      },
    }),
    fetchImpl: async () => {
      httpCalls++;
      return httpCalls % 2 === 1
        ? new Response(null, { headers: { 'set-cookie': 'skey=fixture; Path=/' } })
        : Response.json({
            retcode: 0,
            data: { msg_list: [], is_end: true, group_role: 0, config_page_url: '' },
          });
    },
  });
  return { api, lifetime, tickets, calls: () => calls, httpCalls: () => httpCalls };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('account check precedes cancellation and input validation', async () => {
  const f = fixture('');
  f.lifetime.close();
  await assert.rejects(f.api.listGroupNotices(null), /requires the authenticated account identity/);
  await assert.rejects(
    f.api.getGroupEssencePage(null),
    /requires the authenticated account identity/,
  );
  assert.equal(f.calls(), 0);
});

test('pre-aborted request never acquires tickets', async () => {
  const f = fixture(),
    controller = new AbortController(),
    reason = new Error('request stopped');
  controller.abort(reason);
  await assert.rejects(
    f.api.listGroupNotices('456', controller.signal),
    (error) => error === reason,
  );
  assert.equal(f.calls(), 0);
  f.lifetime.close();
});

test('one request cancellation leaves sibling pending and late failure observed', async () => {
  const f = fixture(),
    controller = new AbortController();
  const first = f.api.listGroupNotices('456', controller.signal);
  const sibling = f.api.getGroupEssencePage('456');
  const firstRejected = assert.rejects(first);
  let siblingSettled = false;
  const siblingRejected = assert.rejects(sibling).then(() => {
    siblingSettled = true;
  });
  await tick();
  assert.equal(f.calls(), 2);
  controller.abort(new Error('first retired'));
  await firstRejected;
  await tick();
  assert.equal(siblingSettled, false);
  f.tickets[0]!.reject(new Error('late ticket failure'));
  f.lifetime.close();
  await siblingRejected;
  f.tickets[1]!.resolve({ clientKey: 'fixture' });
  await tick();
});

test('cancelled ticket does not close sibling or dispatch its late HTTP', async () => {
  const f = fixture(),
    controller = new AbortController();
  const first = f.api.listGroupNotices('456', controller.signal);
  const failed = assert.rejects(first);
  const sibling = f.api.getGroupEssencePage('456');
  controller.abort(new Error('cancelled'));
  await failed;
  f.tickets[0]!.resolve({ result: 0, clientKey: 'late' });
  f.tickets[1]!.resolve({ result: 0, clientKey: 'fixture' });
  const page = await sibling;
  assert.deepEqual(page.messages, []);
  assert.equal(f.httpCalls(), 2);
  assert.equal(f.lifetime.closed, false);
  f.lifetime.close();
});

test('account close interrupts all three stalled reads and observes late rejection', async () => {
  const f = fixture();
  const pending = [
    f.api.listGroupNotices('456'),
    f.api.getGroupEssencePage('456'),
    f.api.listGroupEssenceMessages('456'),
  ];
  const rejected = pending.map((value) => assert.rejects(value, /closed during operation/));
  f.lifetime.close();
  await Promise.all(rejected);
  for (const ticket of f.tickets) ticket.reject(new Error('late private failure'));
  await tick();
  assert.equal(f.calls(), 3);
  assert.equal(f.httpCalls(), 0);
});
