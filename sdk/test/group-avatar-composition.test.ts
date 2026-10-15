import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createNativeServices } from '../src/native-services.ts';
import type { NativeContractProfile } from '../src/native/native-contracts.ts';

// Support comes from independent evidence, never the implementation allowlist.
const evidence = JSON.parse(
  readFileSync(new URL('../docs/evidence/group-avatar-contract.json', import.meta.url), 'utf8'),
) as { profiles: NativeContractProfile[]; nativeExecuted: boolean; accountUsed: boolean };
const knownProfiles = JSON.parse(
  readFileSync(new URL('../docs/evidence/group-file-count-contract.json', import.meta.url), 'utf8'),
) as { profiles: NativeContractProfile[] };

async function avatarFile(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'qq-group-avatar-composition-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'avatar.png');
  // Composition only proves local-file preflight and dispatch, not image decoding.
  await writeFile(file, 'controlled nonempty file');
  return file;
}

function fixture(
  profile: NativeContractProfile | undefined,
  version: string,
  response: () => unknown = () => ({ result: 0, errMsg: '' }),
) {
  let acquisitions = 0;
  let methodReads = 0;
  const calls: [string, string][] = [];
  const group = {
    addKernelGroupListener() {},
    get setHeader() {
      methodReads++;
      return function (this: unknown, groupId: string, file: string) {
        assert.equal(this, group, 'native method keeps its actual Group receiver');
        calls.push([groupId, file]);
        return response();
      };
    },
  };
  const services = createNativeServices({
    session: {
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getGroupService() {
        acquisitions++;
        return group;
      },
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
    },
    version,
    binaryProfile: profile,
    events: { emit() {} },
  });
  return {
    services,
    calls,
    acquisitions: () => acquisitions,
    methodReads: () => methodReads,
  };
}

function verifiedProfile(): NativeContractProfile {
  assert.equal(evidence.profiles.length, 1);
  assert.equal(evidence.nativeExecuted, false);
  assert.equal(evidence.accountUsed, false);
  const profile = evidence.profiles[0]!;
  assert.equal(profile.platform, 'darwin');
  assert.equal(profile.arch, 'arm64');
  return profile;
}

test('composed avatar operation routes the captured file and group to the verified Group receiver', async (t) => {
  const profile = verifiedProfile();
  const file = await avatarFile(t);
  const f = fixture(profile, profile.clientVersion);
  t.after(() => f.services.close());
  const before = f.acquisitions();

  assert.equal(
    await f.services.invokeOperation('setGroupAvatar', { groupId: '000123', file }),
    undefined,
  );
  assert.deepEqual(f.calls, [['000123', file]]);
  assert.equal(f.acquisitions(), before + 1);
  assert.equal(f.methodReads(), 1);
});

test('avatar composition rejects the other five known binaries and every incomplete profile before acquisition', async (t) => {
  const profile = verifiedProfile();
  const file = await avatarFile(t);
  const otherProfiles = knownProfiles.profiles.filter(
    (candidate) => candidate.platform !== profile.platform || candidate.arch !== profile.arch,
  );
  assert.equal(otherProfiles.length, 5);
  assert.equal(
    new Set(otherProfiles.map((candidate) => `${candidate.platform}/${candidate.arch}`)).size,
    5,
  );
  const candidates: [NativeContractProfile | undefined, string][] = [
    ...otherProfiles.map((candidate): [NativeContractProfile, string] => [
      candidate,
      candidate.clientVersion,
    ]),
    [undefined, profile.clientVersion],
    [{ ...profile, platform: 'unknown' }, profile.clientVersion],
    [{ ...profile, arch: 'unknown' }, profile.clientVersion],
    [{ ...profile, wrapperSha256: '0'.repeat(64) }, profile.clientVersion],
    [{ ...profile, clientVersion: 'unverified' }, 'unverified'],
    [profile, 'unverified'],
  ];
  for (const [candidate, version] of candidates) {
    const f = fixture(candidate, version);
    const before = f.acquisitions();
    try {
      await assert.rejects(f.services.invokeOperation('setGroupAvatar', { groupId: '123', file }), {
        code: 'unsupported-native-contract',
      });
      assert.equal(
        f.acquisitions(),
        before,
        'unsupported operations do not acquire a Group service',
      );
      assert.equal(f.methodReads(), 0);
      assert.deepEqual(f.calls, []);
    } finally {
      f.services.close();
    }
  }
});

test('Session close cancels an issued avatar wait, observes late rejection and never resubmits', async (t) => {
  const profile = verifiedProfile();
  const file = await avatarFile(t);
  let rejectNative!: (error: unknown) => void;
  const pending = new Promise<unknown>((_resolve, reject) => {
    rejectNative = reject;
  });
  let markDispatched!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    markDispatched = resolve;
  });
  const f = fixture(profile, profile.clientVersion, () => {
    markDispatched();
    return pending;
  });
  t.after(() => f.services.close());
  const stopped = assert.rejects(
    f.services.invokeOperation('setGroupAvatar', { groupId: '123', file }),
    /closed/,
  );
  await dispatched;
  f.services.close();
  await stopped;
  rejectNative(new Error('late native rejection'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(
    f.services.invokeOperation('setGroupAvatar', { groupId: '123', file }),
    /closed/,
  );
  assert.deepEqual(f.calls, [['123', file]]);
  assert.equal(f.methodReads(), 1);
});
