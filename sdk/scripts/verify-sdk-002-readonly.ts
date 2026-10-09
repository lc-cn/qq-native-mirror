import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, lstat, readlink, realpath } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { QQClient } from '../src/index.ts';

// The flag is an execution switch, not human authorization. Review is the default.
const root = resolve('.local/acceptance/sdk-002-readonly-v1');
const modules = resolve(root, 'consumer/node_modules');
const release = resolve('.local/releases/npm-0.0.2-ci-37925080425');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const planBytes = await readFile(join(root, 'plan.json'));
const planSha256 = sha(planBytes);
if (planSha256 !== '73caa95d6bfe4c7fd56e57cf87893ea220af0d2526b9c0c9aa28c50f23b23d1b') throw new Error('Reviewed acceptance plan changed');
const plan = JSON.parse(planBytes.toString());
const arguments_ = process.argv.slice(2);
if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== '--execute-approved')) throw new Error('Use review mode or --execute-approved after explicit human authorization');
const queries = ['listFriends', 'listGroups', 'getGroupMembers:first-group-if-present', 'getHistory:private-8596238-limit-1', 'getMessage:same-history-id'];
if (plan.schemaVersion !== 1 || plan.sdkVersion !== '0.0.2' || plan.sourceCommit !== 'b4b2e4eab5e44f99126e2efc68d6701ac7658833' || plan.sourceRunId !== '37925080425' ||
    plan.method !== 'restore' || plan.queryLimit !== 1 || JSON.stringify(plan.queries) !== JSON.stringify(queries) || plan.peer?.type !== 'private' || plan.peer.userId !== '8596238' || plan.historyLimit !== 1 ||
    plan.automaticPlatformSelection !== true || ['send','recall','profileMutation','relationshipMutation','retry','qrFallback','persistContactDetails','persistMessageContents'].some(key => plan[key] !== false)) throw new Error('Acceptance scope changed');
if (process.platform !== plan.platform || process.arch !== plan.arch || process.version !== plan.nodeVersion || sha(Buffer.from(JSON.stringify(process.config))) !== plan.nodeConfigSha256) throw new Error('Reviewed device/runtime changed');
if (sha(await readFile(join(release, 'release-manifest.json'))) !== plan.releaseManifestSha256) throw new Error('Candidate manifest changed');
for (const [name, expected] of Object.entries(plan.tarballs)) {
  if (!['qq-native-client-0.0.2.tgz','qq-native-client-darwin-arm64-0.0.2.tgz'].includes(name) || sha(await readFile(join(release, name))) !== expected) throw new Error('Reviewed tarball changed');
}
const files: Record<string, string> = {}, links: Record<string, string> = {};
async function inventory(relative = ''): Promise<void> {
  for (const name of (await readdir(join(modules, relative))).sort()) {
    const path = relative ? `${relative}/${name}` : name;
    const stat = await lstat(join(modules, path));
    if (stat.isDirectory()) await inventory(path);
    else if (stat.isFile()) files[path] = sha(await readFile(join(modules, path)));
    else if (stat.isSymbolicLink()) {
      links[path] = await readlink(join(modules, path));
      if (!(await realpath(join(modules, path))).startsWith(modules + sep)) throw new Error('Installed link escapes reviewed directory');
    } else throw new Error('Unexpected installed entry');
  }
}
await inventory();
if (JSON.stringify(files) !== JSON.stringify(plan.installedFiles) || JSON.stringify(links) !== JSON.stringify(plan.installedLinks)) throw new Error('Installed files or links changed');
for (const [path, expected] of Object.entries(plan.consumerFiles)) {
  if (!['package.json','package-lock.json','entry.mjs'].includes(path) || sha(await readFile(join(root, 'consumer', path))) !== expected) throw new Error('Reviewed consumer entry changed');
}
const native = JSON.parse(await readFile(join(modules, plan.auxiliary, 'manifest.json'), 'utf8'));
if (files[`${plan.auxiliary}/manifest.json`] !== plan.nativeManifestSha256 || native.platform !== process.platform || native.arch !== process.arch || native.files.length !== plan.nativeFiles ||
    native.files.some((file: { path: string; sha256: string }) => files[`${plan.auxiliary}/${file.path}`] !== file.sha256)) throw new Error('Native closure changed');
