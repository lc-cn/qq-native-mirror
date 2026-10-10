import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeServices } from '../src/native-services.ts';
import { buildMergedForwardCard } from '../src/features/forward/merged-forward-card.ts';
import { checkReceivedForwardServices } from '../scripts/received-forward-consumer-contract.mjs';

test('received merged forwards preserve mixed query/live order, raw identity and queued snapshots without extra queries', async () => {
  await checkReceivedForwardServices({ createNativeServices, buildMergedForwardCard });
});

for (const method of ['getMessage', 'getHistory', 'getForwardMessages'] as const)
  test(`${method} captures received card fields before required sender lookup settles`, async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => {
      resolve = done;
    });
    const original = {
      msgId: '1',
      msgSeq: '9',
      msgTime: '100',
      chatType: 2,
      peerUid: '123',
      senderUin: '0',
      senderUid: 'u_sender',
      elements: [
        buildMergedForwardCard({
          resourceId: 'r',
          cardId: '00000000-0000-4000-8000-000000000000',
          nodes: [{ displayName: 'fixture', text: 'text' }],
        }),
        {
          elementType: 16,
          multiForwardMsgElement: {
            resId: 'native-r',
            fileName: 'native-file',
            xmlContent: '<opaque-fixture />',
          },
        },
      ],
    };
    let calls = 0,
      lookups = 0;
    const result = () => {
      calls++;
      return { result: 0, msgList: [original] };
    };
    const services = createNativeServices({
      session: {
        getMsgService: () => ({
          addKernelMsgListener() {},
          getMsgsByMsgId: result,
          getMsgsIncludeSelf: result,
          getMultiMsg: result,
        }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getUixConvertService: () => ({
          getUin() {
            lookups++;
            return pending;
          },
        }),
      },
      version: '7.0.2-53644',
      events: { emit: () => {} },
    });
    try {
      const request = services.invokeOperation(method, {
        peer: { type: 'group', groupId: '123' },
        messageId: '1',
        rootMessageId: '10',
        parentMessageId: '20',
        options: { limit: 3 },
      });
      for (let i = 0; i < 3; i++) await new Promise((done) => setImmediate(done));
      assert.equal(lookups, 1);
      (original.elements[0] as ReturnType<typeof buildMergedForwardCard>).arkElement.bytesData =
        '{}';
      (
        original.elements[1] as { multiForwardMsgElement: { resId: string; fileName: string } }
      ).multiForwardMsgElement.resId = 'mutated';
      (
        original.elements[1] as { multiForwardMsgElement: { resId: string; fileName: string } }
      ).multiForwardMsgElement.fileName = 'mutated';
      resolve({ uinInfo: new Map([['u_sender', '456']]) });
      const value = (await request) as any,
        message = Array.isArray(value) ? value[0] : value;
      assert.deepEqual(
        message.elements.map((element: any) => element.resourceId),
        ['r', 'native-r'],
      );
      assert.equal(message.elements[1].cardId, 'native-file');
      assert.equal(message.raw, original);
      assert.equal(calls, 1);
      assert.equal(lookups, 1);
    } finally {
      services.close();
    }
  });
