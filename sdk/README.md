# qq-native-client

TypeScript/npm QQ client SDK under development, using a QQ native kernel under ordinary Node.js. No QQ/Electron executable is launched. Native singletons run in an isolated **Node.js** child process owned by the module.

Current validated environment: macOS arm64, Node 24.19.0, QQ native kernel 7.0.2-53644. Real wrapper loading (104 exports), QR generation, user-confirmed authentication and account Session readiness have passed. The installed npm tarball also passed a real mirror download and restored the authorized account from the independent native bundle. Linux 3.2.32-52194 arm64 also passed ordinary Node loading and QR generation through the public createClient API; Linux arm64 QR authentication and account Session readiness have since passed; Linux login restoration has failed and post-login read APIs remain unverified. See [Linux runtime evidence](docs/linux-runtime.md).

Platform evidence is specific to the tested native version; it is not a promise of complete compatibility.

| Platform / native version | Installed Node preparation | Account login / restore | Account operations |
| --- | --- | --- | --- |
| macOS arm64 / 7.0.2-53644 | Passed | QR and restore passed in prior account runs | Friends/groups/members/history and one authorized private text send/recall passed |
| Linux arm64 / 3.2.32-52194 | Passed with current package | QR readiness passed; restore attempt failed | Post-login queries and messaging not verified |
| Linux amd64 / 3.2.32-52194 | Passed under amd64 emulation | QR authentication and Session readiness passed; restore unverified | Latest read-only run: 3 friends, 13 groups, first-group member response empty; completeness and messaging unverified |

Security-signature authenticity remains unresolved on every platform. Quick login has a public implementation but lacks separate account acceptance; media, management and request handling require their own real-account acceptance. See [acceptance requirements](docs/sdk-acceptance.md).

```ts
import { createClient } from 'qq-native-client';
import { writeFile } from 'node:fs/promises';

const client = await createClient({
  wrapperPath: '/path/to/native-package/wrapper.node',
  dataDir: '/path/to/my-account-data',
  version: {
    clientVersion: '7.0.2-53644',
    appId: '537391652',
    qua: 'V1_MAC_7.0.2-53644_53644_GW_B',
  },
  login: { method: 'qr' },
  timeoutMs: 120_000,
});

client.on('qrcode', async ({ image, url }) => {
  await writeFile('./qrcode.png', image, { mode: 0o600 });
  // Show the image to the user, who confirms authorization on their phone.
});
client.on('authenticated', identity => { /* Account auth succeeded; session starts next. */ });
client.on('loginError', error => console.error(error.message));

try {
  const identity = await client.waitForLogin();
  // Resolves after the account Session reports readiness.
} finally {
  await client.close();
}
```

Omit `login` to prepare/load the native kernel only, then call `client.login({method:'qr'})` explicitly. To restore an account previously authorized in the same data directory, use `login: {method:'restore'}` (verified with a real macOS arm64 account; Linux restore has not passed). Restore without an account number requires exactly one eligible record; otherwise provide `uin`. `login: {method:'quick',uin:'...'}` explicitly requests native quick login. Password login is not implemented.

A parent-side login timeout retires the worker and ignores late readiness. Retry with explicit `reconnect(...)`; it does not automatically repeat authorization. Account files are preserved. Business-operation timeouts report an unknown completion outcome and do not imply cancellation of the native mutation; never automatically replay a timed-out send or management action.

Worker failures reject with exported `KernelRequestError`: `operation` identifies the request, `code` preserves an explicitly supplied native/system code, and `originalName` preserves the worker error name. Errors without a supplied code leave it undefined. Arbitrary native objects, causes and stack traces are not copied through this error serializer. Error codes are not interpreted as detection or safe-retry signals.

## Native dependencies

The package includes our small N-API registration bridge. QQ native files are supplied separately and **are not included in this npm package**. Keep the kernel's dependent dylibs/frameworks at their original relative paths. Providing only wrapper.node is insufficient for the inspected macOS kernel.

Native files can be supplied by a complete mirror manifest:

```ts
const client = await createClient({
  manifestUrl: 'https://your-mirror.example/qq/macos-arm64/manifest.json',
  manifestSha256: '...trusted 64-character SHA-256 digest...',
  cacheDir: '/path/to/native-cache',
  dataDir: '/path/to/account-data',
  login: { method: 'qr' },
});
```

