# Friends, categories and groups

These are working-source additions for the next candidate, not published `0.0.1` features. Six-platform CI run `38014518589` succeeded for revision `7f24062` (categories/remarks/detail event); subsequent group detail, membership/admin/mute events and mute-list additions need independent CI evidence. The [7f CI audit](evidence/contacts-groups-ci-38014518589.json) independently matched the actual main package's 92 compiled files to 46 committed source files and six platform prepare/close receipts, using 571463 bytes of bounded official ranges. It did not re-read six large auxiliary packages or verify the complete ZIP digest. Controlled service/worker and installed-package checks are separate from real account acceptance.

| Area | Available methods/events | Remaining work |
| --- | --- | --- |
| Friends | Lists/profiles, remarks/deletion, request listing/handling, `request.friend`, `friend-list-updated` | Sending applications; independent added/deleted/profile/remark notices |
| Friend categories | `listFriendCategories`; categorized `friend-list-updated` metadata | Create/delete/rename/reorder categories and move friends; parameters and completion responses need verification |
| Group queries | Lists/members/`getGroupInfo`/`listGroupMutedMembers`, `group-list-updated`, `group-members-updated`, `group-info-updated`, `group-membership`, `group-admin`, `group-mute` | Complete join classification and real event/query acceptance |
| Group actions | Name/remark, all/member mute, member card/admin/kick, leave, notices and requests | Create/search/join/invite, member titles, essence messages and group files |

## Categorized friends

```ts
const categories = await client.listFriendCategories();
// Each: {categoryId,sortId,name,memberCount,onlineCount,friends:Friend[]}
```

The query preserves native category order, counts and repeated memberships. Profile lookup deduplicates UIDs; native counts are not replaced with array lengths. Friend account IDs remain strings. Failed/malformed/sparse responses, missing profiles and mismatched identities reject the entire batch. Category membership is captured before profile lookup, and closing interrupts either stage before identity-cache commit. The existing V2 version gate remains in force.

CLI: `qq-native-client friend-categories --config ./qq.json`.

## Group remarks and detail synchronization

```ts
await client.setGroupRemark('123456', 'Project group');
await client.setGroupRemark('123456', ''); // Explicitly clear.
client.on('group-info-updated', info => {
  console.log(info.groupId, info.name, info.ownerUserId, info.description);
});
```

`setGroupRemark` uses `modifyGroupRemark`, requires native `result: 0`, preserves explicit rejection codes and does not retry. A remark is distinct from the shared group name. No real group remark was changed during development.

`group-info-updated` projects `{groupId,name,memberCount,maxMemberCount,ownerUid,ownerUserId,description}` from `GroupDetailInfo`. It emits fresh DTOs and bounded diagnostics for malformed metadata. Synchronization can occur during initialization/queries and does not identify an operator or establish member join/leave causes. Closing suppresses later callbacks.

CLI: `qq-native-client group-remark --config ./qq.json --group-id 123456 --remark ''`. Both `watch --events all` and `normalized` include detail metadata; default watch remains message-only.

## Remaining contracts

Relationship events require native notifications/system messages with target, subject, operator, cause, correlation and deduplication rules. Generic metadata changes cannot establish whether someone left voluntarily or was kicked. Unknown callback arguments remain unprojected.

The fixed source declares category mutations without proving whether string categories mean names or IDs, what numeric UID parameters represent, or how completion is reported. Those actions need that evidence before becoming public methods.

Fixed NapCatQQ source commit `26d7533e0f5800fdff865ab2f2ad7692917e1076`: [friend call site](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/friend.ts), [Buddy service](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/services/NodeIKernelBuddyService.ts), [group service](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/services/NodeIKernelGroupService.ts), [group listener](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/listeners/NodeIKernelGroupListener.ts), [detail type](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/types/group.ts).

Local evidence: [615 regressions and installed consumer](evidence/contacts-groups-local.json). The installed candidate matched all 175 regular files and 92 compiled files, with declarations and actual child-worker routing verified using a replacement kernel and a dlopen stub. These checks performed no native/account operation.

## Group detail query

```ts
const info = await client.getGroupInfo('123456');
// {groupId,name,memberCount,maxMemberCount,ownerUid,ownerUserId,description}
```

