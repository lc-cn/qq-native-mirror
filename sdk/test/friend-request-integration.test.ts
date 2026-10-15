import assert from 'node:assert/strict';
import { ChildProcess, type Serializable } from 'node:child_process';
import test from 'node:test';
import { QQClient } from '../src/index.ts';
import type { FriendRequestEvent } from '../src/types.ts';
import {
  createFriendRequests,
  type FriendBuddyListener,
  type FriendBuddyPort,
} from '../src/features/contacts/friend-requests.ts';

/** Keep both directions of IPC observable while using the actual domain owner
 * for incoming native projection and outgoing approval payload construction.
 */
class Worker extends ChildProcess {
  readonly commands: Record<string, unknown>[] = [];
  execute: (command: Record<string, unknown>) => Promise<unknown> = async () => undefined;

  constructor() {
    super();
    Object.defineProperty(this, 'connected', { value: true, configurable: true });
  }

  override send(message: Serializable, ...args: unknown[]): boolean {
    if (!message || typeof message !== 'object') throw Error('Invalid fixture command');
    const command = message as Record<string, unknown>;
    this.commands.push(command);
    const callback = args.find((value) => typeof value === 'function');
    if (typeof callback === 'function') Reflect.apply(callback, undefined, [null]);
    const complete = (reply: object) => {
      this.emit('message', { id: command.id, ...reply });
      if (command.method === 'close') this.exit();
    };
    this.execute(command).then(
      (result) => complete({ result }),
      (error: unknown) =>
        complete({ error: { message: error instanceof Error ? error.message : 'fixture error' } }),
    );
    return true;
  }

  ready(uin = '123', uid = 'u_self'): void {
    this.emit('message', { event: 'ready', payload: { uin, uid } });
  }

  offline(): void {
    this.emit('message', {
      event: 'disconnected',
      payload: { source: 'login', kind: 'transport', retryable: false, args: [] },
    });
  }

  exit(): void {
    Object.defineProperty(this, 'connected', { value: false, configurable: true });
    Object.defineProperty(this, 'exitCode', { value: 0, configurable: true });
    this.emit('exit', 0, null);
  }

  override kill(): boolean {
    this.exit();
    return true;
  }
}

const incoming = () => ({
  friendUid: 'u_original',
  reqTime: '000900719925474099312345',
  friendNick: 'friend',
  extWords: 'hello',
  isDecide: false,
  isUnread: true,
  isInitiator: false,
});

function fixture() {
  const worker = new Worker();
  const client = new QQClient(worker, 500);
  let listener: FriendBuddyListener | undefined;
  const featureEvents: { name: string; value: unknown }[] = [];
  const approvals: Parameters<NonNullable<FriendBuddyPort['approvalFriendRequest']>>[0][] = [];
  const controller = new AbortController();
  const owner = createFriendRequests({
    signal: controller.signal,
    awaitAlive: async (value) => value,
    getBuddyService: () => ({
      addKernelBuddyListener(value) {
        listener = value;
        return 7;
      },
      removeKernelBuddyListener() {},
      getBuddyReq() {
        assert.ok(listener);
        listener.onBuddyReqChange({ buddyReqs: [incoming()] });
        return { result: 0 };
      },
      approvalFriendRequest(value) {
        approvals.push(value);
      },
    }),
    emit(name, value) {
      featureEvents.push({ name, value });
      worker.emit('message', { event: name, payload: value });
    },
  });
  worker.execute = async (command) => {
    if (command.method === 'close') {
      owner.close();
      return;
    }
    if (command.method === 'listFriendRequests' || command.method === 'handleFriendRequest')
      return owner.invokeOperation(command.method, command);
    throw Error('Unexpected fixture command');
  };
  worker.ready();
  return {
    worker,
    client,
    featureEvents,
    approvals,
    notify(value = incoming()) {
      assert.ok(listener);
      listener.onBuddyReqChange({ buddyReqs: [value] });
    },
    async close() {
      owner.close();
      await client.close();
    },
  };
}

test('native Buddy request reaches canonical and legacy public events once, and approval round-trips the original identity', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const canonical: FriendRequestEvent[] = [];
  const legacy: FriendRequestEvent[] = [];
  f.client.on('request.friend', (event) => canonical.push(event));
  f.client.on('friend-request', (event) => legacy.push(event));
  const source = incoming();
  f.notify(source);
  f.notify(source);
  assert.equal(f.featureEvents.length, 1);
  assert.equal(f.featureEvents[0]?.name, 'request.friend');
  assert.equal(canonical.length, 1);
  assert.equal(legacy.length, 1);
  const event = canonical[0]!;
  assert.equal(legacy[0], event);
  assert.notEqual(f.featureEvents[0]?.value, event);
  assert.equal(Object.hasOwn(f.featureEvents[0]!.value as object, 'approve'), false);
  assert.equal(Object.hasOwn(source, 'approve'), false);
  assert.equal(f.approvals.length, 0);

  source.friendUid = 'u_source_changed';
  source.reqTime = '9';
  event.uid = 'u_observer_changed';
  event.time = '8';
  await event.approve(false);
  assert.deepEqual(f.approvals, [
    { friendUid: 'u_original', reqTime: '000900719925474099312345', accept: false },
  ]);
  assert.deepEqual(
    f.worker.commands.map(({ id: _id, ...command }) => command),
    [
      {
        method: 'handleFriendRequest',
        request: { uid: 'u_original', time: '000900719925474099312345' },
        accept: false,
      },
    ],
  );
  const list = await f.client.listFriendRequests();
  assert.equal(list.length, 1);
  assert.equal(Object.hasOwn(list[0]!, 'approve'), false);
  assert.equal(canonical.length, 1);
  assert.equal(legacy.length, 1);
});

test('requests produced by the native callback cannot approve through a retired or different account session', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const events: FriendRequestEvent[] = [];
  f.client.on('request.friend', (event) => events.push(event));
  f.notify();
  const first = events[0]!;
  f.worker.offline();
  await assert.rejects(first.approve(), /inactive|session/);
  f.worker.ready();
  await assert.rejects(first.approve(), /inactive|session/);
  f.notify({ ...incoming(), reqTime: '2' });
  const second = events[1]!;
  f.worker.ready('456', 'u_other');
  await assert.rejects(second.approve(false), /inactive|session/);
  assert.equal(f.worker.commands.length, 0);
  assert.equal(f.approvals.length, 0);
  f.notify({ ...incoming(), reqTime: '3' });
  const third = events[2]!;
  await third.approve();
  assert.deepEqual(f.approvals, [{ friendUid: 'u_original', reqTime: '3', accept: true }]);
  await f.client.close();
  await assert.rejects(third.approve(), /inactive|session/);
  assert.equal(f.approvals.length, 1);
});
