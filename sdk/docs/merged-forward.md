# Text merged-forward composition (unpublished source)

`sendMergedForward(peer, nodes, options?)` creates a merged-forward upload and sends one chat-record card. It is implemented in the ordinary Node SDK, worker and CLI. It is absent from npm `0.0.1`. Offline tests establish input, encoding, lifecycle and response contracts; real QQ upload, card delivery and signing authenticity remain unverified.

```ts
import { createClient, KernelRequestError } from 'qq-native-client';

const client = await createClient({ dataDir: './account' });
try {
  // This restores a previously authorized account; authorize any real send separately.
  await client.login({ method: 'restore', uin: 'YOUR_QQ_NUMBER' });
  const receipt = await client.sendMergedForward(
    { type: 'private', userId: 'RECIPIENT_QQ_NUMBER' },
    [{ userId: 'AUTHOR_QQ_NUMBER', nickname: 'Author', time: 1791500000, text: 'Example' }],
    { title: '聊天记录', summary: '查看1条消息', prompt: '[聊天记录]' },
  );
  console.log(receipt); // messageId, sequence, time, resourceId
} catch (error) {
  if (error instanceof KernelRequestError && error.mergedForward) {
    console.error(error.mergedForward, error.code);
    // Unknown completion requires reconciliation; do not automatically resend.
  }
  throw error;
} finally {
  await client.close();
}
```

Each node has exactly `userId`, `nickname`, `time` and `text`. Author IDs are canonical positive decimal uint32 strings; `time` is an explicit positive uint32 Unix timestamp in seconds. Nicknames and text must be nonempty valid UTF-8. Private destinations accept the SDK's numeric or `u_` identity forms; group destinations require a positive uint32 group number. The API requires an online client.

There must be 1–100 dense text nodes. Sparse arrays, unknown fields, media, nested resources, invalid text and malformed later nodes reject the whole operation before recipient lookup or upload. Inputs are snapshotted before asynchronous work. The request, intermediate protobuf payload, aggregate text/card input and final card JSON have 1 MiB limits; resource IDs have a 4096 UTF-8 byte limit. These are SDK policies, not established server limits. The complete record retains the input text; card previews clip to 160 code points.

The worker resolves the destination, encodes the fixed SSO command using its own logged-in UID, and awaits one response through `Session.getMsgService().sendSsoCmdReqByContend`. It then generates a separate card UUID and submits an ARK element through the regular send path. The uploaded resource ID, card UUID and native send correlation ID have different roles. A resolved resource ID alone is insufficient for a successful send receipt: the native submission must return success and the terminal message update must match the send correlation and explicit conversation fields when present. A native receipt does not independently prove recipient visibility.

`KernelRequestError.mergedForward` records `phase: 'upload' | 'card' | 'operation'`, `uploadCompletion: 'not-dispatched' | 'unknown' | 'resource-received'`, `cardCompletion: 'not-dispatched' | 'unknown'`, and the `resourceId` when received. A card failure preserves the resource ID and a primitive native result code when available. Parent IPC timeout, worker exit, offline, reconnect or close after submission reports `operation/unknown/unknown`, because the parent cannot locate the native phase. No arbitrary native payload, cause or stack is serialized as partial progress. The SDK does not retry uploads/cards, replay pending sends after reconnect, send temporary self messages, or install packet hooks.

CLI `nodes.json` contains the same node array:

```sh
qq-native-client send-forward --config ./qq.json --kind private \
  --target RECIPIENT_QQ_NUMBER --nodes-file ./nodes.json --title 聊天记录
```

Optional flags are `--summary`, `--prompt`, and the existing `--uin`. The CLI validates the JSON file (at most 2 MiB) and the whole request before creating a client or restoring an account. On failure it prints the checked partial progress and optional result code. Executing this command restores the account and performs a real upload/send.

The implementation is independently authored from fixed protocol field facts, without copying the inspected restrictive-license implementation. See [source contracts](merged-forward-contract.md), [request encoding](long-message-request-internal.md), [response parsing](long-message-response.md) and [card formatting](merged-forward-card-internal.md). Test services and fake IPC workers do not establish the actual native response shape, server compatibility, recipient delivery, or other platforms' account behavior.

Local build and 484/484 offline SDK regressions passed. [Six-platform installed-consumer CI](https://github.com/lc-cn/qq-native-mirror/actions/runs/37985572940) at `5469440f330541c306d92d1f4414e0074102127c` passed both new compiled contracts on Linux, Windows and macOS x64/arm64. Separate probes restored every original native file, initialized/closed the actual addon and decoded three video fixtures per device without accounts. Independent artifact checks matched 46 compiled modules byte-for-byte and the two Windows CLI help templates after their documented CRLF normalization, preserving all original hashes. [Local evidence](evidence/merged-forward-local.json) and [installed evidence](evidence/merged-forward-six-ci-37985572940.json). No real merged-forward upload or recipient delivery was attempted.
