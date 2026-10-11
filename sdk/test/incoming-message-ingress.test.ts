import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createIncomingMessageDelivery,
  type IncomingSystemMessagePort,
} from '../src/features/messages/incoming-message-delivery.ts';
import { projectNativeMessage } from '../src/features/messages/inbound-messages.ts';
import { decodeElements } from '../src/features/messages/inbound-elements.ts';

function fixture() {
  const order: string[] = [];
  let provider: () => readonly IncomingSystemMessagePort[] = () => [];
  const delivery = createIncomingMessageDelivery({
    getSystemMessageHandlers() {
      order.push('provider');
      return provider();
    },
    project(value, raw) {
      order.push('project');
      return projectNativeMessage(value, decodeElements(value.elements), new Map(), raw);
    },
    resolveMessages() {
      order.push('lookup');
      return Promise.resolve([]);
    },
    emitMessage() {
      order.push('emit');
    },
    diagnostic(stage) {
      order.push(stage);
    },
    dispatch() {
      order.push('dispatch');
    },
  });
  return {
    delivery,
    order,
    provider(value: () => readonly IncomingSystemMessagePort[]) {
      provider = value;
    },
  };
}
function batch() {
  return [
    {
      chatType: 1,
      peerUid: 'u_peer',
      peerUin: '123',
      senderUid: 'u_sender',
      senderUin: '456',
      sendNickName: 'fixture',
      msgId: '1',
      msgSeq: '1',
      msgTime: '100',
      elements: [],
    },
  ];
}
test('ingress rejects invalid batch before provider, ports or lookup', () => {
  const f = fixture();
  for (const value of [null, {}, 'invalid', undefined]) f.delivery.receive(value);
  assert.deepEqual(f.order, Array(4).fill('invalid-native-message-batch'));
  f.delivery.close();
});
test('ingress preserves group then friend then ordinary order and original batch identity', () => {
  const f = fixture(),
    input = batch();
  const port = (name: string, candidate: boolean): IncomingSystemMessagePort => ({
    hasCandidate(raw) {
      assert.equal(this, ports[name]);
      assert.equal(raw, input);
      f.order.push(`${name}:candidate`);
      return candidate;
    },
    receive(raw) {
      assert.equal(this, ports[name]);
      assert.equal(raw, input);
      f.order.push(`${name}:receive`);
    },
  });
  const ports: Record<string, IncomingSystemMessagePort> = {
    group: port('group', true),
    friend: port('friend', false),
  };
  f.provider(() => [ports.group!, ports.friend!]);
  f.delivery.receive(input);
  assert.deepEqual(f.order, [
    'provider',
    'group:candidate',
    'group:receive',
    'friend:candidate',
    'project',
    'emit',
    'dispatch',
  ]);
  f.delivery.close();
});
for (const phase of [
  'provider',
  'candidateGetter',
  'candidate',
  'receiveGetter',
  'receive',
] as const) {
  for (const throws of [false, true]) {
    test(`ingress ${phase} close${throws ? ' plus throw' : ''} stops later processing`, () => {
      const f = fixture();
      const error = new Error('original ingress error');
      const retire = () => {
        f.order.push('retire');
        f.delivery.close();
        if (throws) throw error;
      };
      const first: IncomingSystemMessagePort = {
        get hasCandidate() {
          if (phase === 'candidateGetter') retire();
          return function () {
            if (phase === 'candidate') retire();
            return true;
          };
        },
        get receive() {
          if (phase === 'receiveGetter') retire();
          return function () {
            if (phase === 'receive') retire();
          };
        },
      };
      const later: IncomingSystemMessagePort = {
        hasCandidate() {
          throw Error('later predicate must not run');
        },
        receive() {
          throw Error('later receive must not run');
        },
      };
      f.provider(() => {
        if (phase === 'provider') retire();
        return [first, later];
      });
      if (throws)
        assert.throws(
          () => f.delivery.receive(batch()),
          (value: unknown) => value === error,
        );
      else f.delivery.receive(batch());
      assert.deepEqual(f.order, ['provider', 'retire']);
    });
  }
  test(`ingress active ${phase} exception preserves identity and stops fanout`, () => {
    const f = fixture(),
      error = new Error('active original');
    const fail = () => {
      throw error;
    };
    const first: IncomingSystemMessagePort = {
      get hasCandidate() {
        if (phase === 'candidateGetter') fail();
        return () => {
          if (phase === 'candidate') fail();
          return true;
        };
      },
      get receive() {
        if (phase === 'receiveGetter') fail();
        return () => {
          if (phase === 'receive') fail();
        };
      },
    };
    f.provider(() => {
      if (phase === 'provider') fail();
      return [first];
    });
    assert.throws(
      () => f.delivery.receive(batch()),
      (value: unknown) => value === error,
    );
    assert.deepEqual(f.order, ['provider']);
    f.delivery.close();
  });
}
test('ingress remains compatible without system handlers', () => {
  const order: string[] = [];
  const delivery = createIncomingMessageDelivery({
    project(value, raw) {
      return projectNativeMessage(value, [], new Map(), raw);
    },
    resolveMessages() {
      throw Error('unexpected lookup');
    },
    emitMessage() {
      order.push('emit');
    },
    diagnostic() {
      throw Error('unexpected diagnostic');
    },
    dispatch() {
      order.push('dispatch');
    },
  });
  delivery.receive(batch());
  assert.deepEqual(order, ['emit', 'dispatch']);
  delivery.close();
});
