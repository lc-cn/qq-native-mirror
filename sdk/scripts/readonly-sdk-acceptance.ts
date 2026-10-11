import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, lstat, readlink, realpath } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { QQClient, ClientOptions } from '../src/index.ts';
import type * as InstalledSdk from '../src/index.ts';

/** Immutable historical batch facts. These do not grant authorization. */
export interface ReadonlyAcceptanceBatch {
  root: string;
  release: string;
  planSha256: string;
  sourceCommit: string;
  sourceRunId: string;
  nativeSource?: { commit: string; runId: string };
}
export type ReadonlyAcceptanceClient = Pick<
  QQClient,
  | 'login'
  | 'listFriends'
  | 'listGroups'
  | 'getGroupMembers'
  | 'getHistory'
  | 'getMessage'
  | 'close'
  | 'state'
>;
/** Runtime acquisition varies between installed consumer and controlled offline adapters.
 * It is invoked only after all preflight checks and successful exclusive reservation.
 */
export interface ReadonlyAcceptanceRuntime {
  load(
    entryUrl: string,
  ): Promise<{ createClient(options: ClientOptions): Promise<ReadonlyAcceptanceClient> }>;
}
const installedRuntime: ReadonlyAcceptanceRuntime = {
  async load(entryUrl) {
    const module: typeof InstalledSdk = await import(entryUrl);
    return module;
  },
};
interface AcceptancePlan {
  schemaVersion: number;
  sdkVersion: string;
  sourceCommit: string;
  sourceRunId: string;
  nativeSourceCommit?: string;
  nativeSourceRunId?: string;
  sdkBindingSha256?: string;
  method: string;
  queryLimit: number;
  queries: string[];
  peer: { type: 'private'; userId: string };
  historyLimit: number;
  automaticPlatformSelection: boolean;
  send: boolean;
  recall: boolean;
  profileMutation: boolean;
  relationshipMutation: boolean;
  retry: boolean;
  qrFallback: boolean;
  persistContactDetails: boolean;
  persistMessageContents: boolean;
  platform: string;
  arch: string;
  nodeVersion: string;
  nodeConfigSha256: string;
  releaseManifestSha256: string;
  tarballs: Record<string, string>;
  installedFiles: Record<string, string>;
  installedLinks: Record<string, string>;
  consumerFiles: Record<string, string>;
  auxiliary: string;
  nativeManifestSha256: string;
  nativeFiles: number;
}
interface SeparateSourceBinding {
  builderCommit: string;
  builderRunId: string;
  tarball: string;
  sha256: string;
  nativeSource: {
    commit: string;
    runId: string;
    releaseManifestSha256: string;
    auxiliary: { tarball: string; sha256: string };
  };
}
interface NativeClosure {
  platform: string;
  arch: string;
  files: Array<{ path: string; sha256: string }>;
}
/** Do not execute unknown error accessors/coercion while recording sanitized failures. */
function errorFields(error: unknown): { code: unknown; message: string } {
  let code: unknown;
  let message = '';
  try {
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      const c = Object.getOwnPropertyDescriptor(error, 'code');
      if (c && 'value' in c) code = c.value as unknown;
      const m = Object.getOwnPropertyDescriptor(error, 'message');
      if (m && 'value' in m && typeof m.value === 'string') message = m.value;
    }
  } catch {
    /* Opaque faults stay operation-failed without inspecting their content. */
  }
  return { code, message };
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const queries = [
  'listFriends',
  'listGroups',
  'getGroupMembers:first-group-if-present',
  'getHistory:private-8596238-limit-1',
  'getMessage:same-history-id',
];

