# qq-native-client

TypeScript QQ client SDK for ordinary Node.js. `createClient` prepares a native
kernel in an SDK-owned Node child process. Consumers need no QQ installation,
Electron, UI or Docker.

Development is ongoing. Source is the `0.0.2` candidate; the recorded initial npm
release is `0.0.1`. Working-source additions are not necessarily published npm
features. See [release records](docs/npm-first-publish.md) and the
[full capability and acceptance checklist](docs/sdk-acceptance.md).
The [quality acceptance plan](docs/sdk-quality.md) tracks the route to a complete
SDK, including public API usability, lifecycle reliability and release evidence.

## Install and log in

```sh
npm install qq-native-client@0.0.1
```

The main package pins six optional packages:
`qq-native-client-{darwin,linux,win32}-{x64,arm64}`. npm selects the matching device.
In the working source, omitting `version` resolves the catalog's latest version
for that device. An installed package is reused only when its full version,
runtime constraints and original file inventory match the trusted manifest.
Otherwise the selected bundle is downloaded or reused from verified cache.
Catalog or manifest failures reject; they do not silently select an older package.
Native versions and npm versions are independent. Linux requires glibc: the measured
public/current registration bridges require **glibc 2.34 or later** (`dlopen` and
`dlerror` import `GLIBC_2.34`). This is a bridge-only minimum; vendor libraries can
impose higher requirements. The complete public Linux inventories currently require
glibc **2.34** for QQ 3.2.31-51102 on both architectures; QQ 3.2.32-52194 requires
**2.38 on ARM64 / 2.35 on x64**, with **GLIBCXX_3.4.26**.
See [Linux loading prerequisites](docs/linux-runtime.md#actual-loading-prerequisites)
for the static scope and measured environments. Current Windows bundles require official Node
**24.20.0** with matching runtime configuration; macOS/Linux require Node 24 or
later. Measured Linux environments include Ubuntu 24.04 with Node 24.20.0 and
Debian 13 with Node 24.21.0, not every distribution or Node 24 minor release.

```ts
import { createClient } from 'qq-native-client';
import { writeFile } from 'node:fs/promises';

const client = await createClient({ dataDir: '/absolute/path/to/account-data' });
client.on('qrcode', ({ image }) => {
  void writeFile('./qrcode.png', image, { mode: 0o600 }).catch((error) => {
    console.error('Cannot save QR image:', error.message);
  });
});
client.on('login-error', (error) => console.error(error.message));

try {
  const account = await client.login({ method: 'qr' });
  // Confirm the QR login on the phone; the Promise also waits for Session readiness.
  const friends = await client.listFriends();
  console.log(account.uin, friends.length);
} finally {
  await client.close();
}
```

Omitting `login` prepares the kernel without authentication. When supplied,
`login` schedules authentication after initialization; listen for `loginError` to
observe a failure. Closing or reconnecting cancels that pending task. An explicit
`client.login()` takes over and reports through its returned Promise. Cancellation
cannot undo authentication already submitted to the worker. Error event handlers
must handle their own failures: an exception escaping automatic login or restore
notification is raised after current Promise settlements. Node's default
uncaught-exception behavior exits the process, even in rejection `warn` mode.
To reuse authorization
in the same data directory, call `login({method:'restore',uin:'123456'})`.
Omit `uin` only with exactly one eligible record. Explicit quick login uses
`{method:'quick',uin:'123456'}`. Password login is not implemented.

`authenticated` precedes account Session startup; `login`, `ready` and the login
Promise indicate readiness. Each client owns one account/data directory. Close
preserves authorization files. Use explicit `reconnect` after a failure. With `autoReconnect` enabled, only a
retryable disconnect schedules restoration. Close or an admitted manual login cancels its
pending task and obsolete error notifications. A same-request manual `login` or `reconnect`
joins the shared result and takes over error observation; invalid or conflicting
requests leave the admitted restore in charge. Submitted work is not undone.
During reconnect, `login(request)` joins only the same normalized method and
account; another request rejects before IPC. Initialization still precedes the
replacement login. Input validation completes before ownership changes, and a
reentrant close or reconnect during validation is checked before admission.
`waitForLogin()` joins an admitted reconnect through worker retirement,
initialization and authorization, sharing its Promise and outcome without
starting another login or taking over automatic error observation. Explicit
close still rejects waiting; without a reconnect, an online account is returned
as a detached snapshot.
In the working source, `client.nativeExports` returns a fresh `string[]` snapshot.
Editing or freezing it does not change the client. Reread the property after
reconnect; previously read arrays retain their original contents.
A mutation timeout does not prove that the server did nothing: the SDK never
replays a timed-out send or management operation automatically.
See [lifecycle and errors](docs/architecture.md#lifecycle-and-error-contracts).

## Reply to a message event (working source)

`message`, `message.private` and `message.group` deliver `MessageEvent` with
`reply(content, quote = false): Promise<SentMessage>`. It sends to the captured
conversation; `true` adds a reply element for the original message.

Every live message has immutable `text`, made by joining its text elements in
order without trimming or inserting media labels. Use `message.text.trim()` for
keyword matching. `conversation` exposes the captured private or group contact.

`message.private` receives `PrivateMessageEvent` with `peer.userId` and `friend`;
`message.group` receives `GroupMessageEvent` with `peer.groupId`, `group` and
`member`. For example, `event.group.files.list()` reads that group's files and
`event.member.getProfile()` queries the captured sender. Contact objects do not
assert friendship, membership or permission and share the event's session lifetime.

The general event and its alias share one object. Its `peer` is a detached,
frozen snapshot; `text` and contact properties cannot be replaced. Later changes
to `sender` or `elements` cannot change those captured values or reply routing.
Contact objects and `reply` are non-enumerable, so JSON output remains message
data. Malformed worker conversation/member identities produce a diagnostic
instead of an actionable event. Other message fields retain their existing
snapshot/reference semantics; history/query results remain passive `Message` DTOs.

```ts
client.on('message', (message) => {
  if (message.sender.userId === client.account?.uin) return;
  if (message.text.trim() !== 'ping') return;
  message.reply('pong', true).catch((error) => console.error(error.message));
});
```

Observe the returned Promise. A retained event cannot reply after its account
session is retired by close, disconnect or replacement. No failed send is replayed.
History/query results and worker payloads remain plain `Message` data without
this method. This working-source addition is not a claim about the published
`0.0.1` interface or real message delivery.

## Compose messages (working source)

`MessageInput` accepts text, one sendable element, or a readonly array mixing text
and elements. Use `segment` for typed element construction:

```ts
import { segment } from 'qq-native-client';

await client
  .pickGroup('987654')
  .sendMessage([segment.at('123456'), ' received ', segment.face(14)]);
await client.pickFriend('123456').sendMessage(segment.image('/absolute/path/to/image.png'));
```

The constructors are `text(text)`, `at(userId, text?)`, `face(id)`, `image(file)`,
`record(file)`, `video(file)`, `file(file, name?)` and `reply(messageId)`.
`at('all')` mentions the group. Constructors only create data; sending validates
the complete input, captures it without changing the caller's data, and then
dispatches. Media uses absolute local paths. Private mentions, sparse/nested
arrays, accessors and unsupported element kinds reject before dispatch.
Client sends, contact sends and `message.reply()` accept the same inputs.

## Decide incoming requests (working source)

`request.friend` provides `FriendRequestEvent.approve(accept = true)`;
`request.group` provides `GroupRequestEvent.approve(accept = true, reason?)`.
Both return `Promise<void>` and act only when called. For example, an application
can pass a received event and its own decision to these functions:

```ts
import type { FriendRequestEvent, GroupRequestEvent } from 'qq-native-client';

async function decideFriend(request: FriendRequestEvent, accept: boolean): Promise<void> {
  await request.approve(accept);
}

async function decideGroup(request: GroupRequestEvent, accept: boolean): Promise<void> {
  await request.approve(accept, accept ? undefined : 'Request declined');
}
```

An event keeps its original request identity even if its visible fields change.
Approval rejects after its account session retires, and failures are not retried.
The result retains the client method's submission/acknowledgement semantics; it
does not independently confirm friendship or group membership. List results
remain plain `FriendRequest`/`GroupRequest` snapshots without `approve()`.
The legacy `friend-request` name remains a deprecated alias of `request.friend`;
both receive the same event, so applications normally subscribe to one name.

## Work with friends, groups and members (working source)

After login, select a destination once. These methods use the same validation,
operation results and error behavior as the corresponding client methods.

```ts
const friend = client.pickFriend('123456');
const group = client.pickGroup('987654');
const member = group.pickMember('123456');
// Equivalent selection: client.pickMember('987654', '123456').

const profile = await friend.getProfile();
const recent = await group.getHistory({ limit: 10 });
const members = await group.getMembers();
console.log(profile.nickname, recent.length, members.length, member.userId);

const sent = await friend.sendMessage('hello');
await friend.recallMessage(sent.messageId);
```

| Object           | Operations                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Friend and group | `sendMessage`, `getHistory`, `getMessage`, `getMessages`, `recallMessage`, `getForwardMessages`, `forwardMessages`, `sendMergedForward`, `downloadAttachment` |
| Friend           | `getProfile`, `setRemark`, `setCategory`, `delete`                                                                                                            |
| Group            | `getInfo`, `getMembers`, `listMutedMembers`, `pickMember`, `setName`, `setRemark`, `mute`, `leave`                                                            |
| Group member     | `getProfile`, `setCard`, `setAdmin`, `mute`, `kick`                                                                                                           |
| `group.files`    | `count`, `getPage`, `list`, `createFolder`, `deleteFolder`, `deleteFile`                                                                                      |
| `group.notices`  | `list`, `publish`, `delete`                                                                                                                                   |
| `group.essence`  | `getPage`, `list`, `set`                                                                                                                                      |

Group resources keep their own focused API and the selected group's identity:

```ts
const group = client.pickGroup('987654');
const files = await group.files.list({ maxPages: 5 });
const notices = await group.notices.list();
const essence = await group.essence.getPage({ pageStart: 0, pageLimit: 20 });
console.log(files.length, notices.notices.length, essence);

// Forward existing messages from this group into the chosen destination.
await group.forwardMessages({ type: 'private', userId: '123456' }, ['789']);
// Download an attachment already identified by a message/element query.
await group.downloadAttachment('789', '1', '/absolute/path/attachment.bin');
```

`files.list()` and `essence.list()` either reach the server end marker or reject;
they do not return a truncated success when the page budget runs out.
`notices.list()` returns the supported notice page, not a complete history.
`essence.set(messageId, enabled)` uses a kernel message ID; essence query results
contain sequence/random identifiers and cannot be passed as that ID.
`sendMergedForward()` accepts text records. Mutation completion retains the
underlying operation's submission/acknowledgement semantics; it does not establish
delivery or remote state and failures are not automatically retried.

`pickFriend`, `pickGroup` and `pickMember` are synchronous and require an online
client and positive decimal QQ IDs as strings. Selection performs no network
request and does not verify friendship or membership. IDs and conversation peers
are immutable. `GroupMemberContact.getProfile()` reads the account profile; use
`group.getMembers()` for group-specific membership data. Mutation completion has
the same [acknowledgement limits](docs/contacts-groups.md) as the client method.

Each object belongs to the session in which it was selected. After disconnect,
reconnect, account replacement or close, its methods reject; select a fresh object
after login. A retained object never silently starts using another account.
The `offline` listener observes the retired account state. A new explicit login
started there survives the companion notifications from that same transition;
a later independent disconnect still cancels it.
The classes are exported as `FriendContact`, `GroupContact`, `GroupMemberContact`,
`GroupFiles`, `GroupNotices` and `GroupEssence`. Resource objects have the same
session lifetime as their group, even when retained separately. The existing
`Friend`, `Group` and `GroupMember` types remain
plain query results. This API is part of the working source, not the recorded
`0.0.1` npm release.

Group avatars use `client.setGroupAvatar(groupId, absoluteFilePath)` or
`group.setAvatar(absoluteFilePath)`. The working source currently enables this
operation for the exact macOS ARM64 QQ `7.0.2-53644` profile. It validates a readable,
nonempty local file, waits up to five seconds for the native acknowledgement and
never retries; other profiles reject before native invocation. See the
[group avatar contract](docs/contacts-groups.md#group-avatars) for error semantics
and the separate remote-effect acceptance requirement.

## Working-source capability guide

The package-root declarations define exact method signatures. Internal file paths
are private implementation, not extension interfaces.

| Domain             | Methods and events                                                                                                                                                                                                                                  | Detailed contracts                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Account            | `login`, `waitForLogin`, `reconnect`, `close`; QR, authenticated, ready, offline, kicked                                                                                                                                                            | [Login](docs/login-contract.md), [Session](docs/session-strategy.md)                          |
| Messages           | Private/group sends, exact/batch/history queries, recall; `message`, `message.private`, `message.group`, `message.recalled`                                                                                                                         | [Queries](docs/contact-group-query.md), [Acceptance](docs/sdk-acceptance.md)                  |
| Media/forwarding   | Image, voice, video, file, reply, face inputs; attachment download, forwarding and merged-forward resources                                                                                                                                         | [Acceptance](docs/sdk-acceptance.md), [File recall limits](docs/file-recall-investigation.md) |
| Friends/categories | Lists/profiles/categories, remarks, deletion, request handling, category creation, exact-binary category rename on four profiles, deletion on three measured macOS ARM64/Linux profiles, explicit-snapshot reorder on Linux x64 and metadata events | [Contacts/groups](docs/contacts-groups.md)                                                    |
| Groups             | Lists/members/mutes, metadata/member management, notices, requests, essence, folder actions/file deletion/file counts, exact-binary group-file pages and folder traversal; group metadata/membership/admin/mute events                              | [Contacts/groups](docs/contacts-groups.md)                                                    |
| Diagnostics        | `state`, `account`, `diagnostic`, `KernelRequestError`                                                                                                                                                                                              | [Architecture](docs/architecture.md)                                                          |

Queries validate complete native responses; errors do not become empty results.
Identifiers stay strings, including values beyond JavaScript's safe integer range.
Metadata synchronization does not by itself establish an operation's cause or success.
Management methods have separate completion contracts: some mean submission only,
some require zero status fields. `deleteGroupFolder` requires two zero statuses
and still does not independently confirm remote disappearance. `deleteGroupFile`
additionally requires an exact per-file acknowledgement, with the same remote
effect limitation.

## CLI

```sh
qq-native-client --help
qq-native-client init --config ./qq.json --data-dir /absolute/path/to/account-data
qq-native-client login --config ./qq.json --method qr
qq-native-client contacts --config ./qq.json
qq-native-client groups --config ./qq.json
qq-native-client watch --config ./qq.json --events normalized
```

Help lists configuration, login, reads, watch and explicit send/management commands.
Business commands restore existing authorization; QR login is explicit. Watch
prints only messages by default; `normalized`/`all` print named business envelopes.
Shutdown releases subscriptions and closes the client.

## Native packages and mirrors

Explicit `wrapperPath`, `manifestUrl` or `catalogUrl` override default selection.
An explicit native version reuses a matching installed package offline, or selects
the matching platform/version catalog entry. Download
accelerators are opt-in configuration.

```ts
const client = await createClient({
  manifestUrl: 'https://your-mirror.example/qq/manifest.json',
  manifestSha256: 'trusted-64-character-sha256-digest',
  cacheDir: '/absolute/path/to/native-cache',
  dataDir: '/absolute/path/to/account-data',
});
```

A manifest records native versions, device constraints, wrapper and dependencies.
Files retain their relative layout and are verified during download, cache reuse
and installation. A wrapper alone is insufficient for all inspected kernels.
See [multi-version mirror design](docs/multi-version-and-mirror.md) for selection
and complete-bundle fallback. GitHub Actions builds platform packages; push builds
do not publish npm. See [first/trusted publishing](docs/npm-first-publish.md).

In the working source, an explicit `bridgePath` must be a nonempty path to a
readable regular file. Relative bridge paths retain the worker's `dataDir` base.
On macOS and Linux, the default selects the adjacent registration bridge first,
then the package's platform bridge if the adjacent path is absent. An existing
invalid adjacent path rejects rather than silently selecting another bridge.
Bridge file validation happens before worker creation; explicit bridge validation
also precedes native acquisition. This file check does not certify native ABI
compatibility or replace manifest integrity verification.

## Evidence and remaining work

Six-platform prepare/close and controlled consumers have evidence; full account
interoperability on all six platforms remains incomplete. Prior macOS arm64 runs
verified login, restore and selected query/message operations. Linux login has
evidence with remaining restore/query differences. Windows and macOS x64 account
business acceptance is pending. Historical results cover their recorded source,
native version and operation, not every later revision.

Friend applications, remaining category management, group creation/join/
invite, complete group file lifecycle/events and cross-platform account/media
acceptance remain required. Signature authenticity and detection propagation are
unresolved. Login success and vendor file hashes do not establish authentic signing.

- [Full acceptance matrix](docs/sdk-acceptance.md)
- [Linux evidence](docs/linux-runtime.md)
- [Signing investigation](docs/signing-integrity.md)
- [Acceptance history](docs/acceptance-history.md) and [fixed earlier README](docs/history/readme-f45f39a.md)

## Development

[Architecture](docs/architecture.md) defines ownership, dependency direction and
lifecycle. [Development guide](docs/development.md) defines module placement.

```sh
npm ci --ignore-scripts
npm run format
npm run check
```

The gate runs formatting, zero-warning lint, source/test type checking,
deterministic regressions, a clean build and a real packed/installed consumer.
Controlled tests do not log into accounts. Local bridge builds require a platform
compiler and Node headers; Windows CI builds against its pinned runtime.
Published consumers use prebuilt packages without a compiler.
