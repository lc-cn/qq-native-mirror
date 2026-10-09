# Resource record decoding contract (unpublished source)

The unpublished `getForwardResource(resourceId)` API, worker and `forward-resource --config FILE --resource-id ID` CLI fetch one resource through the authenticated Session SSO service. Inputs are checked before native dispatch or CLI account setup; no automatic retry, media URL resolution or nested-resource fetch occurs. This document records independently checked protocol facts and SDK decoding policy. It does not establish a real account response, signing authenticity or complete media support. Fixed upstream implementation is not copied or incorporated.

## Fixed primary sources

All sources are pinned to NapCatQQ `26d7533e0f5800fdff865ab2f2ad7692917e1076`. Exact downloaded bytes were rechecked against API/tree Git blob SHA1 and SHA256 in `.local/research/forward-upload-pinned/source-proof.json`.

| File under packages/napcat-core/packet/transformer/proto/message/ | Git blob | SHA256 |
| --- | --- | --- |
| action.ts | `5622b39830200e47c411b7b08c6a85a4d7226521` | `58bd66dc5cdcaf70bfb5a9a572b68dd515b801354cd06d0b67d4413cad00abcd` |
| message.ts | `fdcb65760c37073eee6cb313431311a80243826a` | `4b2d1ce7a4f0ef771f5496b9374c05a32dc82406bd1b5762b1af8560e475046c` |
| routing.ts | `f2d0525669e1edb12c4db909ec54d5e5f5a14fa1` | `4a03d31a53fda48b5bb0f5155f2371f14e9b5bd4417c806c678183f4f5889d2b` |
| component.ts | `7b1956dfeda65f9875a6386a5f21de5464185421` | `ea339ac73bb2d09698a4c736dea19dde60564fd9351589cbbb506ae3497723f8` |
| element.ts | `72d437eb9a4bc9f3458d07b54a804548c9cbd36d` | `22fb788d73dbbb7a850a86d147add05d7952403942ba03863d245433199ad1c7` |

The [resource transport document](forward-resource-contract.md) records the request/response envelope. Below concerns the gzip payload and record projection.

## Observed fields

`action.ts:4-14` declares repeated actions at LongMsgResult field 2. Each action has command string field 1 and action-data field 2; action data contains repeated PushMsgBody at field 1. The inspected context selects `MultiMsg`; unrelated actions do not establish nested-resource support.

`message.ts:115-129` declares PushMsgBody fields 1 responseHead, 2 contentHead, 3 body. ResponseHead field 1 is UINT32 fromUin and optional field 2 is string fromUid. Field 7 is optional ResponseForward; field 8 is optional ResponseGrp. These are payload-reported author/context values, not authenticated sender evidence. Missing UID or author fields must not be synthesized from the current account or destination.

`routing.ts:20-29` declares ResponseForward optional field 6 string friendName. ResponseGrp has field 1 UINT32 groupUin, field 4 string memberName, field 5 UINT32 unknown5 and field 7 string groupName. The inspected conversion chooses group memberName when group context exists, otherwise forwarded friendName. Do not confuse groupName with the author nickname or derive a native query peer from this group context. Naming fallback, if supplied by the SDK, must be explicitly identified as policy; omitting absent metadata preserves the evidence more accurately.

`message.ts:13-32` declares ContentHead optional UINT32 sequence at field 5 and timeStamp at field 6. The independently encoded text-node contract supplies timestamp seconds. A received observed timestamp may be projected without inventing a current timestamp. Sequence is packet content metadata, not proof of a native query/recall message identity. The source also assigns both autoReply and ntMsgSeq to field 10; this alias is not needed for the narrow record projection and must not be guessed into separate values. MessageBody field 1 is optional RichText, field 2 optional msgContent bytes and field 3 optional msgEncryptContent bytes.

`component.ts:67-72` declares RichText optional attr field 1, repeated Elem field 2, optional notOnlineFile field 3 and optional ptt field 4. Therefore a record with no Elem may still contain file/audio content. A reader must retain these fields in raw evidence, rather than call such a record empty plain text or silently claim full file/audio decoding.

`element.ts:3-37` declares Elem field 1 Text and field 2 Face. Text has optional string str at field 1 and lint at field 2; bytes attr6Buf/attr7Buf at fields 3/4, buf at field 11 and pbReserve at field 12. Face has optional INT32 index at field 1 and old/buf bytes at fields 2/11. Simple text/face projections are possible without fetching additional data; unknown auxiliary or mixed content should remain opaque with its complete bytes retained. A face index alone does not establish an animation, sticker pack or dice result.

