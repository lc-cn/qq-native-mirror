import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeServices } from '../src/native-services.ts';
import { faceElement } from '../src/features/messages/face-input.ts';

const cases = [
  { id: 0, text: '/惊讶', type: 1 },
  { id: 14, text: '/微笑', type: 1 },
  { id: 222, text: '/抱抱', type: 2 },
  { id: 114, text: '/篮球', type: 3, stickerType: 2, packId: '1', stickerId: '13' },
  { id: 333, text: '/烟花', type: 3, stickerType: 1, packId: '1', stickerId: '19' },
  { id: 428, text: '/收到', type: 2, stickerType: 0, packId: '0', stickerId: '0' },
];

function fixture() {
  let listener: any;
  let generated = 0;
  const sent: any[][] = [];
  const msg = {
    addKernelMsgListener(value: any) {
      listener = value;
    },
    generateMsgUniqueId() {
      generated++;
      return 'unique';
    },
    sendMsg(...args: any[]) {
      sent.push(args);
      queueMicrotask(() =>
        listener.onMsgInfoListUpdate([
          { guildId: 'unique', sendStatus: 2, msgId: '42', msgSeq: '9', msgTime: '100' },
        ]),
      );
      return { result: 0 };
    },
  };
  const session = {
    getMsgService: () => msg,
    getGroupService: () => ({ addKernelGroupListener() {} }),
    getBuddyService: () => ({ addKernelBuddyListener() {} }),
    getUixConvertService: () => ({
      getUid(ids: string[]) {
        return { uidInfo: new Map(ids.map((id) => [id, 'u_a'])) };
      },
    }),
    getMSFService: () => ({ getServerTime: () => '100' }),
  };
  const services = createNativeServices({
    session: session,
    version: '7.0.2-53644',
    events: { emit: () => {} },
  });
  return { services, msg, sent, generated: () => generated };
}

for (const value of cases) {
  test(`face ${value.id} exact native metadata`, () => {
    const native = faceElement(value.id);
    assert.equal(native.elementType, 6);
    assert.equal(native.elementId, '');
    assert.equal(native.faceElement.faceIndex, value.id);
    assert.equal(native.faceElement.faceType, value.type);
    assert.equal(native.faceElement.faceText, value.text);
    assert.equal(native.faceElement.sourceType, 1);
    assert.equal(native.faceElement.stickerType, value.stickerType);
    assert.equal(native.faceElement.packId, value.packId);
    assert.equal(native.faceElement.stickerId, value.stickerId);
  });
}

for (const method of ['sendGroupMessage', 'sendPrivateMessage'] as const) {
  test(`${method} preserves mixed text/face order`, async () => {
    const f = fixture();
    try {
      await f.services.invokeOperation(method, {
        ...(method === 'sendGroupMessage' ? { groupId: '123' } : { userId: '456' }),
        message: [
          { type: 'text', text: 'before' },
          { type: 'face', id: 114 },
          { type: 'text', text: 'after' },
        ],
      });
      assert.equal(f.generated(), 1);
      assert.equal(f.sent.length, 1);
      const elements = f.sent[0][2];
      assert.equal(elements[0].textElement.content, 'before');
      assert.equal(elements[1].faceElement.faceIndex, 114);
      assert.equal(elements[1].faceElement.stickerId, '13');
      assert.equal(elements[2].textElement.content, 'after');
    } finally {
      f.services.close();
    }
  });
}

for (const id of [99999, -1, 1.5, '14']) {
  test(`invalid face ${JSON.stringify(id)} does not generate or dispatch`, async () => {
    const f = fixture();
    try {
      await assert.rejects(
        f.services.invokeOperation('sendPrivateMessage', {
          userId: '456',
          message: [{ type: 'face', id }],
        }),
        /Face id|Unsupported QQ face/,
      );
      assert.equal(f.generated(), 0);
      assert.equal(f.sent.length, 0);
    } finally {
      f.services.close();
    }
  });
}

test('face send preserves native rejection code without retry', async () => {
  const f = fixture();
  f.msg.sendMsg = (...args: any[]) => {
    f.sent.push(args);
    return { result: 23, errMsg: 'fixture reject' };
  };
  try {
    await assert.rejects(
      f.services.invokeOperation('sendGroupMessage', {
        groupId: '123',
        message: [{ type: 'face', id: 14 }],
      }),
      { code: 23 },
    );
    assert.equal(f.generated(), 1);
    assert.equal(f.sent.length, 1);
  } finally {
    f.services.close();
  }
});
