# Internal merged-forward ARK formatter

`buildMergedForwardCard({resourceId,cardId,nodes,options?})` formats JSON and returns `{elementType:10,elementId:'',arkElement:{bytesData}}`. It is independently authored, is now used by the public/worker pipeline, and the formatter itself never uploads, sends, reads an account or generates a UUID.

Fixed protocol facts come from NapCatQQ commit `26d7533e0f5800fdff865ab2f2ad7692917e1076`, `packages/napcat-core/helper/forward-msg-builder.ts:76-102` (SHA256 `2fbae2fb829493b95d0c6697b09394d0781ce8cf075d3117c2f6507cc24c7a25`). These are the multimsg app/version/view, config flags, extra filename/count, detail resource/card IDs/news/source/summary and desc/prompt fields. No upstream construction algorithm, sender deduplication, random ID generation or fallback text was copied.

ARK value 10 is independently bound to cached `qq-face-enums-pinned.ts:56`, remote `packages/napcat-core/types/msg.ts` at that same commit. Its local Git blob SHA1 `8b1278e679f520a5e8a9916adc9fb473dca70c7d` exactly matches the saved fixed commit tree entry; SHA256 is `92b05a40339733a22ca0662232041e4c2d0b323d88b47d11b466daf82a2ccf9c`.

SDK policies are 1–100 dense nodes, strict unknown-field rejection, nonempty valid UTF-8 without unpaired surrogates, a canonical UUID with version 1–8/standard variant, a 4096 UTF-8 byte resource ID limit, and a 1 MiB full JSON limit. Full node name/text input is bounded at 1 MiB aggregate. Title defaults to 聊天记录, summary to 查看N条消息 and prompt to [聊天记录]. These are owned presentation choices, not server requirements.

Every preview is `displayName:text`, in input order, with at most 160 Unicode codepoints. A clipped preview keeps 159 codepoints plus an ellipsis. This intentionally clips only card presentation and never mutates the node text supplied to the separate request encoder. Custom title/summary/prompt are explicit; resource ID and card ID are preserved exactly across their fields.

Tests inspect the whole JSON envelope, strict IDs and malformed inputs, codepoint-safe preview clipping, unchanged full input, deterministic output and UTF-8/escaped-JSON size limits. No native acceptance or card delivery was observed.
