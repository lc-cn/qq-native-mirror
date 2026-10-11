# Friends, categories and groups

These are working-source additions for the next candidate, not published `0.0.1` features. Six-platform CI run `38014518589` succeeded for revision `7f24062` (categories/remarks/detail event); Revision `b0dee1c` group detail/membership additions also passed six-platform CI `38015512259`; its [bounded artifact audit](evidence/group-query-system-events-ci-38015512259.json) matched 94 compiled files to 47 source files and six native prepare/close receipts. Revision `9deaa56` administrator/mute events and mute-list additions passed CI `38016572108`; its [independent bounded artifact audit](evidence/group-admin-mute-ci-38016572108.json) matched 96 compiled files to 48 committed source files and six prepare/close receipts using 582496 bytes of actual ranges. Revision `8d2da41` category creation passed six-platform CI `38017928237`; its [independent bounded artifact audit](evidence/friend-category-create-ci-38017928237.json) matched 100 compiled files to 50 committed source files and seven manifest-bound receipts using 590577 bytes of actual ranges. The later friend-added source requires its own CI. The [7f CI audit](evidence/contacts-groups-ci-38014518589.json) independently matched the actual main package's 92 compiled files to 46 committed source files and six platform prepare/close receipts, using 571463 bytes of bounded official ranges. It did not re-read six large auxiliary packages or verify the complete ZIP digest. Controlled service/worker and installed-package checks are separate from real account acceptance.

