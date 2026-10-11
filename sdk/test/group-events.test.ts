import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroupEvents, createGroupEventIngress } from '../src/features/groups/group-events.ts';

test('group detail synchronization projects only declared metadata and preserves exact IDs', () => {
  const events: [string, any][] = [];
  const listener = createGroupEvents((event, value) => events.push([event, value]));
  const raw = {
    groupCode: '900719925474099312345',
    groupName: '群',
    memberNum: 3,
    maxMemberNum: 200,
    ownerUid: 'u_owner',
    ownerUin: '000123',
    fingerMemo: '',
    credential: 'fixture-secret',
  };
  listener.onGroupDetailInfoChange(raw);
  assert.deepEqual(events, [
    [
      'group-info-updated',
      {
        groupId: raw.groupCode,
        name: '群',
        memberCount: 3,
        maxMemberCount: 200,
        ownerUid: 'u_owner',
        ownerUserId: '000123',
        description: '',
      },
    ],
  ]);
  events[0][1].name = 'changed';
  assert.equal(raw.groupName, '群');
  assert.doesNotMatch(JSON.stringify(events), /credential|fixture-secret/);
  for (const value of [
    null,
    [],
    { ...raw, ownerUin: 123 },
    { ...raw, ownerUid: '' },
    { ...raw, memberNum: -1 },
    { ...raw, maxMemberNum: 1.5 },
    { ...raw, fingerMemo: undefined },
  ]) {
    listener.onGroupDetailInfoChange(value);
    assert.deepEqual(events.at(-1), ['diagnostic', { stage: 'invalid-native-group-info-update' }]);
  }
  assert.equal(events.filter(([name]) => name === 'group-info-updated').length, 1);
});

test('group list callback kinds preserve their meanings and partial metadata', () => {
  const events: [string, any][] = [];
  const listener = createGroupEvents((event, value) => events.push([event, value]));
  const id = '900719925474099312345';
  for (const [native, kind] of ['refresh', 'all', 'modified', 'removed'].entries()) {
    listener.onGroupListUpdate(native, [
      { groupCode: id, groupName: '', memberCount: 0, maxMember: 100 },
    ]);
    assert.deepEqual(events.at(-1), [
      'group-list-updated',
      { kind, groups: [{ groupId: id, name: '', memberCount: 0, maxMemberCount: 100 }] },
    ]);
  }
  listener.onGroupListUpdate(3, [{ groupCode: '123' }]);
  assert.deepEqual(events.at(-1), [
    'group-list-updated',
    { kind: 'removed', groups: [{ groupId: '123' }] },
  ]);
  listener.onGroupListUpdate(0, []);
  assert.deepEqual(events.at(-1), ['group-list-updated', { kind: 'refresh', groups: [] }]);
});

test('member callbacks preserve data source, deletion and all declared native role states', () => {
  const events: [string, any][] = [];
  const listener = createGroupEvents((event, value) => events.push([event, value]));
  for (const [role, expected] of [
    'unspecified',
    'stranger',
    'member',
    'admin',
    'owner',
  ].entries()) {
    listener.onMemberInfoChange(
      '123',
      1,
      new Map([
        [
          'u_member',
          {
            uid: 'u_member',
            uin: '456',
            nick: 'nick',
            cardName: '',
            role,
            isDelete: true,
            isChangeRole: false,
          },
        ],
      ]),
    );
    assert.deepEqual(events.at(-1), [
      'group-members-updated',
      {
        groupId: '123',
        source: 'remote',
        members: [
          {
            uid: 'u_member',
            userId: '456',
            nickname: 'nick',
            card: '',
            role: expected,
            deleted: true,
            roleChanged: false,
          },
        ],
      },
    ]);
  }
  listener.onMemberInfoChange('123', 0, new Map([['u_partial', {}]]));
  assert.deepEqual(events.at(-1), [
    'group-members-updated',
    { groupId: '123', source: 'local', members: [{ uid: 'u_partial' }] },
  ]);
  listener.onMemberInfoChange('123', 1, new Map());
  assert.deepEqual(events.at(-1), [
    'group-members-updated',
    { groupId: '123', source: 'remote', members: [] },
  ]);
});

