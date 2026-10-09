import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { QQClient, NativeManifest } from '../src/index.ts';

// Review by default. A command-line flag does not supply human authorization.
const root = resolve('.local/acceptance/message-query-v1');
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const bytes = await readFile(resolve(root, 'plan.json'));
if (sha(bytes) !== '0a3973b6281fac282b0e0b11ffde28f14bdd132a4721158c0878b27883311824') throw new Error('Acceptance plan changed; review it again');
const plan = JSON.parse(bytes.toString());
if (process.argv.slice(2).some(arg => arg !== '--execute-approved') || process.argv.length > 3) throw new Error('Use review mode or --execute-approved after explicit human authorization');
if (plan.schemaVersion !== 1 || plan.peer?.type !== 'private' || plan.peer.userId !== '8596238' || plan.historyLimit !== 1 || plan.method !== 'restore') throw new Error('Unexpected acceptance scope');
if (sha(await readFile(resolve(root, 'qq-native-client-0.0.1.tgz'))) !== plan.tarballSha256) throw new Error('Reviewed SDK tarball changed');
for (const [path, expected] of Object.entries(plan.runtimeHashes)) {
  if (typeof expected !== 'string' || sha(await readFile(resolve(root, 'consumer/node_modules/qq-native-client/dist', path))) !== expected) throw new Error('Installed SDK runtime changed');
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
  console.log(JSON.stringify({ planSha256: sha(bytes), plan, dataDir, accountUsed: false, nativeExecuted: false }, null, 2));
  process.exit(0);
}
// Exclusive reservation prevents a failed/uncertain attempt being retried.
await writeFile(resolve(root, 'read-once.lock'), JSON.stringify({ planSha256: sha(bytes), reservedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
const receipt = { startedAt: new Date().toISOString(), planSha256: sha(bytes), restored: false, historyAttempted: false,
  historyCount: 0, lookupAttempted: false, matched: false, closed: false, errorCategory: '', errorCode: '', interrupted: false };
const save = () => writeFile(resolve(root, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
const stop = () => { receipt.interrupted = true; process.exitCode = 130; };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
let client: QQClient | undefined;
try {
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('Unsupported acceptance platform');
  if (receipt.interrupted) throw new Error('Interrupted');
  const { createClient } = await import(pathToFileURL(resolve(root, 'consumer/node_modules/qq-native-client/dist/index.js')).href);
  client = await createClient({ wrapperPath: resolve(nativeDir, manifest.wrapper), version: manifest.version, dataDir, timeoutMs: 30000, autoReconnect: false });
  if (!client || receipt.interrupted) throw new Error('Interrupted');
  await client.login({ method: 'restore' }); receipt.restored = true; await save();
  if (receipt.interrupted) throw new Error('Interrupted');
  receipt.historyAttempted = true; await save();
  if (receipt.interrupted) throw new Error('Interrupted');
  const history = await client.getHistory(plan.peer, { limit: 1 });
  receipt.historyCount = history.length; await save();
  if (history.length !== 1) throw new Error('No known message available for lookup');
  if (receipt.interrupted) throw new Error('Interrupted');
  receipt.lookupAttempted = true; await save();
  if (receipt.interrupted) throw new Error('Interrupted');
  const message = await client.getMessage(plan.peer, history[0]!.messageId);
  const known = history[0]!;
  receipt.matched = !!message && message.messageId === known.messageId && message.sequence === known.sequence && message.time === known.time
    && message.sender.uid === known.sender.uid && message.peer.type === 'private' && message.peer.userId === plan.peer.userId;
  if (!receipt.matched) throw new Error('Message lookup did not match history');
} catch (error) {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'number' && Number.isFinite(code)) receipt.errorCode = String(code);
  receipt.errorCategory = receipt.interrupted ? 'interrupted' : /timed? ?out/i.test(error instanceof Error ? error.message : '') ? 'timeout' : 'operation-failed';
  process.exitCode = receipt.interrupted ? 130 : 1;
} finally {
  try { await client?.close(); receipt.closed = client?.state === 'closed'; }
  catch { receipt.errorCategory = 'shutdown-failed'; process.exitCode = 1; }
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  if (receipt.interrupted) { receipt.errorCategory = 'interrupted'; process.exitCode = 130; }
  await save();
}
