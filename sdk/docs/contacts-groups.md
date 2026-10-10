# Friends, categories and groups

These are working-source additions for the next candidate, not published `0.0.1` features. Six-platform CI run `38012316922` covers the earlier `a0b879e` revision and does not verify these later additions. Controlled service/worker and installed-package checks are separate from real account acceptance.

| Area | Available methods/events | Remaining work |
| --- | --- | --- |
| Friends | Lists/profiles, remarks/deletion, request listing/handling, `request.friend`, `friend-list-updated` | Sending applications; independent added/deleted/profile/remark notices |
| Friend categories | `listFriendCategories`; categorized `friend-list-updated` metadata | Create/delete/rename/reorder categories and move friends; parameters and completion responses need verification |
| Group queries | Lists/members, `group-list-updated`, `group-members-updated`, `group-info-updated` | Detail/mute-list queries; classified member join/leave and mute notifications |
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
