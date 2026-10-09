# Resource-based merged-record download (research only)

The SDK currently reads existing native card message IDs through `getForwardMessages(peer, rootMessageId, parentMessageId?)`. Recognized received cards expose a `resourceId`, and `getForwardResource(resourceId)` implements a separate SSO read and observed record model. Native/server acceptance remains pending; a resource ID cannot replace the native root/parent message IDs.

## Fixed request and response facts

Sources are pinned to NapCatQQ commit `26d7533e0f5800fdff865ab2f2ad7692917e1076`. The inspected code was used to establish wire facts; it is not incorporated into this SDK.

The command is `trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg`. Its protobuf request contains field 1 (receive info) and field 15 (settings). Receive info contains field 1 (UID message, with string UID at field 2), field 2 (string resource ID), and field 3 (boolean acquire = true). Settings fields 1–4 are respectively 2, 0, 0, 0. The transformer constructs the direct protobuf body; it does not add an OIDB wrapper.

The response has result at field 1 and settings at field 15. Result contains string resource ID at field 3 and gzip payload bytes at field 4. Decompressed `LongMsgResult` has repeated actions at field 2: each action has a command string at field 1 and action data at field 2, which in turn contains repeated `PushMsgBody` records at field 1. The inspected implementation selects the `MultiMsg` action. These source definitions do not establish an explicit error-code field or require equality between the requested and returned resource IDs. A future SDK decoder must define and test its own checked response policy rather than silently assuming server behavior.

| Primary source | Git blob | SHA256 |
| --- | --- | --- |
| [Download transformer](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/transformer/message/DownloadForwardMsg.ts) | `46c4ceb17c4993f39a4c413d9e7663415efa9ad7` | `a5a57ece37ff37652fa85b6129bea77a8213b8c9380ee86480efae1aad680cd2` |
| [Protocol definitions](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/transformer/proto/message/action.ts) | `5622b39830200e47c411b7b08c6a85a4d7226521` | `58bd66dc5cdcaf70bfb5a9a572b68dd515b801354cd06d0b67d4413cad00abcd` |
| [Download and media conversion](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/context/operationContext.ts) | `6b8fea8881b31e4845d980cf703fb07bf71af047` | `a4e672f7a93bffa06aa80dd770c5bdef853b8d606f0ed03c3989db3be54e76ee` |
| [Record conversion](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/message/converter.ts) | `b7ed2a1d78e6018d4ea1e1779d043e481425db50` | `cc0364ef974531b0ef1c65966b65d01679536e67c0da4f5763cd9cfa8c4787b3` |
| [OneBot resource/native fallback](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-onebot/action/go-cqhttp/GetForwardMsg.ts) | `4141d4d24473bb668347ecde7065173ce7f2e868` | `977915cdabc32024e9efb36b0335216bf1ea3dcb597aa177b4b0d247d1016755` |

## SDK record contract and remaining media work

The inspected download path obtains additional image/video URLs through separate SSO commands; the resulting URL contains an authorization rKey. A successful long-message request alone therefore does not establish complete media support. The converter handles a limited set of elements and filters unsupported elements. It also supplies a fixed synthetic native message ID while constructing its compatibility result. The OneBot fallback constructs synthetic conversation context. These compatibility values must not become SDK query/recall identities.

The resource reader returns a distinct `ForwardRecord` model containing only observed author, timestamp and elements, with unknown protobuf evidence preserved. It does not fabricate a `Message.messageId`, peer or sequence. Before dispatch it validates and captures the input. It bounds compressed/decompressed bytes, record and element counts; defines checked response and unknown-field behavior; and rejects on Session cancellation without replay. See [decoder and public result policy](forward-resource-decoding.md). Media resolution and nested-resource fetching need separate bounded contracts. Actual account acceptance remains necessary for response shape and server compatibility.

This document closes source research for the request/response boundary. The independently implemented SDK/worker/CLI read path has offline contracts, but this source research does not establish a real resource download, account acceptance or signing authenticity.
