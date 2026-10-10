import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { createNativeServices } from '../src/native-services.ts';

const nodes = () => [
  { userId: '456', nickname: 'fixture author', time: 100, text: 'fixture text' },
];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: (value: any) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<any>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function wireFields(data: Buffer): Map<number, Array<number | Buffer>> {
  let cursor = 0;
  const integer = () => {
    let value = 0,
      scale = 1;
    for (let n = 0; n < 10; n++) {
      assert.ok(cursor < data.length);
      const byte = data[cursor++];
      value += (byte & 127) * scale;
      if (!(byte & 128)) return value;
      scale *= 128;
    }
    throw Error('fixture varint overflow');
  };
  const fields = new Map<number, Array<number | Buffer>>();
  while (cursor < data.length) {
    const tag = integer(),
      field = Math.floor(tag / 8);
    let value: number | Buffer;
    if (tag % 8 === 0) value = integer();
    else {
      assert.equal(tag % 8, 2);
      const length = integer();
      assert.ok(cursor + length <= data.length);
      value = data.subarray(cursor, cursor + length);
      cursor += length;
    }
    fields.set(field, [...(fields.get(field) ?? []), value]);
  }
  return fields;
}
const field = (bytes: Buffer, n: number) => wireFields(bytes).get(n)![0];
function fixture(
  options: {
    uid?: (ids: string[]) => any;
    upload?: (...args: any[]) => any;
    unique?: () => any;
    send?: (...args: any[]) => any;
  } = {},
) {
  let listener: any;
  const steps: string[] = [],
    uploads: any[][] = [],
    sends: any[][] = [],
    conversions: string[][] = [];
  const services = createNativeServices({
    session: {
      getMsgService: () => ({
        addKernelMsgListener(value: any) {
          listener = value;
        },
        sendSsoCmdReqByContend(...args: any[]) {
          steps.push('upload');
          uploads.push(args);
          return options.upload?.(...args) ?? { rspbuffer: Buffer.from('12031a0172', 'hex') };
        },
        generateMsgUniqueId() {
          steps.push('generate');
          return options.unique?.() ?? 'native-send-token';
        },
        sendMsg(...args: any[]) {
          steps.push('send');
          sends.push(args);
          if (options.send) return options.send(...args);
          listener.onMsgInfoListUpdate([
            {
              guildId: args[1].guildId,
              chatType: args[1].chatType,
              peerUid: args[1].peerUid,
              sendStatus: 2,
              msgId: '42',
              msgSeq: '9',
              msgTime: '100',
            },
          ]);
          return { result: 0 };
        },
      }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getUixConvertService: () => ({
        getUid(ids: string[]) {
          steps.push('uid');
          conversions.push([...ids]);
          return options.uid?.(ids) ?? { uidInfo: new Map(ids.map((id) => [id, `u_${id}`])) };
        },
      }),
      getMSFService: () => ({ getServerTime: () => '100' }),
    },
    version: '7.0.2-53644',
    events: { emit: () => {} },
    identity: { userId: '789', uid: 'u_self' },
  });
  return { services, steps, uploads, sends, conversions, callback: () => listener };
}

for (const invalid of [
  [],
  Array(1),
  [nodes()[0], { ...nodes()[0], text: {} }],
  [{ ...nodes()[0], userId: '0' }],
  [{ ...nodes()[0], userId: '4294967296' }],
  [{ ...nodes()[0], time: 0 }],
])
  test('whole merged-forward input rejects before any UID or native work', async () => {
    const f = fixture();
    try {
      await assert.rejects(
        f.services.invokeOperation('sendMergedForward', {
          peer: { type: 'private', userId: '456' },
          nodes: invalid,
        }),
      );
      assert.deepEqual(f.steps, []);
    } finally {
      f.services.close();
    }
  });

for (const peer of [
  { type: 'private', userId: '456' },
  { type: 'group', groupId: '123' },
])
  test(`merged-forward ${peer.type} performs one upload then one distinct ARK send`, async () => {
    const f = fixture();
    try {
      const result = await f.services.invokeOperation('sendMergedForward', {
        peer,
        nodes: nodes(),
      });
      assert.deepEqual(result, { messageId: '42', sequence: '9', time: 100, resourceId: 'r' });
      assert.deepEqual(
        f.steps,
        peer.type === 'private'
          ? ['uid', 'upload', 'generate', 'send']
          : ['upload', 'generate', 'send'],
      );
      assert.equal(f.uploads.length, 1);
      assert.equal(f.sends.length, 1);
      assert.equal(f.uploads[0][0], 'trpc.group.long_msg_interface.MsgService.SsoSendLongMsg');
      assert.ok(Buffer.isBuffer(f.uploads[0][1]));
      const info = field(f.uploads[0][1], 2) as Buffer;
      assert.equal(field(info, 1), peer.type === 'private' ? 1 : 3);
      assert.equal(
        (field(field(info, 2) as Buffer, 2) as Buffer).toString(),
        peer.type === 'private' ? 'u_self' : '123',
      );
      const action = field(gunzipSync(field(info, 4) as Buffer), 2) as Buffer;
      const record = field(field(action, 2) as Buffer, 1) as Buffer;
      const author = field(record, 1) as Buffer;
      assert.equal(field(author, 1), 456);
      if (peer.type === 'private') assert.equal((field(author, 6) as Buffer).toString(), 'u_self');
      else assert.equal(field(field(author, 8) as Buffer, 1), 123);
      const card = JSON.parse(f.sends[0][2][0].arkElement.bytesData);
      assert.equal(f.sends[0][2][0].elementType, 10);
      assert.equal(card.meta.detail.resid, 'r');
      assert.match(
        card.extra.filename,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assert.equal(card.extra.filename, card.meta.detail.uniseq);
      assert.notEqual(card.extra.filename, 'r');
      assert.notEqual(card.extra.filename, f.sends[0][1].guildId);
      assert.notEqual(f.sends[0][1].guildId, 'r');
    } finally {
      f.services.close();
    }
  });

for (const mode of ['malformed', 'reject'] as const)
  test(`upload ${mode} stops card with sanitized partial state and no retry`, async () => {
    const f = fixture({
      upload: () =>
        mode === 'malformed'
          ? { rspbuffer: Buffer.from('1200', 'hex') }
          : Promise.reject(Error('private upstream data')),
    });
    try {
      await assert.rejects(
        f.services.invokeOperation('sendMergedForward', {
          peer: { type: 'group', groupId: '123' },
          nodes: nodes(),
        }),
        (error: any) => {
          assert.equal(error.phase, 'upload');
          assert.equal(error.progress.cardCompletion, 'not-dispatched');
          assert.ok(!error.message.includes('private upstream data'));
          return true;
        },
      );
      assert.equal(f.uploads.length, 1);
      assert.equal(f.sends.length, 0);
    } finally {
      f.services.close();
    }
  });

for (const stage of ['uid', 'upload', 'generate'] as const)
  test(`close during ${stage} prevents the next mutation`, async () => {
    const pending = deferred();
    const f = fixture({
      ...(stage === 'uid'
        ? { uid: () => pending.promise }
        : stage === 'upload'
          ? { upload: () => pending.promise }
          : { unique: () => pending.promise }),
    });
    const request = f.services.invokeOperation('sendMergedForward', {
      peer: { type: 'private', userId: '456' },
      nodes: nodes(),
    });
    const rejected = assert.rejects(request, (error: any) => {
      if (stage === 'uid') assert.match(error.message, /closed|cancel|abort/i);
      else {
        assert.equal(error.phase, stage === 'upload' ? 'upload' : 'card');
        assert.deepEqual(
          error.progress,
          stage === 'upload'
            ? { uploadCompletion: 'unknown', cardCompletion: 'not-dispatched' }
            : {
                uploadCompletion: 'resource-received',
                cardCompletion: 'not-dispatched',
                resourceId: 'r',
              },
        );
      }
      return true;
    });
    await tick();
    f.services.close();
    await rejected;
    pending.resolve(
      stage === 'uid'
        ? { uidInfo: new Map([['456', 'u_456']]) }
        : stage === 'upload'
          ? { rspbuffer: Buffer.from('12031a0172', 'hex') }
          : 'late-token',
    );
    await tick();
    assert.equal(f.sends.length, 0);
    assert.equal(f.uploads.length, stage === 'uid' ? 0 : 1);
  });

test('card failure retains received resource ID and does not upload or submit again', async () => {
  const f = fixture({ send: () => ({ result: 23 }) });
  try {
    await assert.rejects(
      f.services.invokeOperation('sendMergedForward', {
        peer: { type: 'group', groupId: '123' },
        nodes: nodes(),
      }),
      (error: any) => {
        assert.equal(error.phase, 'card');
        assert.equal(error.code, 23);
        assert.deepEqual(error.progress, {
          uploadCompletion: 'resource-received',
          cardCompletion: 'unknown',
          resourceId: 'r',
        });
        return true;
      },
    );
    assert.equal(f.uploads.length, 1);
    assert.equal(f.sends.length, 1);
  } finally {
    f.services.close();
  }
});

test('unrelated send and wrong explicit peer do not finish card; matching terminal2 after sending1 does', async () => {
  const f = fixture({ send: () => ({ result: 0 }) });
  let settled = false;
  const request = f.services.invokeOperation('sendMergedForward', {
    peer: { type: 'group', groupId: '123' },
    nodes: nodes(),
  });
  request.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await tick();
    const base = {
      sendStatus: 2,
      msgId: '42',
      msgSeq: '9',
      msgTime: '100',
      chatType: 2,
      peerUid: '123',
    };
    f.callback().onMsgInfoListUpdate([
      { ...base, guildId: 'other-send' },
      { ...base, guildId: 'native-send-token', peerUid: '999' },
    ]);
    await tick();
    assert.equal(settled, false);
    f.callback().onMsgInfoListUpdate([
      { ...base, guildId: 'native-send-token', sendStatus: 1 },
      { ...base, guildId: 'native-send-token' },
    ]);
    assert.deepEqual(await request, { messageId: '42', sequence: '9', time: 100, resourceId: 'r' });
  } finally {
    f.services.close();
  }
});

test('actual upload deadline stops card without retry', { timeout: 8000 }, async () => {
  const f = fixture({ upload: () => new Promise(() => {}) });
  try {
    await assert.rejects(
      f.services.invokeOperation('sendMergedForward', {
        peer: { type: 'group', groupId: '123' },
        nodes: nodes(),
      }),
      (error: any) => {
        assert.equal(error.phase, 'upload');
        assert.equal(error.progress.uploadCompletion, 'unknown');
        assert.equal(error.progress.cardCompletion, 'not-dispatched');
        return true;
      },
    );
    assert.equal(f.uploads.length, 1);
    assert.equal(f.sends.length, 0);
  } finally {
    f.services.close();
  }
});

test('service captures nodes, options and peer before recipient lookup settles', async () => {
  const uid = deferred(),
    f = fixture({ uid: () => uid.promise });
  const peer = { type: 'private', userId: '456' },
    input = nodes(),
    options = { title: 'original title' };
  const request = f.services.invokeOperation('sendMergedForward', { peer, nodes: input, options });
  peer.userId = '999';
  input[0].text = 'mutated';
  input[0].nickname = 'mutated';
  options.title = 'mutated';
  uid.resolve({ uidInfo: new Map([['456', 'u_456']]) });
  try {
    await request;
    assert.equal(f.sends[0][1].peerUid, 'u_456');
    const card = JSON.parse(f.sends[0][2][0].arkElement.bytesData);
    assert.equal(card.meta.detail.source, 'original title');
    assert.equal(card.meta.detail.news[0].text, 'fixture author:fixture text');
  } finally {
    f.services.close();
  }
});

test('close after card dispatch rejects stalled native return with uploaded resource retained', async () => {
  const late = deferred(),
    f = fixture({ send: () => late.promise });
  const request = f.services.invokeOperation('sendMergedForward', {
    peer: { type: 'group', groupId: '123' },
    nodes: nodes(),
  });
  const rejected = assert.rejects(request, (error: any) => {
    assert.equal(error.phase, 'card');
    assert.deepEqual(error.progress, {
      uploadCompletion: 'resource-received',
      cardCompletion: 'unknown',
      resourceId: 'r',
    });
    return true;
  });
  await tick();
  f.services.close();
  await rejected;
  late.reject(Error('private late native rejection'));
  await tick();
  assert.equal(f.uploads.length, 1);
  assert.equal(f.sends.length, 1);
});
