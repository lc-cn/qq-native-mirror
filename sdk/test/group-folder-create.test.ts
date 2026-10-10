import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroupFolder } from '../src/features/groups/group-file-operations.ts';
import { captureCreateGroupFolder } from '../src/features/groups/group-file-input.ts';
import { NativeServiceLifetime } from '../src/runtime/native-service-lifetime.ts';
function result() {
  return {
    result: 0,
    resultWithGroupItem: {
      result: { retCode: 0 },
      groupItem: {
        peerId: '00123',
        folderInfo: { folderId: ' opaque/id ', parentFolderId: '', folderName: ' name ' },
      },
    },
  };
}
function fixture(response: unknown = result()) {
  const life = new NativeServiceLifetime();
  let calls = 0,
    gets = 0;
  const service = {
    createGroupFolder(group: string, name: string) {
      assert.equal(this, service);
      assert.deepEqual([group, name], ['00123', ' name ']);
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
test('creation preserves spelling and copies one native folder carrier', async () => {
  const raw = result(),
    f = fixture(raw);
  const dto = await createGroupFolder(f.context, '00123', ' name ');
  assert.deepEqual(dto, {
    groupId: '00123',
    folderId: ' opaque/id ',
    parentFolderId: '',
    name: ' name ',
  });
  raw.resultWithGroupItem.groupItem.folderInfo.folderName = 'changed';
  assert.equal(dto.name, ' name ');
  assert.equal(f.calls(), 1);
  f.life.close();
});
test('creation invalid inputs fail before service acquisition without coercion', async () => {
  let coerces = 0;
  for (const [group, name] of [
    ['0', 'name'],
    ['18446744073709551616', 'name'],
    ['123', ' '],
    [
      '123',
      {
        toString() {
          coerces++;
          return 'name';
        },
      },
    ],
  ]) {
    const f = fixture();
    await assert.rejects(createGroupFolder(f.context, group, name));
    assert.equal(f.gets(), 0);
    f.life.close();
  }
  assert.equal(coerces, 0);
  assert.deepEqual(captureCreateGroupFolder('18446744073709551615', ' x '), {
    groupId: '18446744073709551615',
    name: ' x ',
  });
});
test('creation rejects two status failures and malformed folder carriers without retry', async () => {
  for (const mutate of [
    (r: ReturnType<typeof result>) => {
      r.result = 23;
    },
    (r: ReturnType<typeof result>) => {
      r.resultWithGroupItem.result.retCode = 42;
    },
    (r: ReturnType<typeof result>) => {
      r.resultWithGroupItem.groupItem.peerId = '124';
    },
  ]) {
    const r = result();
    mutate(r);
    const f = fixture(r);
    await assert.rejects(createGroupFolder(f.context, '00123', ' name '));
    assert.equal(f.calls(), 1);
    f.life.close();
  }
  for (const item of [{ peerId: '123' }, [], Array(1)]) {
    const f = fixture({
      result: 0,
      resultWithGroupItem: { result: { retCode: 0 }, groupItem: item },
    });
    await assert.rejects(createGroupFolder(f.context, '00123', ' name '));
    assert.equal(f.calls(), 1);
    f.life.close();
  }
});
test('creation descriptor getters are not invoked', async () => {
  let getters = 0;
  for (const key of ['result', 'resultWithGroupItem']) {
    const r = result();
    Object.defineProperty(r, key, {
      get() {
        getters++;
        throw Error('private');
      },
    });
    const f = fixture(r);
    await assert.rejects(createGroupFolder(f.context, '00123', ' name '));
    f.life.close();
  }
  assert.equal(getters, 0);
});
test('creation method getter close prevents native dispatch', async () => {
  const f = fixture();
  Object.defineProperty(f.service, 'createGroupFolder', {
    get() {
      f.life.close();
      return () => {
        throw Error('must not dispatch');
      };
    },
  });
  await assert.rejects(createGroupFolder(f.context, '00123', ' name '));
  assert.equal(f.calls(), 0);
});
test('creation close cancels pending acknowledgement and observes late failure', async () => {
  let reject!: (e: Error) => void;
  const pending = new Promise((_, fail) => {
    reject = fail;
  });
  const f = fixture(pending);
  const operation = assert.rejects(createGroupFolder(f.context, '00123', ' name '));
  f.life.close();
  await operation;
  reject(Error('late'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls(), 1);
  await assert.rejects(createGroupFolder(f.context, '00123', ' name '));
  assert.equal(f.calls(), 1);
});