| Area              | Available methods/events                                                                                                                                                                                                                                                                                                                                       | Remaining work                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Friends           | Lists/profiles, remarks/deletion, request listing/handling, `request.friend`, `friend-list-updated`, `friend-added`                                                                                                                                                                                                                                            | Sending applications; independent deleted/profile/remark notices                                                                               |
| Friend categories | `listFriendCategories`, `addFriendCategory`, `renameFriendCategory` (four measured binaries), `deleteFriendCategory` (three measured macOS ARM64/Linux binaries), `reorderFriendCategories`, `setFriendCategory` (measured Linux x64/ARM64 3.2.32-52194, macOS x64/ARM64 7.0.2-53644 and Windows x64 9.9.33-52230); categorized `friend-list-updated` metadata | Move friends on Windows ARM64; rename/delete/reorder on remaining binaries and real account mutation acceptance require separate verification  |
| Group queries     | Lists/members/`getGroupInfo`/`listGroupMutedMembers`, `group-list-updated`, `group-members-updated`, `group-info-updated`, `group-membership`, `group-admin`, `group-mute`                                                                                                                                                                                     | Complete join classification and real event/query acceptance                                                                                   |
| Group actions     | Name/remark, all/member mute, member card/admin/kick, leave, notices, requests, essence add/remove folder deletion acknowledgement and single-group file count                                                                                                                                                                                                 | Create/join/invite, member titles, live essence pagination and add/remove events, remaining group file operations and real mutation acceptance |

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
client.on('group-info-updated', (info) => {
  console.log(info.groupId, info.name, info.ownerUserId, info.description);
});
```

`setGroupRemark` uses `modifyGroupRemark`, requires native `result: 0`, preserves explicit rejection codes and does not retry. A remark is distinct from the shared group name. No real group remark was changed during development.

`group-info-updated` projects `{groupId,name,memberCount,maxMemberCount,ownerUid,ownerUserId,description}` from `GroupDetailInfo`. It emits fresh DTOs and bounded diagnostics for malformed metadata. Synchronization can occur during initialization/queries and does not identify an operator or establish member join/leave causes. Closing suppresses later callbacks.

CLI: `qq-native-client group-remark --config ./qq.json --group-id 123456 --remark ''`. Both `watch --events all` and `normalized` include detail metadata; default watch remains message-only.

## Remaining contracts

### Group essence messages

```ts
await client.setGroupEssenceMessage('123456', '9876543210123456789', true);
await client.setGroupEssenceMessage('123456', '9876543210123456789', false);
```

The SDK captures group/message IDs and an explicit boolean before IPC. It queries
the exact group message once, verifies the conversation and derives native
`msgSeq`/`msgRandom` as uint32 values. The public message ID remains a string and
is never substituted for either wire field. Group IDs must fit native uint64.
An absent/mismatched message, malformed field or Session shutdown prevents dispatch.
The native add/remove method is invoked once and is never automatically retried.

Essence responses contain outer `errCode` and inner `result.errorCode`. Both must
be explicit numeric zero for the SDK to acknowledge the native return; other
numeric codes reject with their code and malformed statuses reject as
`invalid-result`. Native response wording and message objects are not serialized.
This is a conservative acknowledgement policy, not proof of a server state change.
Fixed upstream OneBot callers treat any fulfilled Promise as success and do not
validate these layers. Actual Linux ARM64 core inspection also shows a special
status (`2001002`) normalized to a double-zero response; its business meaning is
unverified. The SDK does not accept additional nonzero inner statuses or infer
their meanings. Real permission/effect acceptance, live pagination and essence events
remain required. No group mutation was performed during these controlled checks.

CLI: `qq-native-client group-essence --config ./qq.json --group-id 123456 --message-id 9876543210123456789 --enabled true`.
Use `false` explicitly to remove an essence designation. These commands use the
same explicit login/restore selection and shutdown ownership as other account
commands; invalid intent rejects before configuration or native loading.

Parameter and result codecs were inspected in the actual default Linux ARM64
and Darwin ARM64 binaries for both methods. The
[static contract summary](evidence/group-essence-contracts.json) binds the exact
versions, binary digests and inspection receipts. Other platform/version account behavior
still requires its own evidence. The pinned source call path is
[GroupApi](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/group.ts#L379-L436).

### Remaining event and category contracts

Relationship events require native notifications/system messages with target, subject, operator, cause, correlation and deduplication rules. Generic metadata changes cannot establish whether someone left voluntarily or was kicked. Unknown callback arguments remain unprojected.

Independent inspection of all six default binaries shows category delete takes one uint32 argument and rename takes uint32 plus a string, despite older source declarations accepting category strings. The normal rename callback carries result/errMsg. The two Linux 3.2.32-52194 binaries, macOS ARM64 7.0.2-53644 and Windows x64 9.9.33-52230 additionally connect SDK V2 list categoryId to the core rename selector, including refresh-success and the SDK source=0 path. `renameFriendCategory(categoryId, name): Promise<void>` is enabled only for those four exact measured hashes. macOS x64, Windows ARM64 and unrecognized binaries reject with `unsupported-native-contract` before native rename acquisition. Reordering has a separately verified Linux x64 contract below; single-user assignment has separate Linux x64/ARM64, macOS x64/ARM64 and Windows x64 identity contracts below; Windows ARM64 remains unverified.

The adapter dispatches `renameCategory` once with exactly two arguments and preserves the native receiver. A finite int32 result of zero completes the Promise; this is native ACK, not a server-confirmed name or a read-after-write receipt. The name spelling is preserved; selectors must be numeric uint32 values. Accepting selector zero does not claim the default category is mutable. Five-second timeout or shutdown after dispatch leaves the remote effect unknown; writes are never retried. Static binary evidence and controlled package tests do not establish real account effect. CLI: `friend-category-rename --config ./qq.json --category-id 123 --name TEXT`.

`deleteFriendCategory(categoryId): Promise<void>` sends one uint32 argument to `delCategory`. Its [independent deletion evidence](evidence/friend-category-delete-contract.json) connects that selector to list-derived category IDs and the normal int32 result callback for macOS ARM64 7.0.2-53644 and both Linux 3.2.32-52194 architectures. The Linux evidence also binds the concrete Session Buddy getter, constructed service instance and Node carrier to the deletion receiver. Only these three exact hashes are enabled; macOS x64, Windows and unrecognized binaries reject before acquiring Buddy. Deletion shares the contact mutation owner's input capture, receiver preservation, five-second deadline and close behavior with rename. Numeric zero acknowledges the native call; it does not prove remote disappearance or whether a default category can be deleted. No real category deletion has been performed. CLI: `friend-category-delete --config ./qq.json --category-id 123`.

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
client.on('group-membership', (event) => {
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
client.on('group-admin', (event) => {
  // {groupId,memberUid,enabled}; native UID, no fabricated operator.
});
client.on('group-mute', (event) => {
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

## Reading a group essence page

```ts
const page = await client.getGroupEssencePage('123456', {
  pageStart: 0,
  pageLimit: 50,
});
console.log(page.isEnd, page.messages);
```

`pageStart` is a uint32 passed unchanged as HTTP `page_start`; `pageLimit` is
1..50, default 50. Exactly one page is returned with `isEnd` and `groupRole`.
The SDK does not infer a next cursor or treat an empty page as a complete list.
Sequence/random are distinct from kernel message IDs. Sender and operator IDs
remain decimal strings; operators come only from explicit `add_digest_uin`,
without lookup or fallback. Content preserves numeric discriminators and the
source's optional text/image fields; discriminator meanings are not invented.

The worker gets the login ticket through `.node`, exchanges cookies and reads
QQ's `group_digest/digest_list` endpoint. It shares credential transport with group
notices. Tickets, cookies, response wording and configuration URLs stay in the
worker. Nonzero numeric `retcode` is preserved as the error code. Invalid,
conflicting or duplicate rows reject the whole page. A failed dispatched request
is neither retried nor switched to another native signature or protocol.

The measured Linux ARM64 native list serializer is complete, but the primary
`KernelGroupService` vtable entry contains a single return instruction. The actual
runtime Session vtable has not been observed. Serializer existence cannot prove
an operational native list path, so this interface uses the fixed HTTP contract.
Controlled HTTP/worker tests do not establish real account acceptance. Live
pagination and add/remove essence events still require evidence; the inspected
gray-tip event defaults to add without proving removal or operator semantics.

CLI: `qq-native-client group-essence-list --config ./qq.json --group-id 123456 --page-start 0 --page-limit 50`.
Pagination is validated before configuration access, native initialization or login.

[Fixed HTTP implementation](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/webapi.ts#L74-L94),
[response declarations](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/types/webapi.ts#L108-L130),
and [contract evidence](evidence/group-essence-list-contracts.json) bind this reader
to the inspected sources and binary evidence.

## Reading the complete group essence list

```ts
const messages = await client.listGroupEssenceMessages('123456', { maxPages: 20 });
```

The worker starts at page number 0, increases it by one and reads 50 rows per
page, following the [fixed full-list implementation](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/webapi.ts#L63-L72).
`maxPages` defaults to 20 and accepts 1..1000. The higher configurable cap and
failure rules are SDK policy, not claims about QQ's server limits.

Success requires the explicit `is_end` flag, including on the last allowed page.
Empty nonterminal pages keep reading. Missing termination within the budget
rejects with code `pagination-limit`; any page failure rejects the entire read.
Repeated sequence/random identities across pages reject with
`inconsistent-pagination` rather than silently discarding overlapping data. No
prefix is returned on these failures, and no failed page is retried.

This is a complete traversal, not an atomic snapshot. Concurrent server changes
can cause overlap or omissions; the SDK cannot detect every possible change.
Cookies and native tickets are acquired through the existing worker transport for
each page and never returned. Close prevents further page dispatch and suppresses
late results. Allow a suitable client `timeoutMs` for a multi-page HTTP read.
An RPC timeout sends a best-effort cancellation control to the original worker
for `getGroupEssencePage`, `listGroupEssenceMessages` and `listGroupNotices`. When
delivered, it interrupts that request's wait and HTTP IO and prevents another page
from starting; other account operations remain available. Offline and send failure
use the same cleanup. The caller retains the original timeout/failure even if
cancellation delivery fails. Close also stops reads. Issued native calls cannot be
undone: their late completion is observed without further HTTP dispatch. Other
operations do not gain cancellation or retry semantics from this control.

CLI: `qq-native-client group-essence-all --config ./qq.json --group-id 123456 --max-pages 20`.
The existing `group-essence-list` command still reads exactly one explicit page.
SDK/worker routing, terminal/error behavior and actual installed declarations/CLI
are covered by controlled tests. A real account/server pagination run is pending;
these checks do not verify signing authenticity or add/remove essence events.

## Reordering friend categories

```ts
await client.reorderFriendCategories([
  { categoryId: 123, name: 'Existing work category' },
  { categoryId: 0, name: 'Existing default category' },
]);
```

Supply an explicit category snapshot in the desired order, retaining its existing
names. The SDK requires a nonempty dense array, unique uint32 IDs and string
names; it captures every row before acquiring native services. Empty names are
preserved. It does not fetch or invent names, fill missing categories or retry.
The measured `Buddy.resortCategory` takes **one** array argument with native row
fields `categoryId` and `categroyName`; the upstream typo stays private. The core
uses array ordinals for sorting and also carries each supplied name. This is not
an ID-only protocol, and complete-versus-subset acceptance, protected categories,
name effects and atomic remote ordering remain unverified.

The [binary contract](evidence/friend-category-reorder-contract.json) binds the
list-derived numeric ID namespace, original row order, Session/Buddy receiver and
normal int32 result callback for exact Linux x64 `3.2.32-52194`, wrapper SHA-256
`7882b8e3055cd38584861042befacd8be9939896f5cbbca6fa4a230926b48526`.
Other binary/device profiles reject before acquiring Buddy. Native result zero
is ACK only; nonzero/malformed results reject. Five-second deadline or close after
dispatch leaves remote effects unknown. No real account reordering has run.

CLI: `friend-category-reorder --config ./qq.json --categories-file ./categories.json`.
The file is a JSON array with the same public row fields. Planning reads and
captures it before configuration/native/account work; later file edits cannot
change an already prepared command.

## Creating an empty friend category

```ts
const created = await client.addFriendCategory('Project friends');
// {categoryId:number,name:string}: native acknowledgement, no membership snapshot.
```

The name must be a nonblank string and is sent unchanged. The verified call is `Buddy.addCategoryV2(name, undefined)` with **two arguments**. The wrapper asserts argument count; the second value takes the undefined/null branch and leaves its native byte vector empty. No UID list encoding is assumed. The native callback returns `result`, `errMsg`, optional opaque byte `context`, `name`, and uint32 `groupId`; `groupId` is exposed as `categoryId` and the native returned name is preserved. A success requires `result:0` and valid identity/name fields. Opaque context and unneeded native fields are excluded. This receipt does not certify refreshed membership or remote account state.

Every default binary was inspected independently. The worker streams SHA256 from the selected file itself and uses the actual runtime platform/architecture; neither a manifest claim nor ClientOptions can override this profile. The exact allowed profiles are:

| Platform      | Client version | wrapper SHA256                                                     |
| ------------- | -------------- | ------------------------------------------------------------------ |
| Linux x64     | 3.2.32-52194   | `7882b8e3055cd38584861042befacd8be9939896f5cbbca6fa4a230926b48526` |
| Linux ARM64   | 3.2.32-52194   | `c302361f52494de257044e912e43ed244bb29ee59f59345d25a8959327828337` |
| macOS x64     | 7.0.2-53644    | `e91c58872d3d498f2d3ac1c304ab3ae4602d016274cf3e0f0cb651ad765f1f54` |
| macOS ARM64   | 7.0.2-53644    | `fbc8ad9b328d05e16784d76b0181dda894c17001179dbf8c0d5dd00dc6271358` |
| Windows x64   | 9.9.33-52230   | `63112ab9161e127f5f7e17998a7196e143808923fb54cbbf7b4e21426187a5f0` |
| Windows ARM64 | 9.9.33-52230   | `54e5a6ce127a1f973f28e38ddfbf1338403ea323a141546a6578dd25332c928a` |

Other binaries reject this operation before native dispatch; other SDK capabilities retain their existing contracts. Static evidence establishes this name-only ABI and normal callback shape, not complete native failure settlement. The SDK therefore bounds the wait to five seconds, cancels its wait on close and consumes late rejections. It sends once with no retry. Timeout, close, malformed receipts or IPC failure after dispatch leave the remote effect uncertain: inspect the category list before explicitly deciding to try again.

CLI: `qq-native-client friend-category-add --config ./qq.json --name 'Project friends'`.

[Creation evidence](evidence/friend-category-create-local.json): 655 full regressions, compiled service/declaration/CLI and actual child-worker fixture checks passed. The 423051-byte local candidate matched all 188 installed regular files and 100 compiled files before this evidence/docs append. No native creation or real account operation ran. Its revision `8d2da41` has since passed six-platform CI `38017928237`; its [actual artifact verification](evidence/friend-category-create-ci-38017928237.json) is recorded separately.

## Friend added notifications

```ts
client.on('friend-added', (notice) => {
  // {uid:string,messageId:string,userId?:string}
  console.log(notice.uid, notice.userId);
});
```

The existing Msg receive callback projects the first private gray-tip element with `chatType=1`, `msgType=5`, subtype 17 and exact business ID `19324`. The declared business ID is a string; the SDK tolerates only the exact numeric scalar 19324 as well. Additional message elements are allowed. Empty peer UID is ignored. The event preserves the native UID and message ID, and includes the decimal string QQ account ID only when native peerUin supplies it; it performs no identity lookup. It does not infer an operator, application approval, category, timestamp or complete friend-list state.

Known candidate batches are validated before any notice is emitted; malformed or sparse candidates produce a fixed diagnostic. Duplicate suppression uses UID plus message ID, retains at most 2048 entries per Session and resets on close. Different message IDs remain distinct. The SDK delivers received notices without the pinned OneBot adapter's startup-time cutoff, so cached/offline notices may arrive after startup; an event does not prove the relationship changed at delivery time. Closing, including synchronous close inside an event subscriber, suppresses later notices. Both `watch --events all` and `normalized` include friend-added; default watch remains message-only.

Primary sources at the fixed inspected commit: [friend-add branch](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-onebot/api/msg.ts#L1037), [gray-tip caller](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-onebot/index.ts#L654), [adapter startup cutoff](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-onebot/index.ts#L311).

[Local evidence](evidence/friend-added-local.json): 666 regressions passed; the installed consumer verified compiled callback integration, public declarations, CLI output/cleanup and actual child-worker IPC with a replacement kernel. All 192 installed regular files and 102 compiled files matched the 428587-byte local candidate before this documentation append. No actual native friend-add notification or new account operation was observed. This source requires fresh CI and is not published `0.0.1`.

## Group file folder deletion

```ts
await client.deleteGroupFolder('123456', 'opaque-folder-id');
```

Group IDs remain decimal strings and must fit uint64; folder IDs are nonempty
opaque strings and are preserved exactly. Input is captured before IPC and
validated again before acquiring the native RichMedia service. One invocation
uses the existing Session lifetime and never retries or initiates a readback.
The outer `result` and inner `groupFileCommonResult.retCode` must both be explicit
int32 zero. Nonzero codes reject with their numeric code; malformed statuses
reject as `invalid-result`. Native response wording is not exposed.

CLI: `qq-native-client group-folder-delete --config ./qq.json --group-id 123456 --folder-id opaque-folder-id`.

Folder deletion checks the worker-measured binary profile before acquiring RichMedia. Missing or changed OS, architecture, version or SHA-256 rejects with `unsupported-native-contract` and does not dispatch a mutation. Each of the six fixed profiles has its own deletion contract evidence; other versions require independent verification.
This is a mutation and uses the same explicit login/restore selection as other
account commands. Invalid intent rejects before client creation.

The [static contract](evidence/group-folder-contract.json) binds normal-path
inspection of the six default platform binaries and pinned upstream callers.
A fulfilled `Promise<void>` acknowledges that native return; it does not prove
the folder disappeared remotely. No account folder was deleted during these
checks. Listing, uploads, downloads and group file events still require their own
implementation and acceptance. Creation has its separate contract below.

## Group file deletion

```ts
await client.deleteGroupFile('123456', 'opaque-file-id');
```

CLI: `qq-native-client group-file-delete --config ./qq.json --group-id 123456 --file-id opaque-file-id`.

Use a file's native `fileId`, rather than its name or local path. The SDK preserves
the nonempty opaque string and requires a positive decimal group ID fitting
uint64. Input is captured before IPC and checked again by the group-file owner.
The worker checks the actual OS, architecture, version and wrapper hash before
acquiring RichMedia. Unknown or changed binaries reject as
`unsupported-native-contract` without submitting the mutation.

One invocation sends one ID with the pinned caller's `[102]` parameter. That
constant has no inferred enum meaning and is not exposed as configuration.
The SDK requires explicit int32 zero in outer `result` and nested
`transGroupFileResult.result.retCode`, exactly the requested ID in
`successFileIdList`, and an empty `failFileIdList`. Missing, duplicate, mismatched
or contradictory receipts reject. These are conservative SDK acknowledgement
rules; native serializer inspection alone does not establish remote success
semantics. Nonzero statuses retain numeric error codes; native wording is omitted.

The [six-platform static contract](evidence/group-file-delete-contract.json)
binds each fixed binary's arguments, normal Promise completion, result codecs,
concrete factory and wrapped receiver identity. It does not prove account
permissions or remote file disappearance. No account file was deleted during
implementation or these controlled checks. The operation never retries or
initiates a readback. Closing its owner rejects pending completion, observes late
failures and leaves sibling account operations alive.

## Group file folder creation

```ts
const folder = await client.createGroupFolder('123456', 'Project files');
// {groupId, folderId, parentFolderId, name}; IDs remain strings.
await client.deleteGroupFolder(folder.groupId, folder.folderId);
```

CLI: `qq-native-client group-folder-create --config ./qq.json --group-id 123456 --name 'Project files'`.

The group ID must be a positive decimal string fitting uint64. The name must be a
nonblank string; its original spelling is captured before IPC. Binary provenance
is checked before acquiring RichMedia, using the six independently inspected
profiles in the [creation contract](evidence/group-folder-create-contract.json).
Unknown OS, architecture, version or wrapper bytes reject without native dispatch.

The native completion contains one `groupItem` object, despite the inspected
upstream declaration describing an array. The SDK requires explicit int32 zero
in both outer `result` and nested `resultWithGroupItem.result.retCode`; accepting
both zero codes is a conservative SDK policy, not independently proven remote
success semantics. A returned folder must carry a matching uint64 `peerId` and
string `folderId`, `parentFolderId` and `folderName`; the ID must be nonempty.
The adapter copies only these fields into `GroupFolder`, preserves an empty root
parent ID and does not interpret the native `type` enum. Missing folder information
or a file-only carrier rejects rather than inventing an ID.

One explicit action issues at most one creation. Closing the Session rejects its
pending wait and observes late failures; it cannot undo an already issued action.
No retry, readback or automatic deletion occurs. The example's delete is a separate
explicit mutation. Controlled service, worker and installed-package tests establish
the SDK contract; no real account folder was created during these checks. This
source candidate is not yet the published npm version.

## Group file count

```typescript
const count = await client.getGroupFileCount('123456');
```

CLI: `qq-native-client group-file-count --config ./qq.json --group-id 123456`.

The input is a positive decimal string fitting uint64. One native request contains
exactly that string, including leading zeros. A successful response must contain
zero outer status, exactly one group code and exactly one uint32 count. The echoed
group is compared in its uint64 namespace because native serialization removes
leading zeros. Zero is a valid count. Malformed, sparse, accessor-backed or
mismatched results reject the entire response; native wording is excluded from
errors. There is no callback fallback, retry, limit estimate or second query.

The composition root gates this operation by the independently measured wrapper
hash, platform, architecture and version before lazily acquiring RichMedia. The
[static contract](evidence/group-file-count-contract.json) binds all six default
binaries to independently inspected normal input and completion paths. This is
static and controlled-consumer evidence; no real account count was queried. It
does not enable older versions or prove remote core success semantics.

## Group file pages and complete folder traversal

```typescript
const page = await client.getGroupFilePage('123456', { fileCount: 50 });
const entries = await client.listGroupFiles('123456', {
  folderId: 'opaque-folder-id',
  maxPages: 20,
});
```

CLI: `group-file-list --config ./qq.json --group-id 123456 --start-index 0`
reads one page; `group-file-all --config ./qq.json --group-id 123456 --max-pages 20`
traverses the root folder. Both accept optional `--folder-id`, `--file-count`,
`--sort-type`, `--sort-order` and `--show-onlinedoc-folder`. Full traversal starts
at zero and accepts no starting cursor. It does not recursively list subfolders.

The single-page result contains the requested group/folder, cursor and page size,
`items`, `isEnd`, `nextIndex` and native `allFileCount`. Each item preserves an opaque
int32 `type` and independently nullable `folderInfo` and `fileInfo`. Folder metadata
has all 11 measured fields; file metadata has all 22, including local paths.
Sizes and other uint64 fields remain decimal strings. Optional file parent/path
values remain `null`; both carriers or neither carrier are allowed. Transfer kinds
and time units are not inferred from field names. Unknown extra native properties
are excluded rather than exposing an unvalidated object.

The [separate binary contract](evidence/group-file-page-contract.json) verifies the
synchronous uint32 request token and its path into `Msg/onGroupFileInfoUpdate`.
Zero is valid; it does not by itself establish success. A page uses the first
strictly correlated, fully validated callback. An early callback is copied while
the native method is running; a subsequent native throw still rejects. Nonempty
rows must echo the requested uint64 group. Empty pages rely on the request token;
the callback has no outer group or folder identity.

Full traversal issues a new request for each `nextIndex`, returning only when
`isEnd` is true. Empty pages and counts cannot imply completion. A nonadvancing
cursor, exhausted page budget or failed page rejects the entire read; the caller
receives no partial list. Concurrent native changes can affect successive pages,
so the result does not claim an atomic folder snapshot.

The SDK permits 1..1000 requested entries per page and 1..1000 traversal pages,
defaulting to 50 entries and 20 pages. Each queued page has a five-second deadline.
Callbacks are bounded to 10,000 entries and 16 early snapshots. Request timeout
or cancellation stops queued work and SDK waits, without undoing an issued native
query. Tokens remain reserved for the worker lifetime, including account
replacement. Duplicate tokens, token-budget exhaustion (100,000 requests) or an
untrustworthy post-dispatch token retire this page lane until worker recreation.
Core errors that produce no callback time out as failed reads, never empty success.

The exact measured macOS ARM64 `7.0.2-53644` and Linux ARM64/x64 `3.2.32-52194`
binaries are enabled for this operation. The other three default binaries remain
gated pending independent binding, token and callback evidence. The
[Linux ARM64 record](evidence/group-file-page-linux-arm64-contract.json) and
[Linux x64 record](evidence/group-file-page-linux-x64-contract.json) prove a
conditional FileInfo route: responses containing selector `65103` (`FE4F`) select
a separate Search callback. The SDK never substitutes that callback for a page;
missing FileInfo or downstream completion fails at the deadline. Static inspection
and controlled source/installed consumers validate the SDK contract; no real
account file list was read in these checks.
The x64 record also traces all 45 output fields and the nine full-width unsigned
decimal strings to their actual N-API output slots. Independent interpretation of
the formatter covers its non-padding instructions; it does not execute the addon.
The native group-code parser uses `strtoull` without full-end validation, so the
SDK retains its stricter decimal-only uint64 preflight.
This working-source addition has not been published to npm.

## Search a group by number

```ts
const match = await client.searchGroup('123456');
if (match) console.log(match.groupId, match.name, match.description);
```

CLI: `qq-native-client group-search --config ./qq.json --group-id 123456`.

The input is a positive decimal uint64 string. The returned `GroupSearchMatch`
contains group ID, name, member counts, native owner UID and `fingerMemo` as
`description`; an owner account number is not inferred. This is a search snapshot,
not proof of membership, permissions or a complete search catalog.

The adapter requires a successful native acknowledgement and a matching callback.
The inspected serializer spells its status property `errorode`, despite the
upstream declaration spelling `errorCode`. Requiring numeric zero is a conservative
SDK policy; the native core's status meanings have not been established. The
entire callback batch validates before returning a match. Only a validated terminal
page without the requested ID returns `undefined`; incomplete pages, timeouts and
failures remain errors. The five-second callback deadline does not paginate or retry.

Different keywords serialize, simultaneous identical keywords coalesce, and each
caller receives its own DTO. Callbacks carry no request nonce, so a same-keyword
unsolicited snapshot can satisfy a read. A failed search invalidates further
searches in that Session. Close retires pending and queued work; it cannot undo an
already issued native call. Unknown binary profiles fail before Search acquisition.
Static binary inspection and controlled/installed tests do not establish real
account search success, signing authenticity or cross-platform account support.

The [search binary contract](evidence/group-search-contract.json) binds the six
inspected default OS/architecture binaries to their exact versions and SHA-256.
It records request/acknowledgement/callback codecs and listener registration,
including the distinction between `fingerMemo` and `groupMemo`. This is static
contract evidence, not a real native search receipt.

## Moving one friend to a category

`setFriendCategory(userId, categoryId): Promise<void>` resolves the public account ID
to a native UID, then calls `Buddy.setBuddyCategory(uid, categoryId)` once with
exactly two arguments. The category selector is a numeric uint32 in the V2 list
`categoryId` namespace. Linux x64/ARM64 3.2.32-52194, macOS x64/ARM64 7.0.2-53644
and Windows x64 9.9.33-52230 are enabled only with their exact measured wrapper
hashes; Windows ARM64 and unrecognized binaries reject
with `unsupported-native-contract` before Buddy acquisition. No batch move is enabled.

The [assignment evidence](evidence/friend-category-assignment-contract.json) binds
the actual Node carriers and category selector61af to the V2 category ID. Linux
x64 binds selector1000 and the same-instance request vector to `BuddyExtSpecifyUidCodec`.
macOS binds the original request through its concrete Buddy receiver and worker:
selector1000 becomes field1 string, selector61af becomes field2 numeric, and the
same encoded body reaches transport with command `0x10eb`, subcommand `1`. UID
meaning is inferred from this exact command/body matching the pinned independent
protocol implementation linked in the evidence; it is not an official QQ schema
or a connection to the differently routed native UID vector codec.
Linux ARM64 separately binds the original scalar request through its concrete
provider and `BuddySetCategoryWorker`: selector1000 becomes field1 string and
selector61af becomes field2 uint32. The constructor supplies `0x10eb / 1`; the
actual indirect supplier call receives that command, subcommand and the same
encoded body. Its UID meaning uses the same explicitly inferred primary schema
match. The concrete supplier target remains unresolved. The registered receiver
comes from wrapper `+8/+10`, whereas the incoming Session pair is retained in
`+40/+48`; those pairs are kept separate. This limits transport implementation
claims without replacing the observed request tuple or proving a remote effect.
Windows x64 separately binds the normal Session host installation, the same
constructed Buddy instance and the original two-argument request through its
worker. Selector1000 becomes field1 string and selector61af becomes field2
numeric from the original uint32 source. Command `0x10eb / 1` and that same
encoded body reach the actual supplier virtual call; its concrete target remains
unresolved. UID meaning uses the same explicit pinned-source inference. The V2
list namespace follows the same fresh core selfweak and cached category rows,
including SDK source=0 and refresh-success.
macOS x64 has its own normal Session installation and constructed Buddy
secondary receiver, original request worker and cached row namespace evidence.
The same encoded `0x10eb / 1` body reaches supplier virtual `0xc0`; UID meaning
uses the same explicit protocol inference. Its first refresh cache producer and
concrete supplier target remain unparsed. Successful refresh reissues the same
core cached reader; row0 preserves the V2 category ID and native selector61af.
Normal completion carries int32 `result` and string `errMsg`.
Strict numeric zero is the SDK's native ACK acceptance policy; it does not prove
a server-side membership change, protected-category admissibility or atomicity.
Five-second timeout or close after dispatch leaves the remote effect unknown.
There is no retry or automatic readback.

The public method, IPC route and CLI action are covered by controlled fixtures;
no real account assignment has run. CLI: `friend-category-set --config FILE --target UIN_OR_UID --category-id UINT32 [--uin UIN]`.
`--target` identifies the friend to move; optional `--uin` selects the login account.
The Windows ARM64 identity chain and real mutation acceptance remain
separate verification tasks.

The [macOS ARM64 completion analysis](evidence/friend-category-assignment-darwin-analysis.json)
checks the actual 7.0.2-53644 wrapper's completion closure independently. Its
`closure+8` object is `KernelTrace`: the result slot records status and message
in trace fields 1/2. The original category request is a separate pair passed
to a receiver's virtual slot `0x58`. The assignment evidence now binds that
separate original request through the concrete receiver, worker and encoded
transport body. The trace chain remains separate and supplies no UID semantics.
No account was used; signing authenticity and remote mutation acceptance remain
unverified.