const dataDir = resolve('.local/pruned-qr-readonly-v1/account');
if (arguments_.length === 0) {
  console.log(JSON.stringify({ planSha256, sourceCommit: plan.sourceCommit, sourceRunId: plan.sourceRunId, sdkVersion: plan.sdkVersion, queries, installedFiles: Object.keys(files).length,
    nativeFiles: native.files.length, automaticPlatformSelection: true, accountUsed: false, nativeExecuted: false }, null, 2));
  process.exit(0);
}
// Reserve before importing runtime; keep the marker after failure or uncertainty.
await writeFile(join(root, 'read-once.lock'), JSON.stringify({ planSha256, reservedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
const receipt = { startedAt: new Date().toISOString(), planSha256, sourceCommit: plan.sourceCommit, sourceRunId: plan.sourceRunId, sdkVersion: plan.sdkVersion,
  stage: 'initialize', restoreAttempted: false, restored: false, friendQueryAttempted: false, friendCount: 0, groupQueryAttempted: false, groupCount: 0,
  memberQueryAttempted: false, memberQuerySkippedNoGroup: false, memberCount: 0, historyAttempted: false, historyCount: 0,
  lookupAttempted: false, matched: false, closed: false, errorCategory: '', errorCode: '', interrupted: false, signingAuthenticityEstablished: false };
const save = () => writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
let client: QQClient | undefined;
const stop = () => { receipt.interrupted = true; process.exitCode = 130; void client?.close().catch(() => {}); };
const checkInterrupted = () => { if (receipt.interrupted) throw new Error('Interrupted'); };
async function begin(stage: string) { checkInterrupted(); receipt.stage = stage; await save(); checkInterrupted(); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  checkInterrupted();
  const { createClient } = await import(pathToFileURL(join(root, 'consumer/entry.mjs')).href);
  client = await createClient({ dataDir, timeoutMs: 30000, autoReconnect: false });
  if (!client) throw new Error('No client');
  await begin('restore'); receipt.restoreAttempted = true; await save(); checkInterrupted();
  await client.login({ method: 'restore' }); receipt.restored = true;
  await begin('friends'); receipt.friendQueryAttempted = true; await save(); checkInterrupted();
  receipt.friendCount = (await client.listFriends()).length;
  await begin('groups'); receipt.groupQueryAttempted = true; await save(); checkInterrupted();
  const groups = await client.listGroups(); receipt.groupCount = groups.length;
  if (groups.length) {
    await begin('members'); receipt.memberQueryAttempted = true; await save(); checkInterrupted();
    receipt.memberCount = (await client.getGroupMembers(groups[0]!.groupId)).length;
  } else receipt.memberQuerySkippedNoGroup = true;
  await begin('history'); receipt.historyAttempted = true; await save(); checkInterrupted();
  const history = await client.getHistory(plan.peer, { limit: 1 }); receipt.historyCount = history.length;
  if (history.length !== 1) throw new Error('No known message available');
  await begin('lookup'); receipt.lookupAttempted = true; await save(); checkInterrupted();
  const message = await client.getMessage(plan.peer, history[0]!.messageId), known = history[0]!;
  receipt.matched = !!message && message.messageId === known.messageId && message.sequence === known.sequence && message.time === known.time && message.sender.uid === known.sender.uid && message.peer.type === 'private' && message.peer.userId === plan.peer.userId;
  if (!receipt.matched) throw new Error('Lookup mismatch');
  checkInterrupted(); receipt.stage = 'complete';
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