The manifest contains kernel version metadata, platform/architecture and a list of every native dependency. Files download individually, preserving nested framework directories. Relative URLs resolve against the manifest URL. The manifest and each file require SHA-256 verification; cached files are revalidated. HTTPS is required except for localhost development. The default public mirror is hosted at [lc-cn/qq-native-mirror](https://github.com/lc-cn/qq-native-mirror).

```json
{
  "schemaVersion": 1,
  "id": "qq-7.0.2-53644-darwin-arm64",
  "platform": "darwin",
  "arch": "arm64",
  "wrapper": "wrapper.node",
  "version": {
    "clientVersion": "7.0.2-53644",
    "appId": "537391652",
    "qua": "V1_MAC_7.0.2-53644_53644_GW_B"
  },
  "files": [
    { "path": "wrapper.node", "url": "wrapper.node", "sha256": "..." }
  ]
}
```

The abbreviated example must be extended with all dependent native files. See `scripts/export-local-native.ts` for exporting a local dependency bundle for research/mirror preparation. Exported binaries stay in `.local` and are excluded from npm packaging.

## Development

```sh
npm install
npm run build
npm test
node scripts/probe-native.ts --bridge native/darwin-arm64/registration-bridge.node
node scripts/login-local.ts
```

Building the bridge requires clang and Node C headers. Set `QQ_NODE_INCLUDE` if the headers are not in the normal Node install locations. Packaged consumers use the prebuilt bridge for their supported architecture; `bridgePath` can select an externally built bridge.

`login-local.ts` uses an independent `.local/login` data directory and stops after QR generation by default. `--wait` waits for phone authorization; `--restore` uses existing authorization. Use `QQ_NATIVE_DIR` to test an exported dependency package instead of the installed app's resource directory. `smoke-packaged.ts` verifies a locally installed tarball, localhost mirror download and native account restoration; run it only after authorizing the test account.

Native files execute native code; SHA-256 establishes correspondence to a trusted package, not that an arbitrary mirror is trustworthy. Treat login images and account directories as private. The macOS kernel queries Disk Arbitration during initialization: a restrictive sandbox can produce an upstream CFRelease(NULL) crash. The module reports worker termination; it does not suppress the native error or invent hardware data.

Preserve original native filenames and dependency layout when building bundles. Static inspection of the pinned Linux arm64 signing provider found a caller-image path substring check for `wrapper.node`; matching bytes alone do not establish equivalent loading context. The SDK's exporters preserve that vendor filename. This observation does not prove signing authenticity or identify a fake-sign marker; see [signing investigation](docs/signing-integrity.md).

## Status and limitations

- Implemented: local native loading, mirror download/cache, registration bridge, QR/quick/restore login adapters, Session readiness lifecycle, explicit close and native crash isolation.
- Verified with real native kernel: loading, QR authentication, account Session readiness and restoration using a standalone native package.
- Verified packaged consumer path: npm tarball installation, import by package name, 1157 localhost mirror requests (manifest plus 1156 native files), SHA-256 validation, restored account readiness.
- The public GitHub mirror is published; full default download initialization validation is still in progress.
- Public APIs now include friend/group/member queries, text and group mention sending, history, recall and message events. Real macOS account testing has verified friend queries and incoming message callbacks; group/member/history queries and explicit private text sending/recall have also passed real account checks; the user confirmed seeing the message or recall notice.
- Image/reply/file/video/record sending and attachment downloading are implemented. Video metadata/thumbnail generation and built-in WAV/SILK conversion have actual local verification; QQ media delivery remains unverified. Complete oicq-like capability parity remains unfinished.
- See [SDK acceptance criteria](docs/sdk-acceptance.md) for the full project scope. Login success is not the SDK completion criterion.
- This repository has not been published to npm. `qq-native-client` is the current local package name.

See [research](RESEARCH.md), [registration bridge](native/README.md), and [login contract](docs/login-contract.md).

Group notices use `publishGroupNotice(groupId, text, { imagePath?, pinned?, confirmRequired? })` and `deleteGroupNotice(groupId, noticeId)`. CLI commands are `group-notice-publish` and `group-notice-delete`. Images require a local file; account tickets stay inside the worker. Publication checks the native result, while a void deletion return means dispatch only. `listGroupNotices(groupId)` (`group-notices` CLI) uses a native ticket plus Node HTTP and returns `{notices,raw}`. It uses the fixed upstream list request and does not guarantee complete pagination. Native bulletin-list callbacks remain unresolved; this HTTP implementation is explicitly a separate path. All notice operations have contract tests but no real account acceptance yet.

`setNickname(name)` (`nickname --name TEXT` CLI) changes the current account nickname. It first reads the current profile and preserves its signature text, sex and birthday in the native update payload. Missing preservation fields reject the operation; query failure invalidates further self-profile queries until Session recreation. Close/disconnect cancels pending lookup. This has contract tests only; no real profile was changed. Other self-profile mutations are not exposed yet.

Multi-version preparation: [architecture and mirror plan](docs/multi-version-and-mirror.md), [macOS samples](docs/version-research-macos.md), and [Windows/Linux samples](docs/version-research-platforms.md). These reports distinguish static inspection from actual runtime support; the future catalog/driver schema is a design, not a replacement for the current v1 API.

## Client APIs and CLI

Call read/send APIs after `await client.login(...)`. `client.state` reports idle, connecting, online, disconnected, closing, closed or failed. `client.account` is available while online. A native worker crash rejects outstanding requests and emits `terminated`; an intentional close does not report a crash.

```ts
const friends = await client.listFriends();
const groups = await client.listGroups();
client.on('message.private', message => { /* incoming private message */ });
client.on('message.group', message => { /* incoming group message */ });
// These methods send only when explicitly called by your application:
// await client.sendPrivateMessage(userId, 'hello');
// await client.sendGroupMessage(groupId, [{ type: 'text', text: 'hello' }]);
```

The npm package exposes the `qq-native-client` executable. `--help` lists configuration, login, contacts, groups, members, history, watch and explicit send commands. Configuration creation does not overwrite existing files. CLI read commands restore prior authorization; QR login is explicit. `watch` prints incoming message JSON and keeps the client running until a termination signal.

`scripts/verify-sdk-readonly.ts` exercises an already authorized account without sending or changing groups. It saves capability flags and counts, never contact identifiers or message bodies. A successful observation window without messages is not evidence that reception works.

## Signing investigation priority

Further account acceptance is currently suspended while the native security signing environment is investigated. Functional login and message acknowledgements do not establish signing integrity or long-term account safety. See [signing integrity](docs/signing-integrity.md) and [community evidence](docs/signing-community-evidence.md). The SDK does not fabricate security signatures or replace detector results.

Group applications and invitations are available through `listGroupRequests({ doubt?, limit?, before? })`, which returns `{ requests, next }`, and the `request.group` event. Types distinguish invitation (1), invitation requiring administrator approval (5), and join application (7). `handleGroupRequest(request, accept, reason?)` is explicit; its completion means native dispatch, not confirmed approval. CLI equivalents are `group-requests` and `group-request`. A failed list query invalidates that Session's query channel to avoid assigning a delayed result to a later page; reconnect explicitly before querying again. These operations have local contract tests; real-account approval has not been tested.

`rememberPassword?: boolean` explicitly applies the native password-retention setting before connecting; omission preserves the native default. It does not guarantee QR account restoration. Each worker owns a data-directory lock, so separate clients require separate data directories. `nativeCallbackAudit` contains bounded callback names, argument types and counts from initialization, without argument payloads.

Local MP4 video sending uses `{ type: 'video', file: '/absolute/video.mp4' }` and `mediaTools: { ffmpeg: '/absolute/ffmpeg', ffprobe: '/absolute/ffprobe' }`. Tools must exist; dimensions, duration and PNG thumbnail come from the actual file, with no fabricated fallback. Metadata preparation has local real-tool verification, but native video delivery is not verified. Thumbnail extraction chooses a time inside the measured clip; a real 0.4-second local clip passed preparation. WAV and existing Tencent SILK now use the built-in WASM codec; real QQ voice delivery remains unverified.

`getForwardMessages(peer, rootMessageId, parentMessageId)` reads an existing merged-forward message using exact native IDs. `forwardMessages(source, destination, messageIds)` submits existing messages for native forwarding. Neither invents IDs or a recipient receipt; synthetic merged-forward composition is not implemented. CLI equivalents are forward-history and forward. Both have local contract tests and require native-account acceptance later.

Local voice input uses `{ type: 'record', file: '/absolute/audio-file' }`. By default the built-in silk-wasm 3.7.1 codec accepts supported PCM16 WAV and Tencent SILK, validates frame boundaries, decodes to verify actual duration, and rejects files over 32 MiB or audio over 300 seconds. An optional `recordCodecPath: '/absolute/codec-module.mjs'` overrides it. The explicitly supplied module must export `getDuration(filePath): Promise<number>` in seconds; non-SILK inputs also require `convertToNTSilkTct(inputPath, outputPath): Promise<void>`. Named exports or a default codec object are accepted. The worker loads this module as executable consumer-supplied code; no codec is downloaded automatically. Outgoing SILK headers and measured duration are validated before native staging. WAV/PCM cannot be relabeled as SILK. Real local WAV→SILK→PCM conversion and message preparation are verified; QQ voice upload and peer receipt remain unverified.

Default native selection: `createClient({dataDir:'/account'})` resolves the latest numeric client version matching `process.platform` and `process.arch` through the GitHub catalog. `catalogUrl` can override the HTTPS catalog. Explicit `manifestUrl` still requires `manifestSha256`. Local `wrapperPath` may omit `version` when its adjacent schema-1 manifest matches the current device and wrapper. The default GitHub mirror is published at https://github.com/lc-cn/qq-native-mirror; the accelerated default catalog path has passed installed-consumer initialization with cached contents; cold direct GitHub download terminated with TimeoutError; cold accelerated default download passed in 304 seconds. The installer uses four bounded downloads and downloads identical SHA-256 contents once, preserving every path with hardlinks. Catalog trust does not establish vendor signature authenticity.

For GitHub download acceleration, supply trusted proxy prefixes in order:

```ts
const client = await createClient({
  dataDir: './account',
  downloadMirrors: ['https://gh-proxy.com/'],
});
```

Each prefix is prepended to the original native file URL. A failed download or SHA-256 mismatch tries the next prefix, then the original URL. Catalog and manifest requests still use their original addresses. Completed content is cached by SHA-256 and reused after interrupted installations; partial individual files are not resumed. Prefixes must use HTTPS, end in `/`, and contain no credentials, query or fragment. At most eight are accepted. No third-party accelerator is enabled by default.

The installed CLI can generate a default-catalog configuration without a local QQ installation or manually entered version metadata:

```sh
qq-native-client init --config ./qq.json --data-dir ./account --download-mirror https://gh-proxy.com/
qq-native-client config --config ./qq.json
qq-native-client login --config ./qq.json --method qr --qr-file ./qrcode.png
```

`init` and `config` are local-only and do not load native code or log in. `login` downloads the selected native package and starts an explicit QR login. Omit `--download-mirror` for direct downloads; `--catalog` selects a custom HTTPS catalog. A local `--wrapper` may omit version metadata when an adjacent trusted manifest supplies it. When specifying version fields manually, supply all three: `--client-version`, `--app-id`, and `--qua`. Existing config files are never overwritten by `init`.

Mirror manifests optionally support gzip transport: each compressed entry adds `encoding: "gzip"` and `downloadSha256` while keeping `sha256` bound to the original runtime bytes. The installer checks both hashes and limits decompression size. Existing raw-file mirrors continue to work. See [bundle reduction evidence](docs/native-size-reduction.md).

A separate compressed native catalog is available for explicit opt-in with the current SDK:

```ts
const client = await createClient({
  dataDir: './account',
  catalogUrl: 'https://raw.githubusercontent.com/lc-cn/qq-native-mirror/main/catalog-gzip-v1.json',
  downloadMirrors: ['https://gh-proxy.com/'],
});
```

It covers macOS arm64 (all resource paths retained) and Linux x64/arm64. Default selection still uses the full original catalog. Prior versions of this SDK without gzip manifest support cannot consume this optional catalog. See [candidate evidence](docs/native-size-reduction.md) for operation limitations.

### 分平台 npm 原生包

主包使用固定版本的 optionalDependencies：`qq-native-client-darwin-arm64`、`qq-native-client-linux-x64`、`qq-native-client-linux-arm64`。npm 根据 os/cpu（Linux 还要求 glibc）安装对应辅包；无需 postinstall 脚本。默认 createClient 优先加载辅包，每个原生文件通过 SHA-256 校验。显式 wrapperPath、manifestUrl 或 catalogUrl 优先；指定不同内核版本或省略 optional dependencies 时，仍使用镜像目录下载。

内核版本写在辅包 manifest 中，npm 包版本独立管理。更新主包时固定辅包版本，避免同一主包在不同时间安装到不同内核。完整目标为 Windows/Linux/macOS × x64/arm64，共六个辅包。GitHub Actions 在各架构 runner 上构建注册适配层、校验并打包厂商内核，再进行无账号消费者初始化；缺少素材或验证失败的平台不发布占位包。当前 Windows 适配和六平台 CI 验收仍在进行。

维护者运行 `node scripts/build-platform-packages.ts` 生成辅包到 `.local/npm-platform-packages/`，先发布三个辅包，再发布主包。生成目录仅复制 manifest 中经过校验的文件，不包含账号目录。
