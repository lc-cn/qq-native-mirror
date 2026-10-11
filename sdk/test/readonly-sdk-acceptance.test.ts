import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runReadonlySdkAcceptance,
  type ReadonlyAcceptanceBatch,
  type ReadonlyAcceptanceClient,
  type ReadonlyAcceptanceRuntime,
} from '../scripts/readonly-sdk-acceptance.ts';
import type { Message, QQClient } from '../src/index.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const queries = [
  'listFriends',
  'listGroups',
  'getGroupMembers:first-group-if-present',
  'getHistory:private-8596238-limit-1',
  'getMessage:same-history-id',
];
async function fixture(separate = false) {
  const root = await mkdtemp(join(tmpdir(), 'readonly-acceptance-fake-'));
  const release = join(root, 'artifacts');
  const consumer = join(root, 'consumer');
  const modules = join(consumer, 'node_modules');
  const auxiliary = 'qq-native-client-darwin-arm64';
  await mkdir(join(modules, auxiliary), { recursive: true });
  await mkdir(release);
  const wrapper = 'not a native module';
  const native = JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    files: [{ path: 'wrapper.node', sha256: hash(wrapper) }],
  });
  await writeFile(join(modules, auxiliary, 'wrapper.node'), wrapper);
  await writeFile(join(modules, auxiliary, 'manifest.json'), native);
  const tarballs = {
    'qq-native-client-0.0.2.tgz': hash('main'),
    'qq-native-client-darwin-arm64-0.0.2.tgz': hash('aux'),
  };
  await writeFile(join(release, 'qq-native-client-0.0.2.tgz'), 'main');
  await writeFile(join(release, 'qq-native-client-darwin-arm64-0.0.2.tgz'), 'aux');
  await writeFile(join(release, 'release-manifest.json'), 'fake release');
  const consumerFiles = {
    'package.json': hash('{}'),
    'package-lock.json': hash('{}'),
    'entry.mjs': hash("throw Error('Review must never import this entry')"),
  };
  for (const path of Object.keys(consumerFiles))
    await writeFile(
      join(consumer, path),
      path === 'entry.mjs' ? "throw Error('Review must never import this entry')" : '{}',
    );
  const plan = {
    schemaVersion: 1,
    sdkVersion: '0.0.2',
    sourceCommit: 'fake-sdk-commit',
    sourceRunId: 'fake-run',
    method: 'restore',
    queryLimit: 1,
    queries,
    peer: { type: 'private', userId: '8596238' },
    historyLimit: 1,
    automaticPlatformSelection: true,
    send: false,
    recall: false,
    profileMutation: false,
    relationshipMutation: false,
    retry: false,
    qrFallback: false,
    persistContactDetails: false,
    persistMessageContents: false,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    nodeConfigSha256: hash(JSON.stringify(process.config)),
    releaseManifestSha256: hash('fake release'),
    tarballs,
    installedFiles: {
      [`${auxiliary}/manifest.json`]: hash(native),
      [`${auxiliary}/wrapper.node`]: hash(wrapper),
    },
    installedLinks: {},
    consumerFiles,
    auxiliary,
    nativeManifestSha256: hash(native),
    nativeFiles: 1,
    ...(separate
      ? {
          nativeSourceCommit: 'fake-native-commit',
          nativeSourceRunId: 'fake-native-run',
          sdkBindingSha256: '',
        }
      : {}),
  };
  if (separate) {
    const binding = JSON.stringify({
      builderCommit: plan.sourceCommit,
      builderRunId: plan.sourceRunId,
      tarball: 'qq-native-client-0.0.2.tgz',
      sha256: tarballs['qq-native-client-0.0.2.tgz'],
      nativeSource: {
        commit: plan.nativeSourceCommit,
        runId: plan.nativeSourceRunId,
        releaseManifestSha256: plan.releaseManifestSha256,
        auxiliary: {
          tarball: 'qq-native-client-darwin-arm64-0.0.2.tgz',
          sha256: tarballs['qq-native-client-darwin-arm64-0.0.2.tgz'],
        },
      },
    });
    await writeFile(join(release, 'consumer-sdk.json'), binding);
    plan.sdkBindingSha256 = hash(binding);
  }
  const bytes = JSON.stringify(plan);
  await writeFile(join(root, 'plan.json'), bytes);
  const batch: ReadonlyAcceptanceBatch = {
    root,
    release,
    planSha256: hash(bytes),
    sourceCommit: plan.sourceCommit,
    sourceRunId: plan.sourceRunId,
    ...(separate
      ? { nativeSource: { commit: 'fake-native-commit', runId: 'fake-native-run' } }
      : {}),
  };
  return {
    root,
    release,
    consumer,
    modules,
    plan,
    batch,
    async replacePlan(change: Record<string, unknown>) {
      const bytes = JSON.stringify({ ...plan, ...change });
      await writeFile(join(root, 'plan.json'), bytes);
      batch.planSha256 = hash(bytes);
    },
  };
}
const message: Message = {
  messageId: 'fake-message',
  sequence: '1',
  time: 1,
  peer: { type: 'private', userId: '8596238' },
  sender: { uid: 'fake-sender', userId: '123', nickname: 'private fixture content' },
  elements: [{ type: 'text', text: 'must never persist' }],
  raw: { ticket: 'must never persist' },
};
function adapter(options: { failure?: unknown; groups?: boolean; closeFailure?: boolean } = {}) {
  const calls: string[] = [];
  let state: QQClient['state'] = 'online';
  const client: ReadonlyAcceptanceClient = {
    get state() {
      return state;
    },
    async login(request) {
      calls.push('restore');
      assert.deepEqual(request, { method: 'restore' });
      if (options.failure !== undefined) throw options.failure;
      return { uin: '123', uid: 'fake-self' };
    },
    async listFriends() {
      calls.push('friends');
      return [];
    },
    async listGroups() {
      calls.push('groups');
      return options.groups === false
        ? []
        : [{ groupId: '456', name: 'private fixture group', memberCount: 1, maxMemberCount: 2 }];
    },
    async getGroupMembers(id) {
      calls.push('members');
      assert.equal(id, '456');
      return [];
    },
    async getHistory(peer, history) {
      calls.push('history');
      assert.deepEqual(peer, message.peer);
      assert.deepEqual(history, { limit: 1 });
      return [message];
    },
    async getMessage(peer, id) {
      calls.push('lookup');
      assert.deepEqual(peer, message.peer);
      assert.equal(id, message.messageId);
      return message;
    },
    async close() {
      calls.push('close');
      state = 'closed';
      if (options.closeFailure) throw Error('sensitive close wording');
    },
  };
  const runtime: ReadonlyAcceptanceRuntime = {
    async load() {
      calls.push('import');
      return {
        async createClient(value) {
          calls.push('initialize');
          assert.equal(value.autoReconnect, false);
          assert.equal(value.timeoutMs, 30000);
          return client;
        },
      };
    },
  };
  return { calls, client, runtime };
}

