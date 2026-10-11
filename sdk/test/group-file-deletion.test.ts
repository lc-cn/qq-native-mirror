import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteGroupFile } from '../src/features/groups/group-file-deletion.ts';
import { NativeServiceLifetime } from '../src/runtime/native-service-lifetime.ts';
function ack() {
  return {
    result: 0,
    transGroupFileResult: {
      result: { retCode: 0 },
      successFileIdList: [' opaque/id '],
      failFileIdList: [],
    },
  };
}
function fixture(response: unknown = ack()) {
  const life = new NativeServiceLifetime();
  let calls = 0;
  let gets = 0;
  const service = {
    deleteGroupFile(group: string, params: number[], files: string[]) {
      assert.equal(this, service);
      assert.deepEqual([group, params, files], ['00123', [102], [' opaque/id ']]);
      calls++;
      return response;
    },
  };
  return {
    life,
    service,
    context: {
      signal: life.signal,
      awaitAlive: life.awaitAlive,
      getRichMediaService() {
        gets++;
        return service;
      },
    },
    calls: () => calls,
    gets: () => gets,
  };
}
test('file deletion preserves receiver, opaque ID and exact request with one ACK', async () => {
  const f = fixture();
  try {
    assert.equal(await deleteGroupFile(f.context, '00123', ' opaque/id '), undefined);
    assert.equal(f.calls(), 1);
  } finally {
    f.life.close();
  }
});
test('file deletion invalid input fails before acquisition without coercion', async () => {
  let coercions = 0;
  for (const [group, file] of [
    ['0', 'id'],
    ['18446744073709551616', 'id'],
    ['123', ''],
    [
      '123',
      {
        toString() {
          coercions++;
          return 'id';
        },
      },
    ],
  ]) {
    const f = fixture();
    try {
      await assert.rejects(deleteGroupFile(f.context, group, file));
      assert.equal(f.gets(), 0);
      assert.equal(f.calls(), 0);
    } finally {
      f.life.close();
    }
  }
  assert.equal(coercions, 0);
});
for (const layer of ['outer', 'inner'])
  test(`file deletion rejects ${layer} failure without wording or retry`, async () => {
    const raw = ack();
    if (layer === 'outer') raw.result = 23;
    else raw.transGroupFileResult.result.retCode = 42;
    const f = fixture({ ...raw, errMsg: 'private native wording' });
    try {
      await assert.rejects(deleteGroupFile(f.context, '00123', ' opaque/id '), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes('private native wording'));
        return true;
      });
      assert.equal(f.calls(), 1);
    } finally {
      f.life.close();
    }
  });
test('file deletion rejects missing, wrong, duplicate, sparse and failed success records', async () => {
  const base = ack().transGroupFileResult;
  for (const body of [
    { ...base, successFileIdList: ['other'] },
    { ...base, successFileIdList: [] },
    { ...base, successFileIdList: [' opaque/id ', ' opaque/id '] },
    { ...base, successFileIdList: new Array(1) },
    { ...base, failFileIdList: [' opaque/id '] },
    { result: { retCode: 0 }, failFileIdList: [] },
    { ...base, result: { retCode: '0' } },
  ]) {
    const f = fixture({ result: 0, transGroupFileResult: body });
    try {
      await assert.rejects(deleteGroupFile(f.context, '00123', ' opaque/id '));
      assert.equal(f.calls(), 1);
    } finally {
      f.life.close();
    }
  }
});
test('file deletion projected getters never execute', async () => {
  for (const field of [
    'result',
    'transGroupFileResult',
    'retCode',
    'successFileIdList',
    'failFileIdList',
    'element',
  ]) {
    let reads = 0;
    const raw = ack();
    const target =
      field === 'retCode'
        ? raw.transGroupFileResult.result
        : field === 'successFileIdList' || field === 'failFileIdList'
          ? raw.transGroupFileResult
          : field === 'element'
            ? raw.transGroupFileResult.successFileIdList
            : raw;
    Object.defineProperty(target, field === 'element' ? '0' : field, {
      get() {
        reads++;
        throw new Error('must not execute');
      },
    });
    const f = fixture(raw);
    try {
      await assert.rejects(deleteGroupFile(f.context, '00123', ' opaque/id '));
      assert.equal(reads, 0);
    } finally {
      f.life.close();
    }
  }
});
for (const stage of ['acquisition', 'method'])
  test(`file deletion close during ${stage} prevents dispatch`, async () => {
    const f = fixture();
    if (stage === 'acquisition')
      f.context.getRichMediaService = () => {
        f.life.close();
        return f.service;
      };
    else {
      const method = f.service.deleteGroupFile;
      Object.defineProperty(f.service, 'deleteGroupFile', {
        get() {
          f.life.close();
          return method;
        },
      });
    }
    await assert.rejects(deleteGroupFile(f.context, '00123', ' opaque/id '));
    assert.equal(f.calls(), 0);
  });
test('file deletion pending close rejects and observes late native failure without retry', async () => {
  let rejectLate: (error: Error) => void = () => {
    throw new Error('not initialized');
  };
  const pending = new Promise<unknown>((_resolve, reject) => {
    rejectLate = reject;
  });
  const f = fixture(pending);
  const request = deleteGroupFile(f.context, '00123', ' opaque/id ');
  const rejected = assert.rejects(request);
  f.life.close();
  await rejected;
  rejectLate(new Error('late native failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.calls(), 1);
});

for (const stage of ['acquisition', 'method']) {
  test(`file deletion ${stage} close then throw preserves exact retirement reason`, async () => {
    const f = fixture();
    const opaque = new Error('opaque native getter failure');
    if (stage === 'acquisition') {
      f.context.getRichMediaService = () => {
        f.life.close();
        throw opaque;
      };
    } else {
      Object.defineProperty(f.service, 'deleteGroupFile', {
        get() {
          f.life.close();
          throw opaque;
        },
      });
    }
    await assert.rejects(deleteGroupFile(f.context, '00123', ' opaque/id '), (error: unknown) => {
      assert.equal(error, f.life.signal.reason);
      assert.notEqual(error, opaque);
      return true;
    });
    assert.equal(f.calls(), 0);
  });
  test(`file deletion active ${stage} failure preserves original identity`, async () => {
    const f = fixture();
    const opaque = new Error('opaque active native getter failure');
    if (stage === 'acquisition')
      f.context.getRichMediaService = () => {
        throw opaque;
      };
    else
      Object.defineProperty(f.service, 'deleteGroupFile', {
        get() {
          throw opaque;
        },
      });
    try {
      await assert.rejects(deleteGroupFile(f.context, '00123', ' opaque/id '), (error: unknown) => {
        assert.equal(error, opaque);
        return true;
      });
      assert.equal(f.calls(), 0);
    } finally {
      f.life.close();
    }
  });
}

test('file deletion array descriptor retirement prevents reading subsequent receipt fields', async () => {
  const f = fixture();
  let laterReads = 0;
  const raw = ack();
  raw.transGroupFileResult.successFileIdList = new Proxy([' opaque/id '], {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'length') {
        f.life.close();
        throw new Error('opaque descriptor failure');
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const details = new Proxy(raw.transGroupFileResult, {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'failFileIdList') laterReads++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  f.service.deleteGroupFile = function () {
    assert.equal(this, f.service);
    return { result: 0, transGroupFileResult: details };
  };
  await assert.rejects(deleteGroupFile(f.context, '00123', ' opaque/id '), (error: unknown) => {
    assert.equal(error, f.life.signal.reason);
    return true;
  });
  assert.equal(laterReads, 0);
});
