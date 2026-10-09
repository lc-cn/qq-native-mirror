import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeServices } from '../src/native-services.ts';

export function sendFixture(options: { send?: (...args: any[]) => any; uid?: (ids: string[]) => any; unique?: () => unknown } = {}) {
  let listener: any;
  const calls: any[][] = [], conversions: string[][] = [];
  let generated = 0;
  const services = createNativeServices({
    getMsgService: () => ({ addKernelMsgListener(value: any) { listener = value; }, generateMsgUniqueId() { generated++; return options.unique?.() ?? `unique-${generated}`; }, sendMsg(...args: any[]) {
      calls.push(args);
      if (options.send) return options.send(...args);
      listener.onMsgInfoListUpdate([{ guildId: args[1].guildId, sendStatus: 2, msgId: '42', msgSeq: '9', msgTime: '100' }]);
      return { result: 0 };
    } }),
    getGroupService: () => ({ addKernelGroupListener() {} }),
    getBuddyService: () => ({ addKernelBuddyListener() {} }),
    getUixConvertService: () => ({ getUid(ids: string[]) { conversions.push(ids); return options.uid?.(ids) ?? { uidInfo: new Map(ids.map(id => [id, `u_${id}`])) }; } }),
    getMSFService: () => ({ getServerTime: () => '100' }),
  }, '7.0.2-53644', () => {});
  return { services, calls, conversions, generated: () => generated, callback: () => listener };
}

for (const [label, message] of [
  ['sparse batch', Array(1)],
  ['later invalid element', [{ type: 'at', userId: '456' }, { type: 'text', text: {} }]],
  ['later unknown kind', [{ type: 'reply', messageId: '42' }, { type: 'unknown' }]],
  ['mention object ID', [{ type: 'at', userId: { toString: () => '456' } }]],
  ['mention zero', [{ type: 'at', userId: '0' }]],
  ['mention nonstring text', [{ type: 'at', userId: '456', text: {} }]],
] as [string, unknown][]) test(`send rejects ${label} before native preparation or submission`, async () => {
  const f = sendFixture();
  try {
    await assert.rejects(f.services.invokeOperation('sendGroupMessage', { groupId: '123', message }), /message|element|text|mention|identifier/i);
    assert.deepEqual(f.conversions, []); assert.equal(f.generated(), 0); assert.equal(f.calls.length, 0);
  } finally { f.services.close(); }
});

test('invalid private message does not start recipient UID lookup', async () => {
  const f = sendFixture();
  try { await assert.rejects(f.services.invokeOperation('sendPrivateMessage', { userId: '456', message: Array(1) })); assert.deepEqual(f.conversions, []); }
  finally { f.services.close(); }
});

test('send snapshots message fields before pending recipient lookup', async () => {
  let resolve: any;
  const f = sendFixture({ uid: () => new Promise(done => { resolve = done; }) });
  const element = { type: 'text', text: 'original' }, message = [element];
  try {
    const pending = f.services.invokeOperation('sendPrivateMessage', { userId: '456', message });
    await new Promise(done => setImmediate(done));
    element.text = 'changed'; message.push({ type: 'text', text: 'injected' });
    resolve({ uidInfo: new Map([['456', 'u_456']]) });
    await pending;
    assert.equal(f.calls[0][2].length, 1); assert.equal(f.calls[0][2][0].textElement.content, 'original');
  } finally { f.services.close(); }
});

for (const [field, value] of [['msgId', undefined], ['msgSeq', {}], ['msgTime', 'garbage'], ['msgTime', '9007199254740993']] as [string, unknown][]) test(`send rejects invalid successful ${field} metadata`, async () => {
  const f = sendFixture({ send: (...args) => {
    f.callback().onMsgInfoListUpdate([{ guildId: args[1].guildId, sendStatus: 2, msgId: '42', msgSeq: '9', msgTime: '100', [field]: value }]);
    return { result: 0 };
  } });
  try { await assert.rejects(f.services.invokeOperation('sendGroupMessage', { groupId: '123', message: 'fixture only' }), /sent|receipt|metadata/i); assert.equal(f.calls.length, 1); }
  finally { f.services.close(); }
});

test('close rejects a send even when native invocation never settles', async () => {
  const f = sendFixture({ send: () => new Promise(() => {}) });
  const pending = f.services.invokeOperation('sendGroupMessage', { groupId: '123', message: 'fixture only' });
  const checked = assert.rejects(pending, /closed|abort/i);
  await new Promise(done => setImmediate(done));
  f.services.close();
  await Promise.race([checked, new Promise((_, reject) => setTimeout(() => reject(Error('close did not settle pending send')), 80))]);
  assert.equal(f.calls.length, 1);
});

test('duplicate native send correlation ID rejects before a second submission', async () => {
  const f = sendFixture({ unique: () => 'same-token' });
  try {
    await f.services.invokeOperation('sendGroupMessage', { groupId: '123', message: 'first fixture' });
    await assert.rejects(f.services.invokeOperation('sendGroupMessage', { groupId: '123', message: 'second fixture' }), /duplicate|correlation/i);
    assert.equal(f.calls.length, 1);
  } finally { f.services.close(); }
});

