import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageResolution } from '../src/features/messages/message-resolution.ts';

const message = () => ({
  chatType: 1,
  peerUid: 'u_peer',
  peerUin: '0',
  senderUid: 'u_sender',
  senderUin: '',
  sendNickName: 'before',
  msgId: '1',
  msgSeq: '0009',
  msgTime: '100',
  elements: [{ elementType: 1, textElement: { atType: 0, content: 'before' } }],
});

test('peer conversion preserves native peers and legacy aliases without acquiring identity service', async () => {
  const calls: string[] = [];
  const resolution = createMessageResolution({
    signal: new AbortController().signal,
    resolveUid: async (id) => {
      calls.push(id);
      return 'u_peer';
    },
    getIdentityService() {
      throw new Error('Peer conversion cannot query UINs');
    },
    diagnostic() {},
  });
  assert.deepEqual(await resolution.resolvePeer({ chatType: 1, peerUid: 'native' }), {
    chatType: 1,
    peerUid: 'native',
  });
  assert.deepEqual(await resolution.resolvePeer({ type: 'group', id: '000123' }), {
    chatType: 2,
    peerUid: '000123',
  });
  assert.deepEqual(await resolution.resolvePeer({ type: 'private', id: '000456' }), {
    chatType: 1,
    peerUid: 'u_peer',
  });
  assert.deepEqual(calls, ['000456']);
  await assert.rejects(resolution.resolvePeer({ chatType: 1, peerUid: '' }), /Invalid peer UID/);
  await assert.rejects(resolution.resolvePeer([]), /Unsupported peer type/);
  assert.deepEqual(calls, ['000456']);
});

test('shared projection captures message fields before identity lookup and retains the original raw object', async () => {
  let complete!: (result: unknown) => void;
  const pending = new Promise<unknown>((resolve) => {
    complete = resolve;
  });
  const calls: string[][] = [];
  const identityService = {
    getUin(uids: string[]) {
      assert.equal(this, identityService);
      calls.push(uids);
      return pending;
    },
  };
  const resolution = createMessageResolution({
    signal: new AbortController().signal,
    resolveUid: async () => 'u_peer',
    getIdentityService: () => identityService,
    diagnostic() {
      assert.fail('Valid identity response must not produce a diagnostic');
    },
  });
  const raw = message();
  const result = resolution.resolveMessage(raw);
  raw.msgId = '2';
  raw.sendNickName = 'after';
  raw.elements[0].textElement.content = 'after';
  complete({
    uinInfo: new Map([
      ['u_peer', '000456'],
      ['u_sender', '900719925474099312345'],
    ]),
  });
  const projected = await result;
  assert.ok(projected);
  assert.deepEqual(calls, [['u_peer', 'u_sender']]);
  assert.equal(projected.messageId, '1');
  assert.equal(projected.sequence, '0009');
  assert.equal(projected.sender.nickname, 'before');
  assert.equal(projected.sender.userId, '900719925474099312345');
  assert.deepEqual(projected.peer, { type: 'private', userId: '000456' });
  assert.deepEqual(projected.elements, [{ type: 'text', text: 'before' }]);
  assert.equal(projected.raw, raw);
});

test('delivery signal cancels stalled identity resolution and observes late native rejection', async () => {
  const account = new AbortController(),
    delivery = new AbortController();
  let started!: () => void, reject!: (error: unknown) => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<unknown>((_resolve, fail) => {
    reject = fail;
  });
  const resolution = createMessageResolution({
    signal: account.signal,
    resolveUid: async () => 'u_peer',
    getIdentityService: () => ({
      getUin() {
        started();
        return pending;
      },
    }),
    diagnostic() {
      assert.fail('Cancellation must not publish lookup diagnostics');
    },
  });
  const result = resolution.resolveMessages([message()], undefined, true, delivery.signal);
  const cancelled = assert.rejects(result, (error: unknown) => error === delivery.signal.reason);
  await dispatched;
  delivery.abort(new Error('Delivery closed'));
  await cancelled;
  assert.equal(account.signal.aborted, false);
  reject(new Error('Late native failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('untrusted identity maps cannot fabricate QQ IDs or expose native values in diagnostics', async () => {
  for (const uinInfo of [
    undefined,
    { u_peer: '123', credential: 'private-native-value' },
    new Map([['unrequested', '123']]),
    new Map<string, unknown>([
      ['u_peer', '000456'],
      ['u_sender', 9007199254740992],
    ]),
  ]) {
    const diagnostics: string[] = [];
    const resolution = createMessageResolution({
      signal: new AbortController().signal,
      resolveUid: async () => 'u_peer',
      getIdentityService: () => ({ getUin: () => ({ uinInfo }) }),
      diagnostic: (stage) => diagnostics.push(stage),
    });
    assert.deepEqual(await resolution.resolveMessages([message()], undefined, true), [undefined]);
    assert.ok(diagnostics.length > 0);
    assert.ok(
      diagnostics.every((stage) =>
        ['native-message-identity-lookup-failed', 'unresolved-native-message-identity'].includes(
          stage,
        ),
      ),
    );
  }
});