test('default review verifies installed files without importing runtime, marker, account access or receipt writes', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  let imports = 0;
  const result = await runReadonlySdkAcceptance(f.batch, [], {
    async load() {
      imports++;
      throw Error('Must not load');
    },
  });
  assert.equal(result.mode, 'review');
  assert.equal((await runReadonlySdkAcceptance(f.batch, [])).mode, 'review');
  assert.equal(imports, 0);
  assert.deepEqual((await readdir(f.root)).sort(), ['artifacts', 'consumer', 'plan.json']);
  if (result.mode === 'review') {
    assert.equal(result.review.accountUsed, false);
    assert.equal(result.review.nativeExecuted, false);
    assert.equal(result.review.installedFiles, 2);
  }
});

test('changed digest, scope, installed content and CLI arguments refuse before runtime acquisition or reservation', async (t) => {
  for (const kind of ['digest', 'scope', 'inventory', 'args']) {
    const f = await fixture();
    t.after(() => rm(f.root, { recursive: true, force: true }));
    const a = adapter();
    if (kind === 'digest') f.batch.planSha256 = '0'.repeat(64);
    if (kind === 'scope') await f.replacePlan({ send: true });
    if (kind === 'inventory')
      await writeFile(join(f.modules, f.plan.auxiliary, 'wrapper.node'), 'changed');
    await assert.rejects(
      runReadonlySdkAcceptance(
        f.batch,
        kind === 'args' ? ['--execute-approved', '--execute-approved'] : ['--execute-approved'],
        a.runtime,
      ),
    );
    assert.deepEqual(a.calls, []);
    assert.equal((await readdir(f.root)).includes('read-once.lock'), false);
  }
});

