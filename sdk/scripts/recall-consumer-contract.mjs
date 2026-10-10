import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';

// Installed compiled modules with synthetic callbacks only. Never creates a native client.
export async function verifyRecallConsumer(packagePath) {
  const load = (name) => import(pathToFileURL(join(packagePath, 'dist', name)).href);
  const { createRecallEvents } = await load('features/messages/recall-events.js');
  const { createNativeServices } = await load('native-services.js');
  const { observeWatchEvents } = await load('cli.js');
  const events = [],
    listener = createRecallEvents((event, payload) => events.push([event, payload]));
  const raw = {
    chatType: 2,
    peerUid: '123',
    msgId: '900719925474099312345',
    msgSeq: '900719925474099312346',
    recallTime: '000900719925474099312347',
    private: 'must-not-leak',
  };
  const projected = {
    peer: { type: 'group', groupId: '123' },
    messageId: raw.msgId,
    sequence: raw.msgSeq,
    recallTime: raw.recallTime,
  };
  listener.onMessageUpdate(raw);
  assert.deepEqual(events, [['message.recalled', projected]]);
  listener.onMessageUpdate({ ...raw });
  assert.equal(events.length, 1);
  listener.onMessageUpdate({ ...raw, chatType: 1, peerUid: 'u_other', peerUin: '456' });
  assert.deepEqual(events[1], [
    'message.recalled',
    { ...projected, peer: { type: 'private', userId: '456' } },
  ]);
  for (const recallTime of [undefined, '0', '00'])
    listener.onMessageUpdate({ ...raw, msgId: '2', recallTime });
  assert.equal(events.length, 2);
  for (const change of [
    { msgId: 12 },
    { msgId: undefined },
    { msgSeq: 12 },
    { msgSeq: undefined },
    { recallTime: 12 },
    { recallTime: '-1' },
    { recallTime: '1.5' },
    { peerUid: 'invalid' },
    { chatType: 99 },
    { chatType: 1, peerUid: '', peerUin: '456' },
    { chatType: 1, peerUid: 'u_other', peerUin: '0' },
    { chatType: 1, peerUid: 'u_other', peerUin: 456 },
  ]) {
    const before = events.length;
    listener.onMessageUpdate({ ...raw, msgId: '3', ...change });
    assert.equal(events.length, before + 1);
    const [event, payload] = events.at(-1);
    assert.equal(event, 'diagnostic');
    assert.equal(typeof payload.stage, 'string');
    assert.deepEqual(Object.keys(payload), ['stage']);
  }
  assert.ok(!JSON.stringify(events).includes('must-not-leak'));
  listener.close();
  const count = events.length;
  listener.onMessageUpdate({ ...raw, msgId: '4' });
  assert.equal(events.length, count);

  // Exercise actual Session callback integration and stop delivery after close.
  let callback;
  const delivered = [];
  const services = createNativeServices({
    session: {
      getMsgService: () => ({
        addKernelMsgListener(value) {
          callback = value;
        },
      }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
    },
    version: '7.0.2-53644',
    events: { emit: (event, payload) => delivered.push([event, payload]) },
  });
  try {
    callback.onMsgInfoListUpdate([raw]);
    assert.deepEqual(
      delivered.filter(([event]) => event === 'message.recalled'),
      [['message.recalled', projected]],
    );
    assert.ok(
      delivered.some(([event]) => event === 'message-recalled'),
      'legacy raw recall remains available',
    );
    services.close();
    const before = delivered.length;
    callback.onMsgInfoListUpdate([{ ...raw, msgId: '5' }]);
    assert.equal(delivered.length, before);
  } finally {
    services.close();
  }

  const client = new EventEmitter(),
    lines = [];
  const cleanup = observeWatchEvents(client, 'normalized', (line) => lines.push(JSON.parse(line)));
  const normalized = [
    'message',
    'message.recalled',
    'request.friend',
    'request.group',
    'group-list-updated',
    'group-members-updated',
    'friend-list-updated',
  ];
  for (const event of normalized) client.emit(event, { fixture: event });
  client.emit('message-recalled', { raw: 'must-not-leak' });
  client.emit('authenticated', {});
  client.emit('msf-status', {});
  assert.deepEqual(
    lines,
    normalized.map((event) => ({ event, payload: { fixture: event } })),
  );
  cleanup();
  client.emit('message.recalled', projected);
  assert.equal(lines.length, 7);
  const plain = [],
    unwatch = observeWatchEvents(client, undefined, (line) => plain.push(JSON.parse(line)));
  client.emit('message.recalled', projected);
  client.emit('message', { fixture: true });
  assert.deepEqual(plain, [{ fixture: true }]);
  unwatch();
  return { normalizedRecallContract: true, nativeRecallObserved: false, accountUsed: false };
}
