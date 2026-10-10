# Friends, categories and groups

These are working-source additions for the next candidate, not published `0.0.1` features. Six-platform CI run `38014518589` succeeded for revision `7f24062` (categories/remarks/detail event); Revision `b0dee1c` group detail/membership additions also passed six-platform CI `38015512259`; its [bounded artifact audit](evidence/group-query-system-events-ci-38015512259.json) matched 94 compiled files to 47 source files and six native prepare/close receipts. Revision `9deaa56` administrator/mute events and mute-list additions passed CI `38016572108`; its [independent bounded artifact audit](evidence/group-admin-mute-ci-38016572108.json) matched 96 compiled files to 48 committed source files and six prepare/close receipts using 582496 bytes of actual ranges. Revision `8d2da41` category creation passed six-platform CI `38017928237`; its [independent bounded artifact audit](evidence/friend-category-create-ci-38017928237.json) matched 100 compiled files to 50 committed source files and seven manifest-bound receipts using 590577 bytes of actual ranges. The later friend-added source requires its own CI. The [7f CI audit](evidence/contacts-groups-ci-38014518589.json) independently matched the actual main package's 92 compiled files to 46 committed source files and six platform prepare/close receipts, using 571463 bytes of bounded official ranges. It did not re-read six large auxiliary packages or verify the complete ZIP digest. Controlled service/worker and installed-package checks are separate from real account acceptance.

| Area              | Available methods/events                                                                                                                                                   | Remaining work                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Friends           | Lists/profiles, remarks/deletion, request listing/handling, `request.friend`, `friend-list-updated`, `friend-added`                                                        | Sending applications; independent deleted/profile/remark notices                                                                               |
| Friend categories | `listFriendCategories`, `addFriendCategory`; categorized `friend-list-updated` metadata                                                                                    | Delete/rename/reorder categories and move friends; parameters and completion responses need verification                                       |
| Group queries     | Lists/members/`getGroupInfo`/`listGroupMutedMembers`, `group-list-updated`, `group-members-updated`, `group-info-updated`, `group-membership`, `group-admin`, `group-mute` | Complete join classification and real event/query acceptance                                                                                   |
| Group actions     | Name/remark, all/member mute, member card/admin/kick, leave, notices, requests, essence add/remove folder deletion acknowledgement and single-group file count             | Create/join/invite, member titles, live essence pagination and add/remove events, remaining group file operations and real mutation acceptance |

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

Independent inspection of all six default binaries shows category delete takes one uint32 argument and rename takes uint32 plus a string, despite older source declarations accepting category strings. Their normal callbacks return result/errMsg. Linux inspection connects the created groupId to the core selector used by these operations, but the V2 list categoryId namespace and the other platforms' semantic connection still need proof. Delete/rename remain private until identifiers are connected; reorder and friend moves need separate contracts.

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
This is a mutation and uses the same explicit login/restore selection as other
account commands. Invalid intent rejects before client creation.

The [static contract](evidence/group-folder-contract.json) binds normal-path
inspection of the six default platform binaries and pinned upstream callers.
A fulfilled `Promise<void>` acknowledges that native return; it does not prove
the folder disappeared remotely. No account folder was deleted during these
checks. Listing, creation, uploads, downloads and group file events still require
their own implementation and acceptance.

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

A reliable file list remains unresolved. The pinned upstream callback contains a
`reqId` but no group or folder identity, while its request parameters contain no
`reqId`. The upstream caller accepts any matching callback family. Serializing
SDK requests alone cannot identify unsolicited notifications. The SDK must first
verify that correlation rather than returning a potentially unrelated list.

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