test('close stops pending recipient UID lookup without dispatch', async () => {
  const f = sendFixture({ uid: () => new Promise(() => {}) });
  const checked = assert.rejects(f.services.invokeOperation('sendPrivateMessage', { userId: '456', message: 'fixture' }), /closed|abort/i);
  await new Promise(done => setImmediate(done)); f.services.close();
  await Promise.race([checked, new Promise((_, reject) => setTimeout(() => reject(Error('UID close did not settle')), 80))]);
  assert.equal(f.calls.length, 0); assert.equal(f.generated(), 0);
});

test('send batch finds terminal success after sending state and captures receipt immediately', async () => {
  const f = sendFixture({ send: (...args) => {
    const terminal = { guildId: args[1].guildId, chatType: 2, peerUid: '123', sendStatus: 2, msgId: '000900719925474099312345', msgSeq: '0009', msgTime: '100' };
    f.callback().onMsgInfoListUpdate([{ ...terminal, sendStatus: 1 }, terminal]);
    terminal.msgId = 'mutated'; terminal.msgSeq = 'mutated'; terminal.msgTime = 'mutated';
    return { result: 0 };
  } });
  try { assert.deepEqual(await f.services.invokeOperation('sendGroupMessage', { groupId: '123', message: 'fixture' }), { messageId: '000900719925474099312345', sequence: '0009', time: 100 }); }
  finally { f.services.close(); }
});

test('wrong explicit peer cannot confirm send and native rejection takes precedence over a valid callback', async () => {
  const f = sendFixture({ send: (...args) => {
    f.callback().onMsgInfoListUpdate([{ guildId: args[1].guildId, chatType: 2, peerUid: '999', sendStatus: 2, msgId: '42', msgSeq: '9', msgTime: '100' }]);
    f.callback().onMsgInfoListUpdate([{ guildId: args[1].guildId, chatType: 2, peerUid: '123', sendStatus: 2, msgId: '42', msgSeq: '9', msgTime: '100' }]);
    return { result: 23 };
  } });
  try { await assert.rejects(f.services.invokeOperation('sendGroupMessage', { groupId: '123', message: 'fixture' }), { code: 23 }); assert.equal(f.calls.length, 1); }
  finally { f.services.close(); }
});

test('sending or success-no-sequence callbacks do not confirm a complete receipt; close suppresses late success', async () => {
  const f = sendFixture({ send: () => ({ result: 0 }) });
  let settled = false;
  const pending = f.services.invokeOperation('sendGroupMessage', { groupId: '123', message: 'fixture' });
  pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(done => setImmediate(done));
  f.callback().onMsgInfoListUpdate([{ guildId: 'unique-1', sendStatus: 3 }, { guildId: 'unique-1', sendStatus: 1 }]);
  await new Promise(done => setImmediate(done)); assert.equal(settled, false);
  const checked = assert.rejects(pending, /closed|abort/i); f.services.close();
  f.callback().onMsgInfoListUpdate([{ guildId: 'unique-1', sendStatus: 2, msgId: '42', msgSeq: '9', msgTime: '100' }]);
  await checked; assert.equal(f.calls.length, 1);
});

test('actual send deadline interrupts a never-settling native Promise without retry', { timeout: 15_000 }, async () => {
  const f = sendFixture({ send: () => new Promise(() => {}) });
  try { await assert.rejects(f.services.invokeOperation('sendGroupMessage', { groupId: '123', message: 'fixture' }), /timed out/); assert.equal(f.calls.length, 1); }
  finally { f.services.close(); }
});

test('callback success before stalled native return remains cancellable on close', async () => {
  const f = sendFixture({ send: (...args) => {
    f.callback().onMsgInfoListUpdate([{ guildId: args[1].guildId, sendStatus: 2, msgId: '42', msgSeq: '9', msgTime: '100' }]);
    return new Promise(() => {});
  } });
  const checked = assert.rejects(f.services.invokeOperation('sendGroupMessage', { groupId: '123', message: 'fixture' }), /closed|abort/i);
  await new Promise(done => setImmediate(done)); f.services.close();
  await Promise.race([checked, new Promise((_, reject) => setTimeout(() => reject(Error('close after callback did not settle')), 80))]);
  assert.equal(f.calls.length, 1);
});

test('callback success cannot cancel the actual deadline while native return is stalled', { timeout: 15_000 }, async () => {
  const f = sendFixture({ send: (...args) => {
    f.callback().onMsgInfoListUpdate([{ guildId: args[1].guildId, sendStatus: 2, msgId: '42', msgSeq: '9', msgTime: '100' }]);
    return new Promise(() => {});
  } });
  try { await assert.rejects(f.services.invokeOperation('sendGroupMessage', { groupId: '123', message: 'fixture' }), /timed out/); assert.equal(f.calls.length, 1); }
  finally { f.services.close(); }
});

test('synchronous native throw rejects once without an unhandled rejected waiter', async () => {
  const f = sendFixture({ send: () => { throw new Error('fake synchronous native failure'); } });
  try { await assert.rejects(f.services.invokeOperation('sendGroupMessage', { groupId: '123', message: 'fixture' }), /fake synchronous/); await new Promise(done => setImmediate(done)); assert.equal(f.calls.length, 1); }
  finally { f.services.close(); }
});
