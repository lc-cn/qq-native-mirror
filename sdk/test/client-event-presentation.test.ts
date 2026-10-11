import assert from 'node:assert/strict';
import test from 'node:test';
import { createClientEventPresentation } from '../src/client/client-event-presentation.ts';

function fixture() {
  const events: [string, unknown][] = [];
  return {
    events,
    presentation: createClientEventPresentation((event, payload) => events.push([event, payload])),
  };
}

test('presentation forwards unknown payloads without wrapping, copying or coercion', () => {
  const { presentation, events } = fixture();
  const value = { privateDetail: Symbol('opaque'), toString: () => assert.fail('coercion') };
  for (const payload of [value, null, undefined, false, 0, 'opaque']) {
    presentation.forward('future-worker-event', payload);
    assert.equal(events.at(-1)![0], 'future-worker-event');
    assert.equal(events.at(-1)![1], payload);
  }
  assert.deepEqual(presentation.audit, []);
});

test('QR presentation decodes in place once and preserves the original event object', () => {
  const { presentation, events } = fixture();
  const payload = { image: Buffer.from([0, 255, 42]).toString('base64'), untouched: 'fixture' };
  presentation.forward('qrcode', payload);
  assert.equal(events[0]![1], payload);
  assert.deepEqual(payload.image, Buffer.from([0, 255, 42]));
  const buffer = payload.image;
  presentation.forward('qrcode', payload);
  assert.equal(payload.image, buffer);
  assert.equal(payload.untouched, 'fixture');
});

test('login error presentation creates Error while unrelated failures remain opaque', () => {
  const { presentation, events } = fixture();
  const raw = { message: 'fixture rejection' };
  presentation.forward('login-error', raw);
  assert.ok(events[0]![1] instanceof Error);
  assert.equal(events[0]![1].message, 'fixture rejection');
  assert.equal(raw.message, 'fixture rejection');
  presentation.forward('login-error', null);
  assert.ok(events[1]![1] instanceof Error);
  assert.equal(events[1]![1].message, 'Native login failed');
  const failure = new Error('opaque reconnect failure');
  presentation.forward('reconnect-error', failure);
  assert.equal(events[2]![1], failure);
});

test('message delivery emits the original event then the legacy alias with the same payload', () => {
  const { presentation, events } = fixture();
  const group = { peer: { type: 'group' }, messageId: '123' };
  presentation.forward('message', group);
  assert.deepEqual(
    events.map(([name]) => name),
    ['message', 'message.group'],
  );
  assert.ok(events.every(([, payload]) => payload === group));
  events.length = 0;
  presentation.forward('message', undefined);
  assert.deepEqual(events, [
    ['message', undefined],
    ['message.private', undefined],
  ]);
});

test('synchronous observers control alias ordering and their original errors propagate', () => {
  const payload = { peer: { type: 'private' } };
  const names: string[] = [];
  const failure = new Error('observer failed');
  const presentation = createClientEventPresentation((event) => {
    names.push(event);
    if (event === 'message') payload.peer.type = 'group';
    if (event === 'message.group') throw failure;
  });
  assert.throws(
    () => presentation.forward('message', payload),
    (error) => error === failure,
  );
  assert.deepEqual(names, ['message', 'message.group']);
  const firstFailure = createClientEventPresentation(() => {
    throw failure;
  });
  assert.throws(
    () => firstFailure.forward('message', payload),
    (error) => error === failure,
  );
});

test('shape audit is bounded, increments retained keys, and never exposes stored arrays or arguments', () => {
  const { presentation, events } = fixture();
  const payload = { family: 'Msg', name: 'receive', argumentTypes: ['object'], args: ['private'] };
  presentation.forward('native-callback', payload);
  payload.argumentTypes[0] = 'changed';
  const snapshot = presentation.audit;
  assert.deepEqual(snapshot, [
    { family: 'Msg', name: 'receive', argumentTypes: ['object'], count: 1 },
  ]);
  snapshot[0]!.argumentTypes[0] = 'changed snapshot';
  snapshot[0]!.count = 99;
  snapshot.length = 0;
  for (let i = 0; i < 150; i++)
    presentation.forward('native-callback', {
      family: 'Session',
      name: `method${i}`,
      argumentTypes: [],
    });
  presentation.forward('native-callback', {
    family: 'Msg',
    name: 'receive',
    argumentTypes: ['object'],
  });
  presentation.forward('native-callback', { family: 'Msg', name: 'invalid', argumentTypes: [1] });
  assert.equal(presentation.audit.length, 128);
  assert.deepEqual(presentation.audit[0], {
    family: 'Msg',
    name: 'receive',
    argumentTypes: ['object'],
    count: 2,
  });
  assert.equal(events[0]![1], payload);
  assert.equal(
    presentation.audit.some((row) => row.name === 'invalid'),
    false,
  );
});
