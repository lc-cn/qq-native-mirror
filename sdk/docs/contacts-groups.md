# Friends, categories and groups

These are working-source additions for the next candidate, not published `0.0.1` features. Six-platform CI run `38014518589` targets revision `7f24062` (categories/remarks/detail event); the subsequent group detail query and system-message event additions need their own CI evidence. Controlled service/worker and installed-package checks are separate from real account acceptance.

| Area | Available methods/events | Remaining work |
| --- | --- | --- |
| Friends | Lists/profiles, remarks/deletion, request listing/handling, `request.friend`, `friend-list-updated` | Sending applications; independent added/deleted/profile/remark notices |
| Friend categories | `listFriendCategories`; categorized `friend-list-updated` metadata | Create/delete/rename/reorder categories and move friends; parameters and completion responses need verification |
| Group queries | Lists/members/`getGroupInfo`, `group-list-updated`, `group-members-updated`, `group-info-updated`, `group-membership` | Mute-list queries; complete join/admin/mute notifications and real membership-event acceptance |
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