test('separate SDK/native source binding is checked without loading either package', async (t) => {
  const f = await fixture(true);
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const a = adapter();
  assert.equal((await runReadonlySdkAcceptance(f.batch, [], a.runtime)).mode, 'review');
  await writeFile(join(f.release, 'consumer-sdk.json'), 'changed');
  await assert.rejects(runReadonlySdkAcceptance(f.batch, [], a.runtime));
  assert.deepEqual(a.calls, []);
});

test('one-shot reservation precedes runtime import; replay is rejected even after runtime acquisition fails', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  let imports = 0;
  const runtime: ReadonlyAcceptanceRuntime = {
    async load() {
      imports++;
      assert.ok(await readFile(join(f.root, 'read-once.lock')));
      throw Error('sensitive runtime import failure');
    },
  };
  const result = await runReadonlySdkAcceptance(f.batch, ['--execute-approved'], runtime);
  assert.equal(result.mode, 'execution');
  if (result.mode === 'execution') {
    assert.equal(result.exitCode, 1);
    assert.equal(result.receipt.restoreAttempted, false);
  }
  await assert.rejects(runReadonlySdkAcceptance(f.batch, ['--execute-approved'], runtime), {
    code: 'EEXIST',
  });
  assert.equal(imports, 1);
});

test('fixed ordered read lifecycle closes and persists only sanitized counts/matching flags', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const a = adapter();
  const result = await runReadonlySdkAcceptance(f.batch, ['--execute-approved'], a.runtime);
  assert.deepEqual(a.calls, [
    'import',
    'initialize',
    'restore',
    'friends',
    'groups',
    'members',
    'history',
    'lookup',
    'close',
  ]);
  assert.equal(result.mode, 'execution');
  if (result.mode === 'execution') {
    assert.equal(result.exitCode, 0);
    assert.equal(result.receipt.stage, 'complete');
    assert.equal(result.receipt.closed, true);
    assert.equal(result.receipt.matched, true);
  }
  const receipt = await readFile(join(f.root, 'receipt.json'), 'utf8');
  for (const privateValue of [
    'fake-self',
    'fake-sender',
    'fake-message',
    'must never persist',
    'private fixture',
  ])
    assert.equal(receipt.includes(privateValue), false);
});

test('failed restore stops all reads, preserves safe code without invoking error accessors, and still closes', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  let reads = 0;
  const failure = Object.defineProperties(
    {},
    {
      message: {
        get() {
          reads++;
          throw Error('private message');
        },
      },
      code: { value: -9 },
    },
  );
  const a = adapter({ failure });
  const result = await runReadonlySdkAcceptance(f.batch, ['--execute-approved'], a.runtime);
  assert.deepEqual(a.calls, ['import', 'initialize', 'restore', 'close']);
  assert.equal(reads, 0);
  if (result.mode === 'execution') {
    assert.equal(result.exitCode, 1);
    assert.equal(result.receipt.errorCode, '-9');
    assert.equal(result.receipt.errorCategory, 'operation-failed');
    assert.equal(result.receipt.closed, true);
  }
});

