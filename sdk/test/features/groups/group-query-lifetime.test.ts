import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroupQueries } from '../../../src/features/groups/group-queries.ts';
import type { GroupQueriesContext } from '../../../src/features/groups/group-queries.ts';

test('a member commit that retires its owner cannot publish the batch', async () => {
  const account = new AbortController();
  let commits = 0;
  const queries = createGroupQueries({
    signal: account.signal,
    getGroupService: () => ({
      getAllMemberList: () => ({ errCode: 0, result: { finish: true, infos: new Map() } }),
    }),
    eventCall() {
      assert.fail('Member reads do not register callbacks');
    },
    awaitAlive: async (value) => value,
    commitMembers() {
      commits++;
      queries.close();
    },
  });
  try {
    await assert.rejects(queries.getGroupMembers('123'), /closed/);
    assert.equal(commits, 1);
    assert.equal(account.signal.aborted, false);
  } finally {
    queries.close();
  }
});

for (const failure of ['account-abort', 'wait-port-throw'] as const) {
  test(`member ${failure} retires a stalled provider and observes its late rejection`, async () => {
    const account = new AbortController();
    const original = new Error('fixture original failure');
    let rejectNative!: (reason: unknown) => void;
    const native = new Promise<unknown>((_, reject) => {
      rejectNative = reject;
    });
    const wait: GroupQueriesContext['awaitAlive'] =
      failure === 'account-abort'
        ? async (value) => value
        : () => {
            queries.close();
            throw original;
          };
    const queries = createGroupQueries({
      signal: account.signal,
      getGroupService: () => ({ getAllMemberList: () => native }),
      eventCall() {
        assert.fail('Member reads do not register callbacks');
      },
      awaitAlive: wait,
      commitMembers() {
        assert.fail('Retired member query must not update identity storage');
      },
    });
    const pending = queries.getGroupMembers('123');
    const observed = assert.rejects(pending, (error) => error === original);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (failure === 'account-abort') account.abort(original);
      const outcome = await Promise.race([
        observed.then(() => 'rejected'),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('deadline'), 100);
        }),
      ]);
      assert.equal(outcome, 'rejected');
      rejectNative(new Error('fixture late native failure'));
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      if (timer) clearTimeout(timer);
      queries.close();
      rejectNative(new Error('fixture cleanup failure'));
      await observed;
    }
  });
}
