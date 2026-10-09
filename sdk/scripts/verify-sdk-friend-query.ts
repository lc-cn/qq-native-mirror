import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { QQClient, NativeManifest } from '../src/index.ts';

// Review is the default. --execute-approved is not itself human authorization.
const root = resolve('.local/acceptance/friend-query-v1');
const sdk = resolve(root, 'consumer/node_modules/qq-native-client');
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const bytes = await readFile(resolve(root, 'plan.json'));
if (sha(bytes) !== '71cc874e8b0312491d7821facf20f825b2046de84aa3b66265b72f070e78c165') throw new Error('Acceptance plan changed; review it again');
const plan = JSON.parse(bytes.toString());
if (process.argv.slice(2).some(arg => arg !== '--execute-approved') || process.argv.length > 3) throw new Error('Use review mode or --execute-approved after explicit human authorization');
if (plan.schemaVersion !== 1 || plan.method !== 'restore' || plan.queryLimit !== 1 || JSON.stringify(plan.queries) !== '["listFriends"]' || plan.send !== false || plan.recall !== false || plan.profileMutation !== false || plan.relationshipMutation !== false || plan.history !== false || plan.retry !== false || plan.qrFallback !== false || plan.persistContactDetails !== false) throw new Error('Unexpected acceptance scope');
if (sha(await readFile(resolve(root, 'qq-native-client-0.0.1.tgz'))) !== plan.tarballSha256) throw new Error('Reviewed SDK tarball changed');
for (const [path, expected] of Object.entries(plan.runtimeHashes)) {
  if (typeof expected !== 'string' || sha(await readFile(resolve(sdk, path))) !== expected) throw new Error('Installed SDK file changed');
}
const nativeDir = resolve('.local/native/qq-7.0.2-53644-darwin-arm64-pruned-v1');
const nativeBytes = await readFile(resolve(nativeDir, 'manifest.json'));
if (sha(nativeBytes) !== plan.nativeManifestSha256) throw new Error('Reviewed native manifest changed');
const manifest = JSON.parse(nativeBytes.toString()) as NativeManifest;
for (const file of manifest.files) {
  if (sha(await readFile(resolve(nativeDir, file.path))) !== file.sha256) throw new Error('Reviewed native file changed');
}
const dataDir = resolve('.local/pruned-qr-readonly-v1/account');
if (process.argv.length === 2) {
  console.log(JSON.stringify({ planSha256: sha(bytes), sourceCommit: plan.sourceCommit, method: plan.method, queries: plan.queries,
    queryLimit: plan.queryLimit, runtimeFilesBound: Object.keys(plan.runtimeHashes).length, nativeFiles: manifest.files.length,
    dataDir, send: false, recall: false, history: false, retry: false, qrFallback: false, accountUsed: false, nativeExecuted: false }, null, 2));
  process.exit(0);
}
// Reserve before importing runtime code. A failed/uncertain batch is not retried.
await writeFile(resolve(root, 'read-once.lock'), JSON.stringify({ planSha256: sha(bytes), reservedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
const receipt = { startedAt: new Date().toISOString(), planSha256: sha(bytes), restoreAttempted: false, restored: false,
  friendQueryAttempted: false, friendCount: 0, friendMetadataNotifications: 0, closed: false,
  errorCategory: '', errorCode: '', interrupted: false, signingAuthenticityEstablished: false };
const save = () => writeFile(resolve(root, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
let client: QQClient | undefined;
const stop = () => { receipt.interrupted = true; process.exitCode = 130; void client?.close().catch(() => {}); };
const checkInterrupted = () => { if (receipt.interrupted) throw new Error('Interrupted'); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('Unsupported acceptance platform');
  checkInterrupted();
  const { createClient } = await import(pathToFileURL(resolve(sdk, 'dist/index.js')).href);
  client = await createClient({ wrapperPath: resolve(nativeDir, manifest.wrapper), bridgePath: resolve(sdk, plan.bridge),
    version: manifest.version, dataDir, timeoutMs: 30000, autoReconnect: false });
  if (!client) throw new Error('No client');
  client.on('friend-list-updated', () => { receipt.friendMetadataNotifications++; });
  checkInterrupted();
  receipt.restoreAttempted = true; await save(); checkInterrupted();
  await client.login({ method: 'restore' }); receipt.restored = true; await save(); checkInterrupted();
  receipt.friendQueryAttempted = true; await save(); checkInterrupted();
  const friends = await client.listFriends();
  receipt.friendCount = friends.length;
} catch (error) {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'number' && Number.isFinite(code)) receipt.errorCode = String(code);
  else if (typeof code === 'string' && /^[\w.:-]{1,64}$/.test(code)) receipt.errorCode = code;
  receipt.errorCategory = receipt.interrupted ? 'interrupted' : /timed? ?out/i.test(error instanceof Error ? error.message : '') ? 'timeout' : 'operation-failed';
  process.exitCode = receipt.interrupted ? 130 : 1;
} finally {
  try { await client?.close(); receipt.closed = client?.state === 'closed'; }
  catch { receipt.errorCategory = 'shutdown-failed'; process.exitCode = 1; }
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  if (receipt.interrupted) { receipt.errorCategory = 'interrupted'; process.exitCode = 130; }
  await save();
}
