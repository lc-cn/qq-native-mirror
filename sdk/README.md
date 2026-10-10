# qq-native-client

TypeScript QQ client SDK for ordinary Node.js. `createClient` prepares a native
kernel in an SDK-owned Node child process. Consumers need no QQ installation,
Electron, UI or Docker.

Development is ongoing. Source is the `0.0.2` candidate; the recorded initial npm
release is `0.0.1`. Working-source additions are not necessarily published npm
features. See [release records](docs/npm-first-publish.md) and the
[full capability and acceptance checklist](docs/sdk-acceptance.md).

## Install and log in

```sh
npm install qq-native-client@0.0.1
```

The main package pins six optional packages:
`qq-native-client-{darwin,linux,win32}-{x64,arm64}`. npm selects the matching device.
The SDK verifies a compatible installed package first; otherwise its catalog
selects the latest compatible native version for that device. Native versions
and npm versions are independent. Linux requires glibc. Current Windows bundles
require official Node **24.20.0** with matching runtime configuration;
macOS/Linux require Node 24 or later.

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

Omitting `login` prepares the kernel without authentication. To reuse authorization
in the same data directory, call `login({method:'restore',uin:'123456'})`.
Omit `uin` only with exactly one eligible record. Explicit quick login uses
`{method:'quick',uin:'123456'}`. Password login is not implemented.

`authenticated` precedes account Session startup; `login`, `ready` and the login
Promise indicate readiness. Each client owns one account/data directory. Close
preserves authorization files. Use explicit `reconnect` after a failure.
A mutation timeout does not prove that the server did nothing: the SDK never
replays a timed-out send or management operation automatically.
See [lifecycle and errors](docs/architecture.md#lifecycle-and-error-contracts).

## Working-source capability guide

The package-root declarations define exact method signatures. Internal file paths
are private implementation, not extension interfaces.

| Domain             | Methods and events                                                                                                                                                    | Detailed contracts                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Account            | `login`, `waitForLogin`, `reconnect`, `close`; QR, authenticated, ready, offline, kicked                                                                              | [Login](docs/login-contract.md), [Session](docs/session-strategy.md)                          |
| Messages           | Private/group sends, exact/batch/history queries, recall; `message`, `message.private`, `message.group`, `message.recalled`                                           | [Queries](docs/contact-group-query.md), [Acceptance](docs/sdk-acceptance.md)                  |
| Media/forwarding   | Image, voice, video, file, reply, face inputs; attachment download, forwarding and merged-forward resources                                                           | [Acceptance](docs/sdk-acceptance.md), [File recall limits](docs/file-recall-investigation.md) |
| Friends/categories | Lists/profiles/categories, remarks, deletion, request handling, category creation and metadata events                                                                 | [Contacts/groups](docs/contacts-groups.md)                                                    |
| Groups             | Lists/members/mutes, metadata/member management, notices, requests, essence, folder deletion and single-group file count; group metadata/membership/admin/mute events | [Contacts/groups](docs/contacts-groups.md)                                                    |
| Diagnostics        | `state`, `account`, `diagnostic`, `KernelRequestError`                                                                                                                | [Architecture](docs/architecture.md)                                                          |

Queries validate complete native responses; errors do not become empty results.
Identifiers stay strings, including values beyond JavaScript's safe integer range.
Metadata synchronization does not by itself establish an operation's cause or success.
Management methods have separate completion contracts: some mean submission only,
some require zero status fields. `deleteGroupFolder` requires two zero statuses
and still does not independently confirm remote disappearance.

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
An explicit native version selects the matching platform/version entry. Download
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

## Evidence and remaining work

Six-platform prepare/close and controlled consumers have evidence; full account
interoperability on all six platforms remains incomplete. Prior macOS arm64 runs
verified login, restore and selected query/message operations. Linux login has
evidence with remaining restore/query differences. Windows and macOS x64 account
business acceptance is pending. Historical results cover their recorded source,
native version and operation, not every later revision.

Friend applications, remaining category management, group creation/search/join/
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
