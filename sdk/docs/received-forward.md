# Received merged records (unpublished source)

Received messages now expose a receive-only `{ type: 'forward', format, resourceId, ... }` element for recognized ARK and native MULTIFORWARD cards. This is used by live `message` events, `getMessage`, `getHistory` and `getForwardMessages`. It is absent from npm `0.0.1`; actual account reception remains unverified.

ARK recognition requires element type 10, `app: 'com.tencent.multimsg'`, `view: 'contact'`, and a nonempty valid `meta.detail.resid`. Native recognition requires element type 16 and string `multiForwardMsgElement.resId/fileName/xmlContent`. XML is opaque and is never parsed, rendered or fetched.

`resourceId` is the uploaded resource reference. Optional `cardId` comes from ARK `detail.uniseq`/`extra.filename`, or native `fileName`; reading permits non-UUID IDs. Empty optional IDs are omitted, and conflicting nonempty ARK IDs leave the entire element unknown. Optional ARK `title`, `summary`, `prompt`, `count` and `previews` are projections of reported card metadata. Previews are not the complete records and count is not an independently verified record count.

Resource/card IDs are bounded at 4096 UTF-8 bytes; JSON and opaque XML at 1 MiB; previews at 1000 entries. Invalid UTF-8, fields, JSON, optional metadata or unsupported app/view combinations preserve `{type:'unknown',nativeType,data}`. No fallback identities or metadata are invented. `message.raw` and unknown element evidence retain their original references. Known fields are captured before asynchronous identity resolution, including callbacks queued behind earlier lookups.

The new element is excluded from `SendableMessageElement`. Passing a received reference to ordinary `sendPrivateMessage`/`sendGroupMessage` is unsupported. Explicit composition uses `sendMergedForward`; forwarding existing message IDs uses `forwardMessages`.

## Reading by native card message ID

```ts
// `cardMessage` is a received SDK Message from an already-online client.
if (cardMessage.elements.some(element => element.type === 'forward')) {
  const records = await client.getForwardMessages(cardMessage.peer, cardMessage.messageId);
  // Read nested contents with the outermost conversation/root retained explicitly:
  // await client.getForwardMessages(cardMessage.peer, cardMessage.messageId, nestedMessage.messageId);
}
```

The public API defaults `parentMessageId` to `rootMessageId` for the first level. Explicit third arguments retain the existing nested-query contract. Numeric IDs remain strings, including leading zeros and values beyond JavaScript's safe integer range. Invalid peer/root/parent fields reject before IPC. The worker uses `MsgService.getMultiMsg(peer, rootMessageId, parentMessageId)`. Resource IDs are never substituted for these native message IDs.

```sh
qq-native-client forward-history --config ./qq.json --kind private \
  --target RECIPIENT_QQ_NUMBER --root-message-id CARD_MESSAGE_ID
# Nested reads additionally specify --parent-message-id NESTED_MESSAGE_ID.
```

Closing the Session rejects stalled resolver, native read/forward and decode waits promptly. Abort listeners are removed on every settlement and late results/rejections are observed without replay. This ends the SDK caller; it does not prove cancellation of an already-dispatched native operation. Reading happens only when the caller explicitly invokes the API; normalizing a card does not fetch its contents or media.

## Fixed field facts

All facts below are bound to NapCatQQ commit `26d7533e0f5800fdff865ab2f2ad7692917e1076`; implementation and fixtures are independently authored.

- [Native message definitions](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/types/msg.ts): ARK 10, MULTIFORWARD 16 and native string fields. Git blob `8b1278e679f520a5e8a9916adc9fb473dca70c7d`, SHA256 `92b05a40339733a22ca0662232041e4c2d0b323d88b47d11b466daf82a2ccf9c`.
- [Card fields](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/helper/forward-msg-builder.ts): known multimsg detail and extra fields. SHA256 `2fbae2fb829493b95d0c6697b09394d0781ce8cf075d3117c2f6507cc24c7a25`.
- [Native first-level/nested context](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-onebot/api/msg.ts#L1051-L1064): first level uses the card message ID for root and parent; nesting retains the outermost peer/root. SHA256 `18f2ec2c7d40d028ea7d74cdce62e5f8c0fd0acf074874ea45a6b59c3a7fb9a8`.

Resource-based SSO download is a separate, newer unpublished capability through `getForwardResource(resourceId)`. Its request/response and media conversion research is recorded in [resource download contract](forward-resource-contract.md). The metadata decoder itself does not fetch records or media. The new resource reader is separate and still lacks actual account acceptance; it does not claim complete media/nested-resource composition.

Local build, compiled consumer fixtures, type checking and 501/501 SDK regressions passed. [Local evidence](evidence/received-forward-local.json). [Six-platform installed-consumer CI](https://github.com/lc-cn/qq-native-mirror/actions/runs/37989789953) at `5614d03189d9af36a58d280bf35f4173eb1f1a28` passed this compiled receive-only contract and native-ID/cancellation contract on Linux, Windows and macOS x64/arm64. Separate actual-addon probes restored all original native paths, reused warm cache, initialized/closed the addon and decoded three fixed clips per device without an account. Independent artifact audit compared all 2,434 original path byte sequences, 738 objects and 78 compiled modules: 76 exact byte matches and two Windows CLI help-template CRLF-normalized matches, with original digests retained. [Bound CI evidence](evidence/received-forward-six-ci-37989789953.json). This does not establish actual card reception, native forwarded-content queries, resource download or signing authenticity.
