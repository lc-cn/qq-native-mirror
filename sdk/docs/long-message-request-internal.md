# Internal text-only long-message request encoder

`src/long-message-request.ts` is an independently authored byte encoder. It is not exported by the package index or connected to a worker, native Session, upload or public send API. The verified field sources and licensing distinction are recorded in `merged-forward-contract.md`.

`buildTextForwardPayload({selfUid,target,nodes})` returns uncompressed LongMsgResult bytes. `buildTextForwardRequest(input)` returns `{command,data}`, where command is `trpc.group.long_msg_interface.MsgService.SsoSendLongMsg` and data is the request protobuf with a level-6 gzip action payload. Both functions validate the complete input before encoding.

Target is `{type:'private'}` or `{type:'group',groupUin}`. Each node contains exactly `senderUin`, `displayName`, `timeSeconds`, `text`, and `sequence`. Values are explicit; there is no default account, clock or random sequence. Avatar URLs are encoded strings only and are never fetched.

Protocol facts are field numbers/types, `MultiMsg`, request settings 4/1/7/0, private/group type differences, text nesting, and the observed sender/content header projection. The owned implementation explicitly includes supplied zero-valued header fields and empty fromUid, and omits inapplicable private/group headers. This deterministic byte policy has not been compared with authenticated native acceptance.

SDK policy is 1–100 dense nodes, exact field sets, plain input records, positive UINT32 author/group/time, UINT32 sequence including zero, nonempty valid UTF-8 strings without unpaired surrogates, aggregate text and each encoded output at most 1 MiB. Media and nested nodes are unsupported. These bounds are local policy, not claimed server limits.

Tests use an independent BigInt wire reader, manually constructed elementary hex fragments, and decompression to inspect complete private/group requests, identity fields, UTF-8, settings, node order and deterministic gzip timestamps. Malformed input, oversized aggregate/output and unsupported fields reject. No test calls network, native services or an account. Provider upload, resource identity and eventual card delivery remain unobserved.
