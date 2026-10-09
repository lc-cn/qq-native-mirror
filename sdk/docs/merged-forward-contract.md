# Merged-forward construction contract

The SDK currently reads merged-forward contents with `getForwardMessages` and forwards existing messages individually with `forwardMessages`. The unpublished source now implements `sendMergedForward` for explicit text author/time nodes through an owned packet encoder, response adapter and ARK formatter. This has contract tests only; actual upload, card delivery, media and nested-node composition remain unverified. See [public contract](merged-forward.md).

The fixed primary source is NapCatQQ commit `26d7533e0f5800fdff865ab2f2ad7692917e1076`. Four exact downloaded files were independently matched against the commit's Git tree and Git blob SHA-1, with SHA-256 and raw line counts recorded in `.local/research/forward-build-primary-verification.json`. Raw bytes take precedence over a web renderer's differing line offsets.

| Path | Established implementation | Remaining requirement |
| --- | --- | --- |
| Same-source existing IDs merged into one card | [`multiForwardMsg`](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/msg.ts#L286-L324) submits ID/display-name records, source peer, destination peer, empty comments and an empty Map to `multiForwardMsgWithComment` | A trustworthy completion/result association; the native return is declared unknown |
| Newly supplied self-authored content | [OneBot native implementation](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-onebot/action/msg/SendMsg.ts#L368-L477) sends content to the self peer to obtain real IDs, then merges them; some element types become separate nodes | Explicit temporary self-message semantics and authorization, upload/error/partial-state handling, completion association |
| Arbitrary author/time synthetic nodes | [Packet upload implementation](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-onebot/action/msg/SendMsg.ts#L208) uploads packet nodes and uses the [forward builder](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/helper/forward-msg-builder.ts#L107-L121) to compose the resulting card | The fixed Packet encoder and direct Session send chain are now established below; response parsing and public/worker integration have owned offline tests; hook-free real upload remains unverified |

The inspected native merged-send listener matches the destination UID and current account sender UID, then finds an ARK with the merged-message application name. It lacks a per-request token, `guildId` or successful send-state comparison. Copying that predicate would allow another same-peer send to be mistaken for this operation's completion. The SDK will not invent a new message ID from that association or silently use an unknown return value as success.

The native service also declares `buildMultiForwardMsg({srcMsgIds,srcContact})` returning `GeneralCallResult & {rspInfo:{elements:unknown}}`. None of these inspected fixed implementations invokes it. Its declaration does not establish whether `elements` is an array, what its element shape is, whether construction uploads content, or how errors and cancellation behave. A possible strongly associated implementation would validate the actual build response and send its proven elements through the existing unique-ID/guildId send path. It requires actual response evidence before claiming a complete supported contract.

No temporary self message, native build, Packet upload, account restore or real forward was executed in this investigation or the subsequent offline implementation. A future native build observation must have a separately reviewed scope because construction may involve an upload; the unknown method cannot be assumed read-only. Arbitrary-author composition, nested resources and real merged-send acceptance remain part of the full SDK target.

## Fixed upload and Session evidence

Further bounded GitHub Contents API reads verified each exact blob against both the API SHA and the previously saved commit tree. Sources were inspected only, never imported or executed. This updates the earlier incomplete Packet source investigation; it does not establish successful native upload.

The exact chain is `PacketOperationContext.UploadForwardMsgV2` → `PacketClientContext.sendOidbPacket` → `NativePacketClient.sendPacket` → `NapCoreContext.sendSsoCmdReqByContend` → current `session.getMsgService().sendSsoCmdReqByContend(cmd, Buffer)`.

| Fixed primary source | Raw lines | SHA-256 | Evidence |
| --- | --- | --- | --- |
| [UploadForwardMsgV2.ts](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/transformer/message/UploadForwardMsgV2.ts#L12) | 12-51 | `690a9df6477d5eac5ad04f967e7028027e4b2906598cb49c907c7ca37111b4c0` | Gzip LongMsgResult and SsoSendLongMsg request construction |
| [operationContext.ts](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/context/operationContext.ts#L235) | 235-243 | `a4e672f7a93bffa06aa80dd770c5bdef853b8d606f0ed03c3989db3be54e76ee` | Preprocess resources, await packet response, parse and return res.result.resId |
| [napi2nativeLoader.ts](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/handler/napi2nativeLoader.ts#L23) | 23-83 | `097636eb2e89d4f84dc284bccb26975c03f4452fad2a3892d84fb25622bbb426` | Platform allowlist, local dlopen and initHook |
| [action.ts](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/transformer/proto/message/action.ts#L49) | 49-68 | `58bd66dc5cdcaf70bfb5a9a572b68dd515b801354cd06d0b67d4413cad00abcd` | Request/response protobuf fields, including resource ID |
| [clientContext.ts](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/context/clientContext.ts#L70) | 70-72 | `5f5a95373f2e544c2a8cb7c630b6575e5e650693dba730d5b91ec7515f70b320` | Return native client raw.data |
| [napCoreContext.ts](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/context/napCoreContext.ts#L41) | 41 | `6ca8504bb898500e3f1450e588bbe11f33a47c7fcd8aeb03247678d10be4dd79` | Direct current native Session MsgService call |
| [nativeClient.ts](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/client/nativeClient.ts#L42) | 42-109 | `65e82bca1e171b32f479ea566f9219772daab9eeabb42ab0c8f3517a7047cf0f` | Local hook initialization; awaited Session response cast to rspbuffer; five-second timeout race |

The native Promise is the response association used by this source; returned `seq:0` is a wrapper placeholder. The inspected implementation assumes `rspbuffer` without runtime validation, races an uncleared timer, and offers no cancellation. Upload response decoding exposes `result.resId`; it does not acknowledge subsequent card delivery. Authentication is delegated to the already authenticated Session.

The framework initializes an additional local hook addon before exposing packet availability. It passes `process.pid`, but `NativePacketClient.init` ignores that parameter and invokes local `initHook`. These files show no external process attach or mandatory separately installed QQ/Electron host. Whether this hook is necessary for the direct Session method remains unknown. The fixed loader omits Windows ARM64; the saved tree contains four addon devices and no Windows ARM64 or macOS x64 addon. That is an artifact/allowlist gap, not proof an architecture cannot be built.

## Proposed internal text-only offline module

An internal encoder/decoder can be designed separately from any public send API. The current SDK has no protobuf dependency (only `silk-wasm` at runtime). A narrowly scoped owned protobuf wire reader/writer using Node Buffer/BigInt and `node:zlib` would avoid importing the entire Packet framework. It should support only reviewed varint and length-delimited fields, bounded lengths, truncation/overflow checks, strict UTF-8, deterministic injected sequence/time, and bounded gzip output. It must not implement arbitrary packet sending.

Proposed inputs are self UID, private/group target, and dense text-only nodes containing an explicit sender UIN, display name, timestamp and text. Output is the encoded `SsoSendLongMsg` request bytes; a separate response decoder accepts a Buffer and returns a nonempty resource ID or rejects. Unsupported elements, media, nested nodes and unknown identity fields must reject before encoding. The inspected `ResponseHead.fromUin` is UINT32, so inputs must be validated against that exact range rather than silently narrowing long decimal IDs. Avatar strings in the observed builder are encoded metadata, not permission to perform HTTP requests.

The remaining text-only field definitions are now verified from the same fixed commit: `ResponseForward`, `ForwardHead`, `RichText`, `Elem.text` and `Text.str`, plus the text builder projection. This closes the local schema-fact gap; it does not prove provider acceptance. Offline byte fixtures should establish deterministic encoding and malformed response rejection; they cannot establish server acceptance.

The fixed upstream `LICENSE` is a custom Limited Redistribution License, not a permissive MIT/Apache license. Its verified SHA-256 is `2bbc0dba0c62fcde4adfe38ebadad0b7d4e23b06b88d9551904bbe07769dc46f`. It restricts use/modification/public redistribution and commercial use. Do not vendor upstream implementation or claim license compatibility automatically; an independently authored minimal codec and provenance documentation require a deliberate review of reuse conditions. No public arbitrary-author API or success claim follows from this design.

## Additional text schema facts

All six newly fetched blobs match GitHub API SHA, saved Git tree SHA and independently computed blob SHA. No upstream code was executed or copied into the SDK.

| Source | Raw lines | SHA-256 | Fact |
| --- | --- | --- | --- |
| [routing.ts](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/transformer/proto/message/routing.ts#L3) | 3-28 | `4a03d31a53fda48b5bb0f5155f2371f14e9b5bd4417c806c678183f4f5889d2b` | ForwardHead uint32 fields1/2/3, strings5/6; ResponseForward friendName string6; ResponseGrp uint32 groupUin1, string memberName4 |
| [component.ts](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/transformer/proto/message/component.ts#L67) | 67-72 | `ea339ac73bb2d09698a4c736dea19dde60564fd9351589cbbb506ae3497723f8` | RichText repeated Elem field2 |
| [element.ts](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/transformer/proto/message/element.ts#L3) | 3-30 | `22fb788d73dbbb7a850a86d147add05d7952403942ba03863d245433199ad1c7` | Elem.text message1; Text.str UTF8 string1 |
| [element.ts](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/message/element.ts#L71) | 71-84 | `2b833444badeabd3f91162b16a7f4bc9681aa62a2abff7d950fcf646aea8f18c` | Plain text builder projects input content into one text.str element |

Independent hand-derived elementary fixtures include Text `A` → `0a0141`, Elem.text → `0a030a0141`, RichText one Elem → `12050a030a0141`, and response result resource ID `r` → `12031a0172`. These test field nesting and UTF-8 lengths, not live upload. Full deterministic fixtures and malformed-input rejection belong to the proposed owned offline codec.