test('no group skips members, while close failure remains visible and receipt is saved', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const a = adapter({ groups: false, closeFailure: true });
  const result = await runReadonlySdkAcceptance(f.batch, ['--execute-approved'], a.runtime);
  assert.equal(a.calls.includes('members'), false);
  if (result.mode === 'execution') {
    assert.equal(result.exitCode, 1);
    assert.equal(result.receipt.memberQuerySkippedNoGroup, true);
    assert.equal(result.receipt.errorCategory, 'shutdown-failed');
  }
  assert.ok(await readFile(join(f.root, 'receipt.json')));
});

test('signal and finally share one close attempt even when close rejects or throws synchronously', async (t) => {
  for (const mode of ['reject', 'throw'] as const) {
    const f = await fixture();
    t.after(() => rm(f.root, { recursive: true, force: true }));
    const a = adapter();
    let closes = 0;
    a.client.login = async () => {
      process.emit('SIGINT');
      throw Error('private restore failure');
    };
    a.client.close = () => {
      closes++;
      if (mode === 'throw') throw Error('private close failure');
      return Promise.reject(Error('private close failure'));
    };
    const before = process.listenerCount('SIGINT');
    const result = await runReadonlySdkAcceptance(f.batch, ['--execute-approved'], a.runtime);
    assert.equal(closes, 1);
    assert.equal(process.listenerCount('SIGINT'), before);
    if (result.mode === 'execution') {
      assert.equal(result.exitCode, 130);
      assert.equal(result.receipt.interrupted, true);
      assert.equal(result.receipt.errorCategory, 'interrupted');
      assert.equal(result.receipt.friendQueryAttempted, false);
    }
    const receipt = await readFile(join(f.root, 'receipt.json'), 'utf8');
    assert.equal(receipt.includes('private'), false);
  }
});

test('interruption during runtime acquisition prevents factory dispatch; late factory client only closes', async (t) => {
  for (const stage of ['load', 'factory'] as const) {
    const f = await fixture();
    t.after(() => rm(f.root, { recursive: true, force: true }));
    const a = adapter();
    let factories = 0;
    const runtime: ReadonlyAcceptanceRuntime = {
      async load() {
        if (stage === 'load') process.emit('SIGINT');
        await Promise.resolve();
        return {
          async createClient() {
            factories++;
            process.emit('SIGINT');
            await Promise.resolve();
            return a.client;
          },
        };
      },
    };
    const result = await runReadonlySdkAcceptance(f.batch, ['--execute-approved'], runtime);
    assert.equal(factories, stage === 'load' ? 0 : 1);
    assert.deepEqual(a.calls, stage === 'load' ? [] : ['close']);
    if (result.mode === 'execution') {
      assert.equal(result.exitCode, 130);
      assert.equal(result.receipt.restoreAttempted, false);
      assert.equal(result.receipt.interrupted, true);
    }
  }
});

test('interrupting a pending read closes once, settles that read and never starts the next phase', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const a = adapter();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let rejectRead!: (error: Error) => void;
  a.client.listFriends = () => {
    a.calls.push('friends');
    entered();
    return new Promise((_, reject) => {
      rejectRead = reject;
    });
  };
  a.client.close = async () => {
    a.calls.push('close');
    rejectRead(Error('fake pending RPC retired'));
  };
  const pending = runReadonlySdkAcceptance(f.batch, ['--execute-approved'], a.runtime);
  await started;
  process.emit('SIGTERM');
  const result = await pending;
  assert.deepEqual(a.calls, ['import', 'initialize', 'restore', 'friends', 'close']);
  if (result.mode === 'execution') {
    assert.equal(result.exitCode, 130);
    assert.equal(result.receipt.groupQueryAttempted, false);
    assert.equal(result.receipt.errorCategory, 'interrupted');
  }
});