CLI: `qq-native-client group-info --config ./qq.json --group-id 123456`.
The exact native path is `getGroupDetailInfo(groupId, 2)` plus `onGroupDetailInfoChange`. Both native success and a valid same-group callback are required. Concurrent same-group reads coalesce but receive independent DTOs. The five-second deadline also interrupts a pending native return; close interrupts either phase. After a failed query, that group's channel is quarantined until the Session is recreated, because callbacks have no request nonce. An unsolicited same-group callback can satisfy a read: this is a valid observed snapshot, not proof that the notification was caused by this request.

## Membership system messages

```ts
client.on('group-membership', event => {
  // groupId:string; direction:'increase'|'decrease'; code:number;
  // kind:'invite'|'leave'|'kick'|'kick-me'|'disband'|'unknown';
  // optional memberUid/operatorUid (native UIDs, not numeric account IDs).
});
```

The actual Msg listener forwards `onRecvSysMsg(number[])` directly into a bounded `PushMsgBody`/`GroupChange` wire reader. Type 33 with code 131 means invite; other increase codes remain unknown. Type 34 recognizes code 130 leave, 131 kick, 3 kick-me, and 129 disband; all others remain unknown. Code is the wire `decreaseType`, even for type 33, matching the pinned source's explicit invitation branch. No unknown value is turned into approve or kick.

Operator UID is emitted only from a valid nested protobuf operator field. Ambiguous legacy text and absent operators remain absent. The parser performs no identity lookup, group refresh or additional notification request. Input is at most 1 MiB, at most 4096 fields per fixed parse container, and exact-byte duplicate suppression retains at most 2048 hashes; close clears it and stops delivery. Malformed input emits a fixed diagnostic, with no partial event or raw packet in the diagnostic. `watch --events all` and `normalized` include this event.

Source hookup and wire schema: [registered system callback](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-onebot/index.ts#L288), [schema](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/transformer/proto/message/message.ts#L59), [classification](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-onebot/api/msg.ts#L1437).

These later additions passed 628 regressions and an installed compiled-consumer check including actual child-worker routing with a replacement kernel. Wire packets and services were controlled fixtures; no new native account operation or live event delivery was verified. See [group query and system-event local evidence](evidence/group-query-system-events-local.json).

## Administrators and mute events

```ts
client.on('group-admin', event => {
  // {groupId,memberUid,enabled}; native UID, no fabricated operator.
});
client.on('group-mute', event => {
  // {groupId,scope:'member'|'all',durationSeconds:string,enabled,
  //  operatorUid,memberUid?:string}; duration '0' lifts mute.
});
const members = await client.listGroupMutedMembers('123456');
```

Administrator sys-message type 44 must contain exactly one enable/disable branch with a valid subject UID. Optional boolean fields are validated but do not override the explicit branch. Mute events use the real Msg receive callback's first group gray-tip element: `chatType=2`, `msgType=5`, gray-tip subtype 4, group-element type 8. The source explicitly defines duration in seconds; its canonical integer string is preserved without conversion through a floating-point number. Empty member UID means all-member mute. No lookup, refresh or inferred timestamp is added.

The normal message path only enables mute parsing for known mute candidates. Candidate batches are validated before any mute event is emitted; malformed or sparse batches produce a bounded diagnostic. Mute duplicates use native message ID plus event fields, so identical operations with different message IDs remain distinct. Sys-message and mute dedup channels are distinct and share the existing bounded cache. Closing prevents further events. Both events are included in normalized/all CLI watch.

`listGroupMutedMembers` requires both native `result:0` and a matching `onShutUpMemberListChanged(groupId,members)` callback. Same-group reads coalesce into independent arrays/DTOs; timeout, close or explicit rejection remains an error, never an empty success. Failed per-group channels are quarantined because callbacks have no request nonce, and unsolicited same-group snapshots may satisfy reads. DTO fields are `{uid,userId,nickname,card,role,shutUpTime}`; all five declared native roles are preserved. `shutUpTime` is an opaque native number: its unit and expiry meaning are not established by this contract, so it is not renamed or calculated as remaining seconds. CLI: `group-muted --config ./qq.json --group-id 123456`.

Primary sources: [administrator schema](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/transformer/proto/message/groupAdmin.ts), [gray-tip ban path](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-onebot/api/group.ts#L39), [seconds field](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/types/msg.ts#L469), [native list DTO](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/types/notify.ts#L50), [list callback pairing](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/group.ts#L108).

[Local evidence](evidence/group-admin-mute-local.json): 641 regressions passed, installed consumer and actual child-worker routes verified with a replacement kernel; 181 regular package files and all 96 compiled files matched before the later docs/evidence append. These are controlled-service/wire checks, with no real account operation or live delivery claim.