Mention handling must not rely on the visible text prefix. The independently checked `packet/message/element.ts:120-130` writes mention metadata into Text.pbReserve using MentionExtra; `transformer/proto/message/element.ts:334-339` declares MentionExtra type INT32 field 3, UIN UINT32 field 4, field5 INT32 field 5 and UID string field 9. The source's legacy incoming mention parser also checks attr6Buf (`packet/message/element.ts:134-148`). Consequently nonempty mention/attribute buffers must not be projected as ordinary text merely because Text.str exists. The narrow reader can retain that entire Elem as unknown, without UID lookup or inventing an at target. The packet-element source Git blob is `96c8ee4fefde09df30075487e9ac76fb2484dbbb`, SHA256 `2b833444badeabd3f91162b16a7f4bc9681aa62a2abff7d950fcf646aea8f18c`.

## SDK policy and evidence preservation

The public result is `ForwardResource {resourceId, records, raw}`. Record projection must contain only observed author, timestamp and elements; it must not create `Message.messageId`, conversation peer or sequence. Retain the full decompressed LongMsgResult payload and each complete record wire value, and retain the entire original Elem byte value for every unknown element. Unknown field order, auxiliary bytes, media, mixed elements and RichText-level fields remain recoverable from raw bytes. Do not normalize unknown elements to just a guessed numeric type or discard them. Taking owned Buffer snapshots prevents later mutation of transport buffers from changing captured evidence.

Limits are SDK policy, not proven server limits: response 8 MiB, decompressed payload 16 MiB, 1000 records, 1000 elements per record and 10000 elements overall. Resource IDs remain bounded strings. Strict requested/returned resource-ID equality is also SDK policy; the inspected source does not prove the server always returns equality. The decoder must test malformed UTF-8, varints, wire types of projected and structural fields, duplicates of recognized singular fields, and field/byte budgets. Unprojected nested bytes remain opaque; this is not a full-schema semantic validator. Protobuf groups are unsupported and rejected, alongside the byte/count limits.

Normalization must not query UID services, resolve image/video authorization URLs, download media or recursively fetch nested resources. Those require separately verified, bounded contracts and explicit requests. Closing the Session terminates the caller without replay; it does not prove cancellation of the native server operation.

## Deterministic gzip behavior

A local Node `v24.19.0` experiment used only generated gzip members containing ASCII A and B. `gunzipSync` decoded concatenated members as AB, with `info: true` reporting both members consumed. A single member plus four trailing zero bytes decoded as A but reported only the member bytes consumed. Nonzero trailing X and an incomplete following gzip header produced `Z_BUF_ERROR`. With maxOutputLength 1, concatenated A/B failed with `ERR_BUFFER_TOO_LARGE`: the output cap covers total decoded output across members.

Thus plain successful gunzip is insufficient to reject trailing padding. Checking consumed input against the full payload can reject the observed unconsumed trailing-zero case, but it still accepts valid concatenated members. This reader accepts exactly one member: it checks the gzip header, DEFLATE input consumption, trailer CRC32 and ISIZE, and rejects multiple members or any trailing bytes. Do not claim `bytesWritten === input.length` proves a single member; a single-member policy needs an independently checked member-boundary implementation. These experiments do not certify all Node/zlib versions or every malformed gzip layout. Gzip and protobuf bounds are both required; no real resource response was used.

Pure fixtures, compiled SDK and fake-service tests verify local contracts only. Actual account resource retrieval and the native resolved rspbuffer shape remain unobserved until a separately authorized acceptance batch.

## Public usage

```ts
// Explicit request on an already-online, authorized client.
const resource = await client.getForwardResource(receivedForwardElement.resourceId);
for (const record of resource.records) {
  console.log(record.sender, record.time, record.elements);
}
// resource.raw is the complete decompressed payload.
// Each record.raw and unknown element.raw is an independently owned Buffer.
```

`ForwardRecord` is distinct from `Message`: resource records have no fabricated native message ID, peer or sequence, and cannot be passed as a native query/recall identity. Group context supplies its observed member name; missing group member names are omitted rather than falling back to a friend name. Caller cancellation ends observation of the dispatched native operation; it does not prove server cancellation.

Local build, type checking, compiled-consumer/actual CLI fixtures and 527/527 SDK regressions passed. [Bound local evidence](evidence/forward-resource-local.json). Six-platform installed evidence for this newer source is pending; the previous received-card CI does not include this resource reader.