test('malformed batches emit only bounded diagnostics, without partial or invented changes', () => {
  const events: [string, any][] = [];
  const listener = createGroupEvents((event, value) => events.push([event, value]));
  for (const [kind, values] of [
    [4, []],
    ['1', []],
    [true, []],
    [NaN, []],
    [1, null],
    [1, Array(1)],
    [1, [{ groupCode: '123' }, { groupCode: 'bad', credential: 'fixture-secret' }]],
    [0, [{ groupCode: '123', memberCount: -1 }]],
    [1, [{ groupCode: '123', groupName: 1 }]],
  ] as [unknown, unknown][]) {
    listener.onGroupListUpdate(kind, values);
    assert.deepEqual(events.at(-1), ['diagnostic', { stage: 'invalid-native-group-list-update' }]);
  }
  for (const [group, source, values] of [
    ['', 0, new Map()],
    ['123', '1', new Map()],
    ['123', 1, []],
    ['123', 0, new Map([['u', { uid: 'other', credential: 'fixture-secret' }]])],
    ['123', 0, new Map([['u', { role: 9 }]])],
    ['123', 0, new Map([['u', { isDelete: 1 }]])],
    ['123', 0, new Map([['u', { uin: 456 }]])],
  ] as [unknown, unknown, unknown][]) {
    listener.onMemberInfoChange(group, source, values);
    assert.deepEqual(events.at(-1), [
      'diagnostic',
      { stage: 'invalid-native-group-member-update' },
    ]);
  }
  assert.ok(events.every(([name]) => name === 'diagnostic'));
  assert.doesNotMatch(JSON.stringify(events), /credential|fixture-secret/);
});

test('projected notification objects are independent of native payloads', () => {
  const events: [string, any][] = [];
  const listener = createGroupEvents((event, value) => events.push([event, value]));
  const group = { groupCode: '123', groupName: 'group', credential: 'fixture-secret' };
  const member = {
    uid: 'u',
    uin: '456',
    nick: 'original',
    isDelete: false,
    unknown: { secret: 'fixture-secret' },
  };
  listener.onGroupListUpdate(2, [group]);
  listener.onMemberInfoChange('123', 1, new Map([['u', member]]));
  events[0][1].groups[0].name = 'changed';
  events[1][1].members[0].nickname = 'changed';
  assert.equal(group.groupName, 'group');
  assert.equal(member.nick, 'original');
  assert.doesNotMatch(JSON.stringify(events), /fixture-secret|credential|unknown/);
});

test('partial metadata fields are captured once before validation and publication', () => {
  const events: [string, unknown][] = [];
  const listener = createGroupEvents((event, value) => events.push([event, value]));
  let groupReads = 0;
  let roleReads = 0;
  listener.onGroupListUpdate(2, [
    {
      groupCode: '123',
      get groupName() {
        return ++groupReads === 1 ? 'captured' : 99;
      },
    },
  ]);
  listener.onMemberInfoChange(
    '123',
    0,
    new Map([
      [
        'u',
        {
          get role() {
            return ++roleReads === 1 ? 3 : 'invalid';
          },
        },
      ],
    ]),
  );
  assert.deepEqual(events, [
    ['group-list-updated', { kind: 'modified', groups: [{ groupId: '123', name: 'captured' }] }],
    [
      'group-members-updated',
      { groupId: '123', source: 'local', members: [{ uid: 'u', role: 'admin' }] },
    ],
  ]);
  assert.equal(groupReads, 1);
  assert.equal(roleReads, 1);
});

test('member projection uses real Map entries despite an overridden iterator', () => {
  const events: [string, unknown][] = [];
  const listener = createGroupEvents((event, value) => events.push([event, value]));
  let calls = 0;
  const values = new Map<string, unknown>();
  values[Symbol.iterator] = function* () {
    calls++;
    yield ['fabricated', {}];
    return undefined;
  };
  listener.onMemberInfoChange('123', 1, values);
  assert.deepEqual(events, [
    ['group-members-updated', { groupId: '123', source: 'remote', members: [] }],
  ]);
  assert.equal(calls, 0);
});