function validateScope(
  plan: AcceptancePlan,
  batch: ReadonlyAcceptanceBatch,
  arguments_: readonly string[],
): void {
  if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== '--execute-approved'))
    throw new Error('Use review mode or --execute-approved after explicit human authorization');
  if (
    plan.schemaVersion !== 1 ||
    plan.sdkVersion !== '0.0.2' ||
    plan.sourceCommit !== batch.sourceCommit ||
    plan.sourceRunId !== batch.sourceRunId ||
    (batch.nativeSource !== undefined &&
      (plan.nativeSourceCommit !== batch.nativeSource.commit ||
        plan.nativeSourceRunId !== batch.nativeSource.runId)) ||
    plan.method !== 'restore' ||
    plan.queryLimit !== 1 ||
    JSON.stringify(plan.queries) !== JSON.stringify(queries) ||
    plan.peer?.type !== 'private' ||
    plan.peer.userId !== '8596238' ||
    plan.historyLimit !== 1 ||
    plan.automaticPlatformSelection !== true ||
    (
      [
        'send',
        'recall',
        'profileMutation',
        'relationshipMutation',
        'retry',
        'qrFallback',
        'persistContactDetails',
        'persistMessageContents',
      ] as const
    ).some((key) => plan[key] !== false)
  )
    throw new Error('Acceptance scope changed');
}
function validateRuntime(plan: AcceptancePlan): void {
  if (
    process.platform !== plan.platform ||
    process.arch !== plan.arch ||
    process.version !== plan.nodeVersion ||
    sha(Buffer.from(JSON.stringify(process.config))) !== plan.nodeConfigSha256
  )
    throw new Error('Reviewed device/runtime changed');
}
async function verifyRelease(
  batch: ReadonlyAcceptanceBatch,
  release: string,
  plan: AcceptancePlan,
): Promise<void> {
  if (batch.nativeSource) {
    const bindingBytes = await readFile(join(release, 'consumer-sdk.json'));
    const binding = JSON.parse(bindingBytes.toString()) as SeparateSourceBinding;
    if (
      sha(bindingBytes) !== plan.sdkBindingSha256 ||
      binding.builderCommit !== plan.sourceCommit ||
      binding.builderRunId !== plan.sourceRunId ||
      binding.nativeSource?.commit !== plan.nativeSourceCommit ||
      binding.nativeSource?.runId !== plan.nativeSourceRunId ||
      binding.tarball !== 'qq-native-client-0.0.2.tgz' ||
      binding.sha256 !== plan.tarballs[binding.tarball] ||
      binding.nativeSource.auxiliary.tarball !== 'qq-native-client-darwin-arm64-0.0.2.tgz' ||
      binding.nativeSource.auxiliary.sha256 !==
        plan.tarballs[binding.nativeSource.auxiliary.tarball]
    )
      throw new Error('Separate SDK/native source binding changed');
    if (
      sha(await readFile(join(release, 'release-manifest.json'))) !== plan.releaseManifestSha256 ||
      binding.nativeSource.releaseManifestSha256 !== plan.releaseManifestSha256
    )
      throw new Error('Original native release manifest changed');
  } else if (
    sha(await readFile(join(release, 'release-manifest.json'))) !== plan.releaseManifestSha256
  ) {
    throw new Error('Candidate manifest changed');
  }
  for (const [name, expected] of Object.entries(plan.tarballs)) {
    if (
      !['qq-native-client-0.0.2.tgz', 'qq-native-client-darwin-arm64-0.0.2.tgz'].includes(name) ||
      sha(await readFile(join(release, name))) !== expected
    )
      throw new Error('Reviewed tarball changed');
  }
}
async function verifyInstallation(root: string, modules: string, plan: AcceptancePlan) {
  const files: Record<string, string> = {},
    links: Record<string, string> = {};
  async function inventory(relative = ''): Promise<void> {
    for (const name of (await readdir(join(modules, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = await lstat(join(modules, path));
      if (stat.isDirectory()) await inventory(path);
      else if (stat.isFile()) files[path] = sha(await readFile(join(modules, path)));
      else if (stat.isSymbolicLink()) {
        links[path] = await readlink(join(modules, path));
        if (!(await realpath(join(modules, path))).startsWith(modules + sep))
          throw new Error('Installed link escapes reviewed directory');
      } else throw new Error('Unexpected installed entry');
    }
  }
  await inventory();
  if (
    JSON.stringify(files) !== JSON.stringify(plan.installedFiles) ||
    JSON.stringify(links) !== JSON.stringify(plan.installedLinks)
  )
    throw new Error('Installed files or links changed');
  for (const [path, expected] of Object.entries(plan.consumerFiles)) {
    if (
      !['package.json', 'package-lock.json', 'entry.mjs'].includes(path) ||
      sha(await readFile(join(root, 'consumer', path))) !== expected
    )
      throw new Error('Reviewed consumer entry changed');
  }
  const native = JSON.parse(
    await readFile(join(modules, plan.auxiliary, 'manifest.json'), 'utf8'),
  ) as NativeClosure;
  if (
    files[`${plan.auxiliary}/manifest.json`] !== plan.nativeManifestSha256 ||
    native.platform !== process.platform ||
    native.arch !== process.arch ||
    native.files.length !== plan.nativeFiles ||
    native.files.some(
      (file: { path: string; sha256: string }) =>
        files[`${plan.auxiliary}/${file.path}`] !== file.sha256,
    )
  )
    throw new Error('Native closure changed');
  return { installedFiles: Object.keys(files).length, nativeFiles: native.files.length };
}

async function executeReadonlyAccount(
  root: string,
  plan: AcceptancePlan,
  planSha256: string,
  runtime: ReadonlyAcceptanceRuntime,
) {
  const dataDir = resolve('.local/pruned-qr-readonly-v1/account');
  // Reserve before importing runtime; keep the marker after failure or uncertainty.
  await writeFile(
    join(root, 'read-once.lock'),
    JSON.stringify({ planSha256, reservedAt: new Date().toISOString() }),
    { flag: 'wx', mode: 0o600 },
  );
  const receipt = {
    startedAt: new Date().toISOString(),
    planSha256,
    sourceCommit: plan.sourceCommit,
    sourceRunId: plan.sourceRunId,
    sdkVersion: plan.sdkVersion,
    stage: 'initialize',
    restoreAttempted: false,
    restored: false,
    friendQueryAttempted: false,
    friendCount: 0,
    groupQueryAttempted: false,
    groupCount: 0,
    memberQueryAttempted: false,
    memberQuerySkippedNoGroup: false,
    memberCount: 0,
    historyAttempted: false,
    historyCount: 0,
    lookupAttempted: false,
    matched: false,
    closed: false,
    errorCategory: '',
    errorCode: '',
    interrupted: false,
    signingAuthenticityEstablished: false,
  };
  const save = () =>
    writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  let client: ReadonlyAcceptanceClient | undefined;
  let exitCode = 0;
  let closeAttempt: Promise<void> | undefined;
  const closeClient = (): Promise<void> => {
    if (!client) return Promise.resolve();
    if (closeAttempt) return closeAttempt;
    let complete!: (value: void | PromiseLike<void>) => void;
    let fail!: (error: unknown) => void;
    // Reserve before invoking close: synchronous reentry must reuse the same attempt.
    closeAttempt = new Promise<void>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    try {
      complete(client.close());
    } catch (error) {
      fail(error);
    }
    return closeAttempt;
  };
  const stop = () => {
    receipt.interrupted = true;
    exitCode = 130;
    closeClient().catch(() => {});
  };
  const checkInterrupted = () => {
    if (receipt.interrupted) throw new Error('Interrupted');
  };
  async function begin(stage: string) {
    checkInterrupted();
    receipt.stage = stage;
    await save();
    checkInterrupted();
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    checkInterrupted();
    const { createClient } = await runtime.load(
      pathToFileURL(join(root, 'consumer/entry.mjs')).href,
    );
    checkInterrupted();
    client = await createClient({ dataDir, timeoutMs: 30000, autoReconnect: false });
    if (!client) throw new Error('No client');
    await begin('restore');
    receipt.restoreAttempted = true;
    await save();
    checkInterrupted();
    await client.login({ method: 'restore' });
    receipt.restored = true;
    await begin('friends');
    receipt.friendQueryAttempted = true;
    await save();
    checkInterrupted();
    receipt.friendCount = (await client.listFriends()).length;
    await begin('groups');
    receipt.groupQueryAttempted = true;
    await save();
    checkInterrupted();
    const groups = await client.listGroups();
    receipt.groupCount = groups.length;
    if (groups.length) {
      await begin('members');
      receipt.memberQueryAttempted = true;
      await save();
      checkInterrupted();
      receipt.memberCount = (await client.getGroupMembers(groups[0]!.groupId)).length;
    } else receipt.memberQuerySkippedNoGroup = true;
    await begin('history');
    receipt.historyAttempted = true;
    await save();
    checkInterrupted();
    const history = await client.getHistory(plan.peer, { limit: 1 });
    receipt.historyCount = history.length;
    if (history.length !== 1) throw new Error('No known message available');
    await begin('lookup');
    receipt.lookupAttempted = true;
    await save();
    checkInterrupted();
    const message = await client.getMessage(plan.peer, history[0]!.messageId),
      known = history[0]!;
    receipt.matched =
      !!message &&
      message.messageId === known.messageId &&
      message.sequence === known.sequence &&
      message.time === known.time &&
      message.sender.uid === known.sender.uid &&
      message.peer.type === 'private' &&
      message.peer.userId === plan.peer.userId;
    if (!receipt.matched) throw new Error('Lookup mismatch');
    checkInterrupted();
    receipt.stage = 'complete';
  } catch (error) {
    const { code, message } = errorFields(error);
    if (typeof code === 'number' && Number.isFinite(code)) receipt.errorCode = String(code);
    else if (typeof code === 'string' && /^[\w.:-]{1,64}$/.test(code)) receipt.errorCode = code;
    receipt.errorCategory = receipt.interrupted
      ? 'interrupted'
      : /timed? ?out/i.test(message)
        ? 'timeout'
        : 'operation-failed';
    exitCode = receipt.interrupted ? 130 : 1;
  } finally {
    try {
      await closeClient();
      receipt.closed = client?.state === 'closed';
    } catch {
      receipt.errorCategory = 'shutdown-failed';
      exitCode = 1;
    }
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (receipt.interrupted) {
      receipt.errorCategory = 'interrupted';
      exitCode = 130;
    }
    await save();
  }

  return { mode: 'execution' as const, receipt, exitCode };
}

/** Review only reads approved package metadata. Execute still requires external human
 * authorization plus --execute-approved; reservation is never released or retried.
 * Queries are fixed here, not configurable batch capabilities.
 */
export async function runReadonlySdkAcceptance(
  batch: ReadonlyAcceptanceBatch,
  arguments_: readonly string[],
  runtime: ReadonlyAcceptanceRuntime = installedRuntime,
) {
  const root = resolve(batch.root);
  const release = resolve(batch.release);
  const planBytes = await readFile(join(root, 'plan.json'));
  const planSha256 = sha(planBytes);
  if (planSha256 !== batch.planSha256) throw new Error('Reviewed acceptance plan changed');
  const plan = JSON.parse(planBytes.toString()) as AcceptancePlan;
  validateScope(plan, batch, arguments_);
  validateRuntime(plan);
  await verifyRelease(batch, release, plan);
  const inventory = await verifyInstallation(root, resolve(root, 'consumer/node_modules'), plan);
  if (arguments_.length === 0)
    return {
      mode: 'review' as const,
      review: {
        planSha256,
        sourceCommit: plan.sourceCommit,
        sourceRunId: plan.sourceRunId,
        sdkVersion: plan.sdkVersion,
        queries,
        ...inventory,
        automaticPlatformSelection: true,
        accountUsed: false,
        nativeExecuted: false,
      },
    };
  return executeReadonlyAccount(root, plan, planSha256, runtime);
}
