# Internal long-message response adapter

`src/long-message-response.ts` is independently written, internal, and disconnected from the public API and worker. It does not construct requests or establish real upload, account or signing acceptance.

## Fixed primary facts

The inspected NapCatQQ commit is `26d7533e0f5800fdff865ab2f2ad7692917e1076`. Local source bytes were rechecked against the API Git blob SHA1 and recorded SHA256. Only protocol facts were used; upstream implementation and restrictive-license source were not copied.

- [action.ts](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/transformer/proto/message/action.ts#L61): response field 2 is the nested result, whose field 3 is UTF-8 `resId`. Git blob `5622b39830200e47c411b7b08c6a85a4d7226521`.
- [UploadForwardMsg.ts](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/transformer/message/UploadForwardMsg.ts): fixed command `trpc.group.long_msg_interface.MsgService.SsoSendLongMsg`. Git blob `d4ec576acdd64efdc6f2655398de560d68b929e1`.
- [nativeClient.ts](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/client/nativeClient.ts#L71): directly awaits the transport and treats resolved `rspbuffer` as a Buffer. Git blob `dabc4103d06609aa2e79602d0cf236c115563ded`.

The pinned response schema supplies no native result code or request sequence. The adapter returns only `{resId}` and invents neither.

## SDK policies

`parseLongMessageResponse(buffer)` requires an ordinary Buffer, snapshots bytes, and accepts exactly one response result and one nonempty resource ID. It rejects invalid/truncated fields, duplicate known fields, wrong known wire types, field zero, invalid UTF-8, overlong/noncanonical varints, and mismatched/unterminated groups. Unknown structurally valid fields are skipped, including matched protobuf groups. Unknown length-delimited bytes are opaque, not presumed embedded messages.

Limits are SDK policy: 1 MiB request/response, 4096 UTF-8 bytes per resource ID, depth 16, uint64 varint maximum 10 bytes, timeout 1–60000 ms with a 5000 ms default. These are not claimed as upstream server limits.

`createLongMessageResponseTransport(service)` injects the existing `sendSsoCmdReqByContend` method. `send(command, buffer, {signal?, timeoutMs?})` only accepts the fixed command and copies the request before dispatch. A response must be a plain object with an own data property containing an ordinary Buffer; getters, inherited buffers and typed-array substitutes are rejected. Response bytes are copied before parsing. No request encoding, callback/sequence correlation or automatic retries are performed.

`close()` prevents new dispatch and rejects pending operations. Cancellation before dispatch reports `completion: 'not-dispatched'`. Cancellation, close, timeout or native rejection after dispatch reports `completion: 'unknown'`; this does not prove the server rejected the upload. An invalid resolved envelope or protobuf reports `completion: 'response-received'`, which only describes that a native response value was obtained; it does not establish upload or message-send success. Errors distinguish input, lifecycle, native, response-envelope and protobuf stages. Native error text, arbitrary objects, codes and credentials are not copied into errors.

Timers and abort listeners are removed on every settlement. Late responses/rejections are observed and ignored, preventing retry, double settlement and unhandled rejection.

## Evidence boundary

Nine focused tests use independent hex response bytes, malformed wire corpus and fake services. They cover request snapshot, one dispatch, pre-cancel/close, post-dispatch cancellation, timeout, late response/rejection, envelope validation and error-layer separation. No native service was loaded or called, no account was used and no network was accessed. The actual native resolved-object shape and real upload/response compatibility remain unobserved in this SDK.
