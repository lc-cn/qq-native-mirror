import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroupEvents } from '../src/group-events.ts';

test('group detail synchronization projects only declared metadata and preserves exact IDs', () => {
  const events: [string, any][] = [];
  const listener = createGroupEvents((event, value) => events.push([event, value]));
  const raw = { groupCode: '900719925474099312345', groupName: '群', memberNum: 3, maxMemberNum: 200,
    ownerUid: 'u_owner', ownerUin: '000123', fingerMemo: '', credential: 'fixture-secret' };
  listener.onGroupDetailInfoChange(raw);
  assert.deepEqual(events, [['group-info-updated', { groupId: raw.groupCode, name: '群', memberCount: 3,
    maxMemberCount: 200, ownerUid: 'u_owner', ownerUserId: '000123', description: '' }]]);
  events[0][1].name = 'changed';
  assert.equal(raw.groupName, '群');
  assert.doesNotMatch(JSON.stringify(events), /credential|fixture-secret/);
  for (const value of [null, [], { ...raw, ownerUin: 123 }, { ...raw, ownerUid: '' },
    { ...raw, memberNum: -1 }, { ...raw, maxMemberNum: 1.5 }, { ...raw, fingerMemo: undefined }]) {
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
    listener.onGroupListUpdate(native, [{ groupCode: id, groupName: '', memberCount: 0, maxMember: 100 }]);
    assert.deepEqual(events.at(-1), ['group-list-updated', { kind, groups: [{ groupId: id, name: '', memberCount: 0, maxMemberCount: 100 }] }]);
  }
  listener.onGroupListUpdate(3, [{ groupCode: '123' }]);
  assert.deepEqual(events.at(-1), ['group-list-updated', { kind: 'removed', groups: [{ groupId: '123' }] }]);
  listener.onGroupListUpdate(0, []);
  assert.deepEqual(events.at(-1), ['group-list-updated', { kind: 'refresh', groups: [] }]);
});

test('member callbacks preserve data source, deletion and all declared native role states', () => {
  const events: [string, any][] = [];
  const listener = createGroupEvents((event, value) => events.push([event, value]));
  for (const [role, expected] of ['unspecified', 'stranger', 'member', 'admin', 'owner'].entries()) {
    listener.onMemberInfoChange('123', 1, new Map([['u_member', { uid: 'u_member', uin: '456', nick: 'nick', cardName: '', role, isDelete: true, isChangeRole: false }]]));
    assert.deepEqual(events.at(-1), ['group-members-updated', { groupId: '123', source: 'remote', members: [{ uid: 'u_member', userId: '456', nickname: 'nick', card: '', role: expected, deleted: true, roleChanged: false }] }]);
  }
  listener.onMemberInfoChange('123', 0, new Map([['u_partial', {}]]));
  assert.deepEqual(events.at(-1), ['group-members-updated', { groupId: '123', source: 'local', members: [{ uid: 'u_partial' }] }]);
  listener.onMemberInfoChange('123', 1, new Map());
  assert.deepEqual(events.at(-1), ['group-members-updated', { groupId: '123', source: 'remote', members: [] }]);
});

test('malformed batches emit only bounded diagnostics, without partial or invented changes', () => {
  const events: [string, any][] = [];
  const listener = createGroupEvents((event, value) => events.push([event, value]));
  for (const [kind, values] of [[4, []], ['1', []], [true, []], [NaN, []], [1, null], [1, Array(1)], [1, [{ groupCode: '123' }, { groupCode: 'bad', credential: 'fixture-secret' }]], [0, [{ groupCode: '123', memberCount: -1 }]], [1, [{ groupCode: '123', groupName: 1 }]]] as [unknown, unknown][]) {
    listener.onGroupListUpdate(kind, values);
    assert.deepEqual(events.at(-1), ['diagnostic', { stage: 'invalid-native-group-list-update' }]);
  }
  for (const [group, source, values] of [
    ['', 0, new Map()], ['123', '1', new Map()], ['123', 1, []],
    ['123', 0, new Map([['u', { uid: 'other', credential: 'fixture-secret' }]])],
    ['123', 0, new Map([['u', { role: 9 }]])],
    ['123', 0, new Map([['u', { isDelete: 1 }]])],
    ['123', 0, new Map([['u', { uin: 456 }]])],
  ] as [unknown, unknown, unknown][]) {
    listener.onMemberInfoChange(group, source, values);
    assert.deepEqual(events.at(-1), ['diagnostic', { stage: 'invalid-native-group-member-update' }]);
  }
  assert.ok(events.every(([name]) => name === 'diagnostic'));
  assert.doesNotMatch(JSON.stringify(events), /credential|fixture-secret/);
});

test('projected notification objects are independent of native payloads', () => {
  const events: [string, any][] = [];
  const listener = createGroupEvents((event, value) => events.push([event, value]));
  const group = { groupCode: '123', groupName: 'group', credential: 'fixture-secret' };
  const member = { uid: 'u', uin: '456', nick: 'original', isDelete: false, unknown: { secret: 'fixture-secret' } };
  listener.onGroupListUpdate(2, [group]);
  listener.onMemberInfoChange('123', 1, new Map([['u', member]]));
  events[0][1].groups[0].name = 'changed';
  events[1][1].members[0].nickname = 'changed';
  assert.equal(group.groupName, 'group'); assert.equal(member.nick, 'original');
  assert.doesNotMatch(JSON.stringify(events), /fixture-secret|credential|unknown/);
});