test('later projection exceptions become atomic diagnostics and allow downstream dispatch', () => {
  const events: [string, unknown][] = [];
  const listener = createGroupEvents((event, value) => events.push([event, value]));
  let downstream = 0;
  const bad = {
    get groupCode() {
      throw new Error('fixture-secret');
    },
  };
  assert.doesNotThrow(() => {
    listener.onGroupListUpdate(0, [{ groupCode: '123' }, bad]);
    downstream++;
  });
  assert.doesNotThrow(() => {
    listener.onMemberInfoChange(
      '123',
      0,
      new Map([
        ['good', {}],
        [
          'bad',
          {
            get nick() {
              throw new Error('fixture-secret');
            },
          },
        ],
      ]),
    );
    downstream++;
  });
  assert.equal(downstream, 2);
  assert.deepEqual(events, [
    ['diagnostic', { stage: 'invalid-native-group-list-update' }],
    ['diagnostic', { stage: 'invalid-native-group-member-update' }],
  ]);
});

test('application emit errors remain visible rather than becoming native diagnostics', () => {
  const error = new Error('application observer failed');
  const listener = createGroupEvents(() => {
    throw error;
  });
  assert.throws(
    () => listener.onGroupListUpdate(0, [{ groupCode: '123' }]),
    (value) => value === error,
  );
  assert.throws(
    () => listener.onMemberInfoChange('123', 0, new Map()),
    (value) => value === error,
  );
});

test('group ingress preserves normalized-before-raw ordering and original callback references', () => {
  const order: string[] = [];
  const groups = [{ groupCode: '123', groupName: 'group' }];
  const detail = {
    groupCode: '123',
    groupName: 'changed',
    ownerUid: 'uid',
    ownerUin: '456',
    fingerMemo: '',
    memberNum: 1,
    maxMemberNum: 200,
  };
  const ingress = createGroupEventIngress({
    emit: (event) => {
      order.push(event);
    },
    dispatchList: (kind, value) => {
      assert.equal(kind, 0);
      assert.equal(value, groups);
      order.push('raw-list');
    },
    dispatchDetail: (value) => {
      assert.equal(value, detail);
      order.push('raw-detail');
    },
    traceEnabled: () => false,
  });
  ingress.onGroupListUpdate(0, groups);
  ingress.onGroupDetailInfoChange(detail);
  assert.deepEqual(order, ['group-list-updated', 'raw-list', 'group-info-updated', 'raw-detail']);
});

test('group ingress invalid batches still complete raw routes and tracing is evaluated per callback', () => {
  const events: string[] = [];
  let trace = false;
  const invalid = [{ groupCode: false }];
  const ingress = createGroupEventIngress({
    emit: (event) => {
      events.push(event);
    },
    dispatchList: (_kind, value) => {
      assert.equal(value, invalid);
      events.push('raw-list');
    },
    dispatchDetail: () => {
      events.push('raw-detail');
    },
    traceEnabled: () => trace,
  });
  ingress.onGroupListUpdate(0, invalid);
  trace = true;
  ingress.onGroupListUpdate(0, invalid);
  ingress.onGroupDetailInfoChange({ groupCode: false });
  assert.deepEqual(events, [
    'diagnostic',
    'raw-list',
    'diagnostic',
    'diagnostic',
    'raw-list',
    'diagnostic',
    'raw-detail',
  ]);
});

test('group ingress observer failures prevent query dispatch without replacing the error', () => {
  const failure = { marker: 'observer' };
  let dispatches = 0;
  const ingress = createGroupEventIngress({
    emit: () => {
      throw failure;
    },
    dispatchList: () => {
      dispatches++;
    },
    dispatchDetail: () => {
      dispatches++;
    },
    traceEnabled: () => false,
  });
  assert.throws(
    () => ingress.onGroupListUpdate(0, []),
    (error) => error === failure,
  );
  assert.throws(
    () => ingress.onGroupDetailInfoChange({ groupCode: '123' }),
    (error) => error === failure,
  );
  assert.equal(dispatches, 0);
});

test('group ingress preserves dispatch after a normalized observer retires its own delivery', () => {
  const order: string[] = [];
  let closed = false;
  const ingress = createGroupEventIngress({
    emit: (event) => {
      if (!closed) order.push(event);
      closed = true;
    },
    dispatchList: () => {
      order.push('raw-list');
    },
    dispatchDetail: () => {
      order.push('raw-detail');
    },
    traceEnabled: () => false,
  });
  ingress.onGroupListUpdate(0, []);
  assert.deepEqual(order, ['group-list-updated', 'raw-list']);
});
