import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import test from 'node:test';
import { QQClient } from '../src/index.ts';
import { prepareCommand, validateCommandFlags } from '../src/cli/command-plan.ts';
import { createNativeServices } from '../src/native-services.ts';
import type { NativeContractProfile } from '../src/native/native-contracts.ts';

function servicesFixture(profile: NativeContractProfile | undefined, version: string) {
  let acquisitions = 0;
  const calls: unknown[][] = [];
  const richMedia = {
    deleteGroupFile(groupId: string, params: number[], files: string[]) {
      assert.equal(this, richMedia);
      calls.push([groupId, params, files]);
      return Promise.resolve({
        result: 0,
        transGroupFileResult: {
          result: { retCode: 0 },
          successFileIdList: [...files],
          failFileIdList: [],
        },
      });
    },
  };
  const services = createNativeServices({
    session: {
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getRichMediaService() {
        acquisitions++;
        return richMedia;
      },
    },
    version,
    binaryProfile: profile,
    events: { emit() {} },
  });
  return { services, calls, acquisitions: () => acquisitions };
}

test('delete file: six independent profiles dispatch once; unsupported identities acquire nothing', async () => {
  // Evidence is independent of the implementation capability registry.
  const evidence = JSON.parse(
    readFileSync(
      new URL('../docs/evidence/group-file-delete-contract.json', import.meta.url),
      'utf8',
    ),
  ) as {
    profiles: NativeContractProfile[];
    nativeExecuted: boolean;
    accountUsed: boolean;
  };
  assert.equal(evidence.profiles.length, 6);
  assert.equal(new Set(evidence.profiles.map((p) => `${p.platform}/${p.arch}`)).size, 6);
  assert.equal(evidence.nativeExecuted, false);
  assert.equal(evidence.accountUsed, false);
  for (const profile of evidence.profiles) {
    const f = servicesFixture(profile, profile.clientVersion);
    try {
      assert.equal(f.acquisitions(), 0);
      await f.services.invokeOperation('deleteGroupFile', {
        groupId: '000123',
        fileId: ' opaque/file ',
      });
      assert.deepEqual(f.calls, [['000123', [102], [' opaque/file ']]]);
      assert.equal(f.acquisitions(), 1);
    } finally {
      f.services.close();
    }
    for (const [candidate, version] of [
      [undefined, profile.clientVersion],
      [{ ...profile, platform: 'unknown' }, profile.clientVersion],
      [{ ...profile, arch: 'unknown' }, profile.clientVersion],
      [{ ...profile, wrapperSha256: '0'.repeat(64) }, profile.clientVersion],
      [{ ...profile, clientVersion: 'unverified' }, 'unverified'],
      [profile, 'unverified'],
    ] as const) {
      const rejected = servicesFixture(candidate, version);
      try {
        await assert.rejects(
          rejected.services.invokeOperation('deleteGroupFile', { groupId: '123', fileId: 'file' }),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(Reflect.get(error, 'code'), 'unsupported-native-contract');
            return true;
          },
        );
        assert.equal(rejected.acquisitions(), 0);
        assert.equal(rejected.calls.length, 0);
      } finally {
        rejected.services.close();
      }
    }
  }
});

class ControlledWorker extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  requests: Record<string, unknown>[] = [];
  send(value: Record<string, unknown>, callback: (error: Error | null) => void) {
    this.requests.push(value);
    callback(null);
    queueMicrotask(() => {
      this.emit('message', { id: value.id, result: undefined });
      if (value.method === 'close') {
        this.connected = false;
        this.exitCode = 0;
        this.emit('exit', 0, null);
      }
    });
  }
  kill() {
    this.connected = false;
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }
}

test('delete file: invalid JavaScript input rejects before public IPC and composition acquisition', async () => {
  const worker = new ControlledWorker();
  const client = new QQClient(worker as unknown as ChildProcess, 500);
  worker.emit('message', { event: 'ready', payload: { uin: '456', uid: 'u_self' } });
  const f = servicesFixture(undefined, 'unverified');
  try {
    for (const fileId of ['', 42, null, undefined, {}]) {
      await assert.rejects(async () =>
        Reflect.apply(client.deleteGroupFile, client, ['123', fileId]),
      );
      await assert.rejects(
        f.services.invokeOperation('deleteGroupFile', { groupId: '123', fileId }),
      );
    }
    assert.equal(worker.requests.length, 0);
    assert.equal(f.acquisitions(), 0);
    assert.equal(f.calls.length, 0);
  } finally {
    f.services.close();
    await client.close();
  }
});

test('delete file CLI captures flags before action and rejects missing or extra flags', async () => {
  const worker = new ControlledWorker();
  const client = new QQClient(worker as unknown as ChildProcess, 500);
  worker.emit('message', { event: 'ready', payload: { uin: '456', uid: 'u_self' } });
  try {
    const flags = { 'group-id': '000123', 'file-id': 'opaque/file' };
    const action = await prepareCommand('group-file-delete', flags);
    flags['group-id'] = '999';
    flags['file-id'] = 'changed';
    await action(client);
    assert.equal(worker.requests.length, 1);
    assert.deepEqual(
      worker.requests[0] && {
        method: worker.requests[0].method,
        groupId: worker.requests[0].groupId,
        fileId: worker.requests[0].fileId,
      },
      { method: 'deleteGroupFile', groupId: '000123', fileId: 'opaque/file' },
    );
    await assert.rejects(prepareCommand('group-file-delete', { 'group-id': '123' }));
    assert.throws(() =>
      validateCommandFlags('group-file-delete', {
        'group-id': '123',
        'file-id': 'file',
        extra: 'value',
      }),
    );
    assert.equal(worker.requests.length, 1);
  } finally {
    await client.close();
  }
});
