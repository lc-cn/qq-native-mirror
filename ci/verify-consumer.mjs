import { verifyHistoryQueryConsumer } from '../sdk/scripts/consumers/history-query-consumer-contract.mjs';
import { verifyFriendQueryConsumer } from '../sdk/scripts/consumers/friend-query-consumer-contract.mjs';
import { verifyContactObjectsConsumer } from '../sdk/scripts/consumers/contact-objects-consumer-contract.mjs';
import { verifyBotApiConsumer } from '../sdk/scripts/consumers/bot-api-consumer-contract.mjs';
import { npm } from './npm.mjs';
import { closeConsumerResources } from './consumer-resources.mjs';
import { ChildProcess, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { verifyForwardConsumer } from '../sdk/scripts/consumers/forward-consumer-contract.mjs';
import { verifyMessageBatchConsumer } from '../sdk/scripts/consumers/message-batch-consumer-contract.mjs';
import { verifyRecallConsumer } from '../sdk/scripts/consumers/recall-consumer-contract.mjs';
import { verifyMentionConsumer } from '../sdk/scripts/consumers/mention-consumer-contract.mjs';
import { verifySendConsumer } from '../sdk/scripts/consumers/send-consumer-contract.mjs';
import { verifyFaceConsumer } from '../sdk/scripts/consumers/face-consumer-contract.mjs';
import { verifyElementPreparationConsumer } from '../sdk/scripts/consumers/element-preparation-consumer-contract.mjs';
import { verifyFriendCategoryMutationsConsumer } from '../sdk/scripts/consumers/friend-category-mutations-consumer-contract.mjs';
import { verifyReceivedConsumer } from '../sdk/scripts/consumers/received-consumer-contract.mjs';
import { verifyReceivedForwardConsumer } from '../sdk/scripts/consumers/received-forward-consumer-contract.mjs';
import { verifyForwardResourceConsumer } from '../sdk/scripts/consumers/forward-resource-consumer-contract.mjs';
import { verifyForwardResourceTypes } from '../sdk/scripts/consumers/forward-resource-type-contract.mjs';
import { verifyDownloadConsumer } from '../sdk/scripts/consumers/download-consumer-contract.mjs';
import { verifyKernelSessionConsumer } from '../sdk/scripts/consumers/kernel-session-consumer-contract.mjs';
import { verifyWorkerReadCancellation } from '../sdk/scripts/consumers/worker-read-consumer-contract.mjs';
import { verifyWorkerErrorRoutes } from '../sdk/scripts/consumers/worker-error-consumer-contract.mjs';
import { verifyHistoryLifecycleConsumer } from '../sdk/scripts/consumers/history-lifecycle-consumer-contract.mjs';
import { verifyVideoConsumerContract } from '../sdk/scripts/consumers/video-consumer-contract.mjs';
import { verifyContactGroupConsumer } from '../sdk/scripts/consumers/contact-group-consumer-contract.mjs';
import { verifyActionPortConsumer } from '../sdk/scripts/consumers/action-port-consumer-contract.mjs';
import { verifyProfileRequestConsumer } from '../sdk/scripts/consumers/profile-request-consumer-contract.mjs';
import { verifyGroupRequestConsumer } from '../sdk/scripts/consumers/group-request-consumer-contract.mjs';
import { verifyGroupNoticeConsumer } from '../sdk/scripts/consumers/group-notice-consumer-contract.mjs';
import { verifyGroupSearchConsumer } from '../sdk/scripts/consumers/group-search-consumer-contract.mjs';
import { verifyGroupQueryOwnerConsumer } from '../sdk/scripts/consumers/group-query-owner-consumer-contract.mjs';
import { verifyContactGroupSnapshots } from '../sdk/scripts/consumers/contact-group-snapshot-consumer-contract.mjs';
import { verifyContactDirectoryLifetimeConsumer } from '../sdk/scripts/consumers/contact-directory-lifetime-consumer-contract.mjs';
import { verifyFeatureWaitRetirementConsumer } from '../sdk/scripts/consumers/feature-wait-retirement-consumer-contract.mjs';
import { verifyGroupFileActionLifetimeConsumer } from '../sdk/scripts/consumers/group-file-action-consumer-contract.mjs';
import { verifyRequestResultConsumer } from '../sdk/scripts/consumers/request-result-consumer-contract.mjs';
import { verifyQunWebConsumer } from '../sdk/scripts/consumers/qun-web-consumer-contract.mjs';
import { verifyWorkerBootstrapConsumer } from '../sdk/scripts/consumers/worker-bootstrap-consumer-contract.mjs';
import { verifyClientFactoryConsumer } from '../sdk/scripts/consumers/client-factory-consumer-contract.mjs';
const temporary = await mkdtemp(join(tmpdir(), 'qq-ci-consumer-'));
/** @type {import('../sdk/src/index.ts').QQClient|undefined} */
let client;
/** @type {import('node:http').Server|undefined} */
let registry;
/** @type {{error:unknown}|undefined} */
let primary;
try {
  // Ownership starts with mkdtemp; canonicalization and artifact reads can fail.
  const temp = await realpath(temporary);
  const execute = promisify(execFile);
  const { version } = JSON.parse(await readFile('sdk/package.json', 'utf8'));
  const platformName = `qq-native-client-${process.platform}-${process.arch}`;
  const binaries = new Map();
  /** @param {string} name @param {string} v @param {string} path */
  const add = async (name, v, path) => {
    const body = await readFile(path);
    binaries.set(name, {
      version: v,
      body,
      integrity: 'sha512-' + createHash('sha512').update(body).digest('base64'),
    });
  };
  await add('qq-native-client', version, `out/qq-native-client-${version}.tgz`);
  await add(platformName, version, `out/${platformName}-${version}.tgz`);
  execFileSync(
    npm[0],
    [
      ...npm[1],
      'pack',
      '--ignore-scripts',
      '--offline',
      '--cache',
      join(temp, 'npm-pack-cache'),
      '--pack-destination',
      resolve('out'),
      '--json',
    ],
    { cwd: resolve('sdk/node_modules/silk-wasm'), stdio: 'pipe' },
  );
  await add('silk-wasm', '3.7.1', 'out/silk-wasm-3.7.1.tgz');
  const deviceNames = [
    'linux-x64',
    'linux-arm64',
    'darwin-x64',
    'darwin-arm64',
    'win32-x64',
    'win32-arm64',
  ];
  const manifests = new Map();
  for (const name of ['qq-native-client', platformName, 'silk-wasm']) {
    const r = JSON.parse(
      execFileSync(
        'tar',
        [
          '-xOf',
          name === 'silk-wasm' ? 'out/silk-wasm-3.7.1.tgz' : `out/${name}-${version}.tgz`,
          'package/package.json',
        ],
        { encoding: 'utf8' },
      ),
    );
    manifests.set(name, r);
  }
  // Metadata fixtures for foreign devices exercise npm's os/cpu filter; no foreign binary is created or executed.
  for (const device of deviceNames) {
    const name = 'qq-native-client-' + device;
    if (!manifests.has(name)) {
      const [os, cpu] = device.split('-');
      manifests.set(name, {
        name,
        version,
        os: [os],
        cpu: [cpu],
        ...(os === 'linux' ? { libc: ['glibc'] } : {}),
        engines: { node: '>=24' },
      });
    }
  }
  /** @type {string[]} */
  const tarballRequests = [];
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '').slice(1));
    if (name.endsWith('.tgz')) {
      const packageName = name.slice(0, -4);
      tarballRequests.push(packageName);
      const found = binaries.get(packageName);
      if (!found) return void res.writeHead(404).end();
      return void res.end(found.body);
    }
    const manifest = manifests.get(name);
    if (!manifest) return void res.writeHead(404).end();
    const bin = binaries.get(name),
      v = manifest.version;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        name,
        'dist-tags': { latest: v },
        versions: {
          [v]: {
            ...manifest,
            dist: {
              tarball: `${origin}/${name}.tgz`,
              ...(bin ? { integrity: bin.integrity } : {}),
            },
          },
        },
      }),
    );
  });
  registry = server;
  await new Promise(
    /** @param {(value?:undefined)=>void} done */ (done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => done());
    },
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  await writeFile(
    join(temp, 'package.json'),
    JSON.stringify({ name: 'qq-ci-consumer', private: true, type: 'module' }),
  );
  const { stdout } = await execute(
    npm[0],
    [
      ...npm[1],
      'install',
      `qq-native-client@${version}`,
      '--registry',
      origin,
      '--cache',
      join(temp, 'npm-cache'),
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: temp, maxBuffer: 1024 * 1024, timeout: 120000 },
  );
  console.log(stdout);
  const foreign = tarballRequests.filter(
    (name) => name.startsWith('qq-native-client-') && name !== platformName,
  );
  if (foreign.length || !tarballRequests.includes(platformName))
    throw new Error('npm did not install exactly the matching native auxiliary package');
  for (const device of deviceNames) {
    if (`qq-native-client-${device}` !== platformName) {
      try {
        await readFile(join(temp, 'node_modules', `qq-native-client-${device}`, 'package.json'));
        throw new Error('Foreign auxiliary package installed');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
  }
  const sdk = await /** @type {Promise<typeof import('../sdk/src/index.ts')>} */ (
    import(pathToFileURL(join(temp, 'node_modules/qq-native-client/dist/index.js')).href)
  );
  /** @type {Awaited<ReturnType<typeof verifyContactGroupConsumer>>} */
  const contactGroupChecks = await verifyContactGroupConsumer(
    join(temp, 'node_modules/qq-native-client'),
  );
  /** @type {Awaited<ReturnType<typeof verifyForwardConsumer>>} */
  const forwardChecks = await verifyForwardConsumer(join(temp, 'node_modules/qq-native-client'));
  /** @type {Awaited<ReturnType<typeof verifyMessageBatchConsumer>>} */
  const messageBatchChecks = await verifyMessageBatchConsumer(
    join(temp, 'node_modules/qq-native-client'),
  );
  /** @type {Awaited<ReturnType<typeof verifyRecallConsumer>>} */
  const recallChecks = await verifyRecallConsumer(join(temp, 'node_modules/qq-native-client'));
  /** @type {Awaited<ReturnType<typeof verifyMentionConsumer>>} */
  const mentionChecks = await verifyMentionConsumer(join(temp, 'node_modules/qq-native-client'));
  /** @type {Awaited<ReturnType<typeof verifySendConsumer>>} */
  const sendChecks = await verifySendConsumer(join(temp, 'node_modules/qq-native-client'));
  /** @type {Awaited<ReturnType<typeof verifyReceivedConsumer>>} */
  const receivedChecks = await verifyReceivedConsumer(join(temp, 'node_modules/qq-native-client'));
  /** @type {Awaited<ReturnType<typeof verifyReceivedForwardConsumer>>} */
  const receivedForwardChecks = await verifyReceivedForwardConsumer(
    join(temp, 'node_modules/qq-native-client'),
  );
  /** @type {Awaited<ReturnType<typeof verifyForwardResourceConsumer>>} */
  const forwardResourceChecks = await verifyForwardResourceConsumer(
    join(temp, 'node_modules/qq-native-client'),
  );
  Object.assign(
    forwardResourceChecks,
    await verifyDownloadConsumer(join(temp, 'node_modules/qq-native-client')),
  );
  Object.assign(
    forwardResourceChecks,
    await verifyKernelSessionConsumer(join(temp, 'node_modules/qq-native-client')),
  );
  /** @type {Awaited<ReturnType<typeof verifyForwardResourceTypes>>} */
  const forwardResourceTypeChecks = await verifyForwardResourceTypes(
    join(temp, 'node_modules/qq-native-client'),
    resolve('sdk/node_modules/typescript'),
    [resolve('sdk/node_modules/@types')],
  );
  Object.assign(forwardResourceChecks, {
    forwardResourceDeclarationsContract: forwardResourceTypeChecks.success,
    forwardResourceTypeChecks,
  });
  /** @type {Awaited<ReturnType<typeof verifyHistoryLifecycleConsumer>>} */
  const historyLifecycleChecks = await verifyHistoryLifecycleConsumer(
    join(temp, 'node_modules/qq-native-client'),
  );
  const installedRoot = join(temp, 'node_modules/qq-native-client');
  /** @type {Awaited<ReturnType<typeof verifyClientFactoryConsumer>>} */
  const clientFactoryChecks = await verifyClientFactoryConsumer(installedRoot);
  /** @type {Awaited<ReturnType<typeof verifyFaceConsumer>>} */
  const faceChecks = await verifyFaceConsumer(installedRoot);
  /** @type {Awaited<ReturnType<typeof verifyElementPreparationConsumer>>} */
  const elementPreparationChecks = await verifyElementPreparationConsumer(installedRoot);
  /** @type {Awaited<ReturnType<typeof verifyFriendCategoryMutationsConsumer>>} */
  const friendCategoryMutationChecks = await verifyFriendCategoryMutationsConsumer(installedRoot);
  /** @type {Awaited<ReturnType<typeof verifyWorkerBootstrapConsumer>>} */
  const workerBootstrapChecks = await verifyWorkerBootstrapConsumer(installedRoot);
  // Real installed worker routing with controlled kernel hooks; no account/native loading.
  /** @type {Awaited<ReturnType<typeof verifyWorkerReadCancellation>>} */
  const workerReadChecks = await verifyWorkerReadCancellation({
    QQClient: sdk.QQClient,
    workerPath: join(installedRoot, 'dist/worker.js'),
    kernelPath: join(installedRoot, 'dist/kernel.js'),
    nativeServicesPath: join(installedRoot, 'dist/native-services.js'),
  });
  /** @type {Awaited<ReturnType<typeof verifyWorkerErrorRoutes>>} */
  const workerErrorChecks = await verifyWorkerErrorRoutes({
    QQClient: sdk.QQClient,
    workerPath: join(installedRoot, 'dist/worker.js'),
    kernelPath: join(installedRoot, 'dist/kernel.js'),
    nativeContractsPath: join(installedRoot, 'dist/native/native-contract-inspection.js'),
    errorsPath: join(installedRoot, 'dist/errors.js'),
  });
  const { prepareNative } =
    await /** @type {Promise<typeof import('../sdk/src/native/native-package.ts')>} */ (
      import(pathToFileURL(join(installedRoot, 'dist/native/native-package.js')).href)
    );
  const installedManifestBytes = await readFile(
    join(temp, 'node_modules', platformName, 'manifest.json'),
  );
  const installedManifest = JSON.parse(installedManifestBytes.toString('utf8'));
  // Pin the actual auxiliary version; default latest mirror consumption has its own consumer.
  const nativeCache = join(temp, 'native-cache');
  globalThis.fetch = () => {
    throw new Error('Unexpected mirror request with installed platform package');
  };
  const autoNative = await prepareNative({
    dataDir: join(temp, 'unused-video-account'),
    cacheDir: nativeCache,
    version: installedManifest.version,
  });
  let installedVideo, installedNativeStorage;
  if (installedManifest.npmStorage !== undefined) {
    assert.equal(installedManifest.npmStorage.format, 'gzip-objects-v1');
    const nativeRoot = dirname(autoNative.wrapperPath);
    assert.ok(nativeRoot.startsWith((await realpath(nativeCache)) + sep));
    for (const file of installedManifest.files) {
      const bytes = await readFile(join(nativeRoot, file.path));
      assert.equal(bytes.length, file.size);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    }
    const before = await stat(autoNative.wrapperPath);
    const warm = await prepareNative({
      dataDir: join(temp, 'unused-video-account'),
      cacheDir: nativeCache,
      version: installedManifest.version,
    });
    assert.equal(warm.wrapperPath, autoNative.wrapperPath);
    assert.equal((await stat(warm.wrapperPath)).mtimeMs, before.mtimeMs);
    installedNativeStorage = {
      format: 'gzip-objects-v1',
      nativePaths: installedManifest.files.length,
      objects: installedManifest.npmStorage.objects.length,
      allOriginalFilesVerified: true,
      warmCacheReused: true,
      networkFallbackAttempted: false,
      nativeManifestSha256: createHash('sha256').update(installedManifestBytes).digest('hex'),
      packageSha256: createHash('sha256').update(binaries.get(platformName).body).digest('hex'),
      mainPackageSha256: createHash('sha256')
        .update(binaries.get('qq-native-client').body)
        .digest('hex'),
    };
  }
  if (installedManifest.npmStorage === undefined) {
    const nativeRoot = dirname(autoNative.wrapperPath);
    assert.equal(nativeRoot, await realpath(join(temp, 'node_modules', platformName)));
    for (const file of installedManifest.files) {
      const bytes = await readFile(join(nativeRoot, file.path));
      if (file.size !== undefined) assert.equal(bytes.length, file.size);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    }
    const before = await stat(autoNative.wrapperPath);
    const warm = await prepareNative({
      dataDir: join(temp, 'unused-video-account'),
      cacheDir: nativeCache,
      version: installedManifest.version,
    });
    assert.deepEqual(warm, autoNative);
    assert.equal((await stat(warm.wrapperPath)).mtimeMs, before.mtimeMs);
    installedNativeStorage = {
      format: 'plain-installed',
      nativePaths: installedManifest.files.length,
      allInstalledFilesVerified: true,
      installedPathsReused: true,
      networkFallbackAttempted: false,
    };
  }
  if (installedManifest.videoCodec !== undefined || process.env.QQ_VIDEO_CODEC_REQUIRED === '1') {
    assert.equal(installedManifest.videoCodec, 'video/video-codec.node');
    assert.equal(
      autoNative.videoCodecPath,
      join(
        installedManifest.npmStorage === undefined
          ? join(temp, 'node_modules', platformName)
          : dirname(autoNative.wrapperPath),
        'video/video-codec.node',
      ),
    );
    // Run the shared real-addon verifier against installed dist, never a fake codec.
    const verifierSource = (await readFile('sdk/scripts/verify-video-native.mjs', 'utf8'))
      .replaceAll(
        "'../dist/features/media/video-codec-loader.js'",
        JSON.stringify(
          pathToFileURL(join(installedRoot, 'dist/features/media/video-codec-loader.js')).href,
        ),
      )
      .replaceAll(
        "'../dist/features/media/media-send.js'",
        JSON.stringify(
          pathToFileURL(join(installedRoot, 'dist/features/media/media-send.js')).href,
        ),
      );
    const verifierPath = join(installedRoot, 'installed-video-verifier.mjs');
    await writeFile(verifierPath, verifierSource);
    await execute(
      process.execPath,
      [
        verifierPath,
        autoNative.videoCodecPath,
        resolve('sdk/test/video-fixtures'),
        resolve('out/installed-video.json'),
      ],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    installedVideo = JSON.parse(await readFile('out/installed-video.json', 'utf8'));
    assert.equal(installedVideo.passed, true);
    assert.equal(installedVideo.inputs.length, 3);
    assert.equal(installedVideo.sdkFakeCache, true);
  }
  /** @type {Awaited<ReturnType<typeof verifyVideoConsumerContract>>} */
  const videoChecks = await verifyVideoConsumerContract(
    join(temp, 'node_modules/qq-native-client'),
  );
  const mergedForwardChecks = await (async () => {
    // Installed compiled SDK only. The complete pipeline uses owned synthetic services,
    // never the real native session used by the separate preparation/close probe.
    const { createNativeServices } =
      await /** @type {Promise<typeof import('../sdk/src/native-services.ts')>} */ (
        import(
          pathToFileURL(join(temp, 'node_modules/qq-native-client/dist/native-services.js')).href
        )
      );
    const { serializeKernelError } =
      await /** @type {Promise<typeof import('../sdk/src/errors.ts')>} */ (
        import(pathToFileURL(join(temp, 'node_modules/qq-native-client/dist/errors.js')).href)
      );
    assert.equal(typeof sdk.QQClient.prototype.sendMergedForward, 'function');

    /** @type {{onMsgInfoListUpdate:(value:unknown)=>void}|undefined} */
    let listener;
    let failCard = false;
    /** @type {string[]} */
    const steps = [];
    /** @type {[string,Buffer][]} */
    const uploads = [];
    /** @typedef {[string,{guildId:string,chatType:1|2,peerUid:string}, {elementType:number,arkElement:{bytesData:string}}[], ...unknown[]]} SendArguments */
    /** @type {SendArguments[]} */
    const sends = [];
    const services = createNativeServices({
      session: {
        getMsgService: () => ({
          /** @param {{onMsgInfoListUpdate:(value:unknown)=>void}} value */
          addKernelMsgListener(value) {
            listener = value;
          },
          /** @param {string} command @param {Uint8Array} data */
          sendSsoCmdReqByContend(command, data) {
            steps.push('upload');
            uploads.push([command, Buffer.from(data)]);
            return { rspbuffer: Buffer.from('12031a0172', 'hex') };
          },
          generateMsgUniqueId() {
            steps.push('generate');
            return `fixture-native-token-${sends.length}`;
          },
          /** @param {SendArguments} args */
          sendMsg(...args) {
            steps.push('send');
            sends.push(args);
            if (failCard) return { result: 23 };
            assert.ok(listener);
            listener.onMsgInfoListUpdate([
              { guildId: args[1].guildId, chatType: 1, peerUid: 'u_456', sendStatus: 1 },
              {
                guildId: args[1].guildId,
                chatType: 1,
                peerUid: 'u_456',
                sendStatus: 2,
                msgId: '42',
                msgSeq: '9',
                msgTime: '100',
              },
            ]);
            return { result: 0 };
          },
        }),
        getUixConvertService: () => ({
          /** @param {string[]} ids */
          getUid(ids) {
            steps.push('uid');
            assert.deepEqual(ids, ['456']);
            return { uidInfo: new Map([['456', 'u_456']]) };
          },
        }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getMSFService: () => ({ getServerTime: () => '100' }),
      },
      version: '7.0.2-53644',
      events: { emit: () => {} },
      media: { tools: undefined, recordCodec: undefined },
      identity: { userId: '789', uid: 'u_self' },
    });
    class MergedWorker extends ChildProcess {
      constructor() {
        super();
        Object.defineProperty(this, 'connected', { value: true, writable: true });
      }
      /** @type {{id:number,method:string}[]} */
      requests = [];
      /** @type {ChildProcess["send"]} */
      send = (request, ...options) => {
        assert.ok(request && typeof request === 'object' && 'id' in request && 'method' in request);
        assert.ok(typeof request.id === 'number');
        assert.ok(typeof request.method === 'string');
        const callback = options.find((value) => typeof value === 'function');
        this.requests.push({ id: request.id, method: request.method });
        callback?.(null);
        if (request.method === 'close') {
          services.close();
          queueMicrotask(() => {
            this.emit('message', { id: request.id, result: null });
            Object.defineProperty(this, 'exitCode', { value: 0 });
            Object.defineProperty(this, 'connected', { value: false });
            this.emit('exit', 0, null);
          });
          return true;
        }
        assert.equal(request.method, 'sendMergedForward');
        Promise.resolve()
          .then(() => services.invokeOperation('sendMergedForward', request))
          .then(
            (result) => this.emit('message', { id: request.id, result }),
            (error) => this.emit('message', { id: request.id, error: serializeKernelError(error) }),
          );
        return true;
      };
      kill() {
        Object.defineProperty(this, 'connected', { value: false });
        queueMicrotask(() => this.emit('exit', 0, null));
        return true;
      }
    }
    const worker = new MergedWorker(),
      client = new sdk.QQClient(worker, 1000);
    /** @type {import('../sdk/src/index.ts').Peer} */
    const peer = { type: 'private', userId: '456' };
    const nodes = [{ userId: '456', nickname: 'fixture', time: 100, text: 'fixture text' }];
    try {
      await assert.rejects(client.sendMergedForward(peer, nodes), /not online/);
      worker.emit('message', { event: 'ready', payload: { uin: '789', uid: 'u_self' } });
      await assert.rejects(
        Reflect.apply(client.sendMergedForward, client, [
          peer,
          [...nodes, { ...nodes[0], text: {} }],
        ]),
      );
      assert.equal(worker.requests.length, 0);
      assert.deepEqual(steps, []);
      assert.deepEqual(await client.sendMergedForward(peer, nodes, { title: 'fixture title' }), {
        messageId: '42',
        sequence: '9',
        time: 100,
        resourceId: 'r',
      });
      assert.deepEqual(steps, ['uid', 'upload', 'generate', 'send']);
      assert.equal(uploads.length, 1);
      assert.equal(sends.length, 1);
      assert.equal(uploads[0][0], 'trpc.group.long_msg_interface.MsgService.SsoSendLongMsg');
      assert.ok(Buffer.isBuffer(uploads[0][1]));
      assert.deepEqual(sends[0].slice(0, 2), [
        '0',
        { chatType: 1, peerUid: 'u_456', guildId: 'fixture-native-token-0' },
      ]);
      assert.equal(sends[0][2].length, 1);
      assert.equal(sends[0][2][0].elementType, 10);
      const card = JSON.parse(sends[0][2][0].arkElement.bytesData);
      assert.equal(card.meta.detail.resid, 'r');
      assert.equal(card.meta.detail.source, 'fixture title');
      assert.equal(card.extra.filename, card.meta.detail.uniseq);
      assert.match(
        card.extra.filename,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assert.notEqual(card.extra.filename, 'r');
      assert.notEqual(card.extra.filename, sends[0][1].guildId);
      failCard = true;
      await assert.rejects(client.sendMergedForward(peer, nodes), (error) => {
        assert.ok(
          error instanceof Error &&
            'code' in error &&
            'operation' in error &&
            'mergedForward' in error,
        );
        assert.equal(error.code, 23);
        assert.equal(error.operation, 'sendMergedForward');
        assert.deepEqual(error.mergedForward, {
          phase: 'card',
          uploadCompletion: 'resource-received',
          cardCompletion: 'unknown',
          resourceId: 'r',
        });
        return true;
      });
      assert.equal(uploads.length, 2);
      assert.equal(sends.length, 2);
      assert.equal(worker.requests.length, 2);
    } finally {
      await client.close();
      services.close();
    }
    return {
      mergedForwardClientContract: true,
      mergedForwardServiceContract: true,
      nativeMergedForwardAttempted: false,
    };
  })();
  const cli = await /** @type {Promise<typeof import('../sdk/src/cli.ts')>} */ (
    import(pathToFileURL(join(temp, 'node_modules/qq-native-client/dist/cli.js')).href)
  );
  const query =
    await /** @type {Promise<typeof import('../sdk/src/features/messages/message-query.ts')>} */ (
      import(
        pathToFileURL(
          join(temp, 'node_modules/qq-native-client/dist/features/messages/message-query.js'),
        ).href
      )
    );
  const queryId = '900719925474099312345';
  /** @type {import('../sdk/src/native/message-contracts.ts').NativePeer} */
  const queryPeer = { chatType: 1, peerUid: 'u_fixture' };
  assert.equal(typeof sdk.QQClient.prototype.getMessage, 'function');
  assert.equal(
    await query.queryNativeMessage(
      {
        getMsgsByMsgId: (peer, ids) => {
          assert.deepEqual(peer, queryPeer);
          assert.deepEqual(ids, [queryId]);
          return { result: 0, msgList: [] };
        },
      },
      queryPeer,
      queryId,
    ),
    undefined,
  );
  await assert.rejects(
    query.queryNativeMessage(
      { getMsgsByMsgId: () => ({ result: 23, msgList: [] }) },
      queryPeer,
      queryId,
    ),
    { code: 23 },
  );
  const queryAction = await cli.prepareCommand('message', {
    kind: 'private',
    target: '456',
    'message-id': queryId,
  });
  let queryArgs;
  /** @type {import("../sdk/src/index.ts").QQClient["getMessage"]} */
  const captureQuery = async (...args) => {
    queryArgs = args;
    return undefined;
  };
  const queryClient = Object.assign(
    new sdk.QQClient(Object.assign(new ChildProcess(), { exitCode: 0 }), 1000),
    { getMessage: captureQuery },
  );
  try {
    assert.equal(await queryAction(queryClient), null);
    assert.deepEqual(queryArgs, [{ type: 'private', userId: '456' }, queryId]);
  } finally {
    await queryClient.close();
  }
  /** @type {Awaited<ReturnType<typeof verifyHistoryQueryConsumer>>} */
  const historyQueryChecks = await verifyHistoryQueryConsumer(installedRoot);
  // Shared installed-package contracts use controlled services; native client initialization remains below.
  /** @type {Awaited<ReturnType<typeof verifyActionPortConsumer>>} */
  const actionPortChecks = await verifyActionPortConsumer(installedRoot);
  /** @type {Awaited<ReturnType<typeof verifyProfileRequestConsumer>>} */
  const profileRequestChecks = await verifyProfileRequestConsumer(installedRoot);
  /** @type {Awaited<ReturnType<typeof verifyGroupRequestConsumer>>} */
  const groupRequestChecks = await verifyGroupRequestConsumer(installedRoot);
  /** @type {Awaited<ReturnType<typeof verifyGroupNoticeConsumer>>} */
  const groupNoticeChecks = await verifyGroupNoticeConsumer(installedRoot);
  /** @type {Awaited<ReturnType<typeof verifyGroupSearchConsumer>>} */
  const groupSearchChecks = await verifyGroupSearchConsumer(installedRoot);
  /** @type {Awaited<ReturnType<typeof verifyGroupQueryOwnerConsumer>>} */
  const groupQueryOwnerChecks = await verifyGroupQueryOwnerConsumer(installedRoot);
  /** @type {Awaited<ReturnType<typeof verifyContactGroupSnapshots>>} */
  const contactGroupSnapshotChecks = await verifyContactGroupSnapshots(installedRoot);
  /** @type {Awaited<ReturnType<typeof verifyContactDirectoryLifetimeConsumer>>} */
  const contactDirectoryLifetimeChecks =
    await verifyContactDirectoryLifetimeConsumer(installedRoot);
  /** @type {Awaited<ReturnType<typeof verifyFeatureWaitRetirementConsumer>>} */
  const featureWaitRetirementChecks = await verifyFeatureWaitRetirementConsumer(installedRoot);
  /** @type {Awaited<ReturnType<typeof verifyGroupFileActionLifetimeConsumer>>} */
  const groupFileActionChecks = await verifyGroupFileActionLifetimeConsumer(installedRoot);
  /** @type {Awaited<ReturnType<typeof verifyRequestResultConsumer>>} */
  const requestResultChecks = await verifyRequestResultConsumer(installedRoot);
  /** @type {Awaited<ReturnType<typeof verifyQunWebConsumer>>} */
  const groupWebChecks = await verifyQunWebConsumer(installedRoot);
  // Query contract uses only synthetic listener services, never native QQ calls.
  const { createNativeServices: queryServices } =
    await /** @type {Promise<typeof import('../sdk/src/native-services.ts')>} */ (
      import(
        pathToFileURL(join(temp, 'node_modules/qq-native-client/dist/native-services.js')).href
      )
    );
  for (const [response, expectedCode] of [
    [{ errCode: 0, result: { finish: true, infos: new Map() } }, undefined],
    [{ errCode: 23, result: { finish: true, infos: new Map() } }, 23],
    [{ errCode: '23', result: { finish: true, infos: new Map() } }, '23'],
    [{ errCode: 0, result: { finish: false, infos: new Map() } }, 'incomplete-result'],
  ]) {
    let calls = 0;
    const query = queryServices({
      session: {
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getGroupService: () => ({
          addKernelGroupListener() {},
          /** @param {string} group @param {boolean} refresh */
          getAllMemberList(group, refresh) {
            calls++;
            assert.equal(group, '123');
            assert.equal(refresh, false);
            return response;
          },
        }),
      },
      version: '7.0.2-53644',
      events: { emit: () => {} },
    });
    try {
      if (expectedCode === undefined)
        assert.deepEqual(await query.invokeOperation('getGroupMembers', { groupId: '123' }), []);
      else
        await assert.rejects(query.invokeOperation('getGroupMembers', { groupId: '123' }), {
          code: expectedCode,
        });
      assert.equal(calls, 1);
    } finally {
      query.close();
    }
  }
  {
    const createNativeServices = queryServices;
    // Complete member identity/DTO validation and failure-cache isolation.
    const valid = {
      uid: 'u_member',
      uin: '900719925474099312345',
      nick: 'member',
      cardName: '',
      role: 2,
    };
    /** @param {unknown} infos */
    function membersFixture(infos) {
      return createNativeServices({
        session: {
          getMsgService: () => ({ addKernelMsgListener() {} }),
          getBuddyService: () => ({ addKernelBuddyListener() {} }),
          getGroupService: () => ({
            addKernelGroupListener() {},
            getAllMemberList() {
              return { errCode: 0, result: { finish: true, infos } };
            },
          }),
        },
        version: '7.0.2-53644',
        events: { emit: () => {} },
      });
    }
    for (const [key, member] of [
      ['u_member', { ...valid, uin: 456 }],
      [
        'u_member',
        {
          ...valid,
          uin: {
            toString() {
              throw Error('Coercion must not run');
            },
          },
        },
      ],
      ['u_member', { ...valid, uid: 'u_other' }],
      ['', { ...valid, uid: '' }],
      ['u_member', { ...valid, nick: { secret: true } }],
      ['u_member', { ...valid, cardName: 12 }],
      ['u_member', { ...valid, uid: undefined }],
      ['u_member', { ...valid, nick: undefined }],
      ['u_member', { ...valid, cardName: undefined }],
      ['u_member', { ...valid, role: '2' }],
      ['u_member', { ...valid, role: 0 }],
      ['u_member', { ...valid, role: 1 }],
    ]) {
      const query = membersFixture(new Map([[key, member]]));
      try {
        await assert.rejects(
          query.invokeOperation('getGroupMembers', { groupId: '123' }),
          /native group member/,
        );
      } finally {
        query.close();
      }
    }
    const roles = membersFixture(
      new Map([
        ['u_member', valid],
        ['u_admin', { ...valid, uid: 'u_admin', uin: '456', role: 3 }],
        ['u_owner', { ...valid, uid: 'u_owner', uin: '789', role: 4 }],
      ]),
    );
    try {
      assert.deepEqual(await roles.invokeOperation('getGroupMembers', { groupId: '123' }), [
        { userId: valid.uin, uid: 'u_member', nickname: 'member', card: '', role: 'member' },
        { userId: '456', uid: 'u_admin', nickname: 'member', card: '', role: 'admin' },
        { userId: '789', uid: 'u_owner', nickname: 'member', card: '', role: 'owner' },
      ]);
    } finally {
      roles.close();
    }
    let conversions = 0;
    const atomic = createNativeServices({
      session: {
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getGroupService: () => ({
          addKernelGroupListener() {},
          getAllMemberList() {
            return {
              errCode: 0,
              result: {
                finish: true,
                infos: new Map([
                  ['u_first', { ...valid, uid: 'u_first', uin: '456' }],
                  ['u_bad', { ...valid, uid: 'u_bad', role: 999 }],
                ]),
              },
            };
          },
        }),
        getUixConvertService: () => ({
          /** @param {string[]} ids */
          getUid(ids) {
            assert.deepEqual(ids, ['456']);
            conversions++;
            return { uidInfo: new Map() };
          },
        }),
      },
      version: '7.0.2-53644',
      events: { emit: () => {} },
    });
    try {
      await assert.rejects(
        atomic.invokeOperation('getGroupMembers', { groupId: '123' }),
        /Unknown native group member role/,
      );
      await assert.rejects(
        atomic.invokeOperation('sendPrivateMessage', { userId: '456', message: 'fixture' }),
        /Could not resolve user identifier/,
      );
      assert.equal(conversions, 1);
    } finally {
      atomic.close();
    }
  }
  // Installed metadata callbacks are normalized using fake events only.
  const { createGroupEvents } =
    await /** @type {Promise<typeof import('../sdk/src/features/groups/group-events.ts')>} */ (
      import(
        pathToFileURL(
          join(temp, 'node_modules/qq-native-client/dist/features/groups/group-events.js'),
        ).href
      )
    );
  /** @type {unknown[]} */
  const groupEvents = [];
  const groupListener = createGroupEvents((event, payload) => groupEvents.push([event, payload]));
  groupListener.onGroupListUpdate(3, [{ groupCode: '123' }]);
  assert.deepEqual(groupEvents.pop(), [
    'group-list-updated',
    { kind: 'removed', groups: [{ groupId: '123' }] },
  ]);
  groupListener.onMemberInfoChange(
    '123',
    1,
    new Map([['u_fixture', { uid: 'u_fixture', uin: '456', role: 3, isChangeRole: true }]]),
  );
  assert.deepEqual(groupEvents.pop(), [
    'group-members-updated',
    {
      groupId: '123',
      source: 'remote',
      members: [{ uid: 'u_fixture', userId: '456', role: 'admin', roleChanged: true }],
    },
  ]);
  groupListener.onGroupListUpdate(2, [
    { groupCode: '123', groupName: 'private fixture' },
    { groupCode: 'invalid' },
  ]);
  groupListener.onGroupListUpdate(2, Array(1));
  groupListener.onMemberInfoChange(
    '123',
    0,
    new Map([
      ['u_valid', { nick: 'private fixture' }],
      ['u_invalid', { role: 999 }],
    ]),
  );
  assert.deepEqual(groupEvents, [
    ['diagnostic', { stage: 'invalid-native-group-list-update' }],
    ['diagnostic', { stage: 'invalid-native-group-list-update' }],
    ['diagnostic', { stage: 'invalid-native-group-member-update' }],
  ]);
  assert.ok(!JSON.stringify(groupEvents).includes('private fixture'));
  const { observeWatchEvents } = await /** @type {Promise<typeof import('../sdk/src/cli.ts')>} */ (
    import(pathToFileURL(join(temp, 'node_modules/qq-native-client/dist/cli.js')).href)
  );
  const fakeWatch = new sdk.QQClient(Object.assign(new ChildProcess(), { exitCode: 0 }), 1000);
  /** @type {unknown[]} */
  const watchLines = [];
  try {
    const unwatch = observeWatchEvents(fakeWatch, 'all', (line) =>
      watchLines.push(JSON.parse(line)),
    );
    fakeWatch.emit('group-list-updated', { kind: 'removed', groups: [{ groupId: '123' }] });
    fakeWatch.emit('group-members-updated', { groupId: '123', source: 'remote', members: [] });
    Reflect.apply(fakeWatch.emit, fakeWatch, ['msf-status', { fixture: true }]);
    Reflect.apply(fakeWatch.emit, fakeWatch, ['authenticated', { fixture: true }]);
    assert.deepEqual(watchLines, [
      { event: 'group-list-updated', payload: { kind: 'removed', groups: [{ groupId: '123' }] } },
      {
        event: 'group-members-updated',
        payload: { groupId: '123', source: 'remote', members: [] },
      },
    ]);
    unwatch();
    fakeWatch.emit('group-list-updated', { kind: 'all', groups: [] });
    assert.equal(watchLines.length, 2);
  } finally {
    await fakeWatch.close();
  }
  {
    // Synthetic installed friend metadata and CLI contract.
    const { createFriendEvents } =
      await /** @type {Promise<typeof import('../sdk/src/features/contacts/friend-events.ts')>} */ (
        import(
          pathToFileURL(
            join(temp, 'node_modules/qq-native-client/dist/features/contacts/friend-events.js'),
          ).href
        )
      );
    const { observeWatchEvents: watchFriends } =
      await /** @type {Promise<typeof import('../sdk/src/cli.ts')>} */ (
        import(pathToFileURL(join(temp, 'node_modules/qq-native-client/dist/cli.js')).href)
      );
    /** @type {unknown[]} */
    const events = [];
    const listener = createFriendEvents((event, payload) => events.push([event, payload]));
    const expected = {
      categories: [
        {
          categoryId: 1,
          name: 'fixture',
          memberCount: 1,
          friends: [
            {
              uid: 'u_friend',
              userId: '900719925474099312345',
              nickname: 'friend',
              remark: 'remark',
            },
          ],
        },
      ],
    };
    listener.onBuddyListChange([
      {
        categoryId: 1,
        categoryName: 'fixture',
        categoryMbCount: 1,
        buddyList: [
          {
            uid: 'u_friend',
            uin: '900719925474099312345',
            nick: 'friend',
            remark: 'remark',
            secret: 'must-not-leak',
          },
        ],
        secret: 'must-not-leak',
      },
    ]);
    assert.deepEqual(events.pop(), ['friend-list-updated', expected]);
    listener.onBuddyListChange([
      { categoryId: 2, categoryName: 'empty', categoryMbCount: 0, buddyList: [] },
    ]);
    assert.deepEqual(events.pop(), [
      'friend-list-updated',
      { categories: [{ categoryId: 2, name: 'empty', memberCount: 0, friends: [] }] },
    ]);
    listener.onBuddyListChange([
      { categoryId: 1, categoryName: 'private', categoryMbCount: 0, buddyList: [] },
      { categoryId: 'bad', categoryName: 'bad', categoryMbCount: 0, buddyList: [] },
    ]);
    assert.deepEqual(events, [['diagnostic', { stage: 'invalid-native-friend-list-update' }]]);
    assert.ok(!JSON.stringify(events).includes('private'));
    const client = new sdk.QQClient(Object.assign(new ChildProcess(), { exitCode: 0 }), 1000);
    /** @type {unknown[]} */
    const lines = [];
    try {
      const cleanup = watchFriends(client, 'all', (line) => lines.push(JSON.parse(line)));
      client.emit('friend-list-updated', expected);
      assert.deepEqual(lines, [{ event: 'friend-list-updated', payload: expected }]);
      cleanup();
      client.emit('friend-list-updated', expected);
      assert.equal(lines.length, 1);
      /** @type {unknown[]} */
      const plain = [];
      const cleanDefault = watchFriends(client, undefined, (line) => plain.push(JSON.parse(line)));
      client.emit('friend-list-updated', expected);
      Reflect.apply(client.emit, client, ['message', { fixture: true }]);
      assert.deepEqual(plain, [{ fixture: true }]);
      cleanDefault();
    } finally {
      await client.close();
    }
  }
  /** @type {Awaited<ReturnType<typeof verifyFriendQueryConsumer>>} */
  const friendQueryChecks = await verifyFriendQueryConsumer(installedRoot);
  const contactObjectChecks = await verifyContactObjectsConsumer(installedRoot);
  const botApiChecks = await verifyBotApiConsumer(installedRoot);
  globalThis.fetch = () => {
    throw new Error('Unexpected mirror request with installed platform package');
  };
  client = await sdk.createClient({
    dataDir: join(temp, 'unused-account'),
    cacheDir: nativeCache,
    version: installedManifest.version,
    autoReconnect: false,
    timeoutMs: 30000,
  });
  const exports = client.nativeExports.length;
  if (exports < 80) throw new Error('Unexpected native export inventory');
  await client.close();
  if (client.state !== 'closed') throw new Error('Client did not close');
  await writeFile(
    'out/consumer.json',
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        exports,
        installedNativeStorage,
        workerBootstrapChecks,
        workerReadChecks,
        workerErrorChecks,
        clientFactoryChecks,
        contactGroupChecks,
        contactObjectChecks,
        botApiChecks,
        actionPortChecks,
        profileRequestChecks,
        groupRequestChecks,
        groupNoticeChecks,
        groupWebChecks,
        groupSearchChecks,
        groupQueryOwnerChecks,
        contactGroupSnapshotChecks,
        contactDirectoryLifetimeChecks,
        featureWaitRetirementChecks,
        requestResultChecks,
        groupFileActionChecks,
        ...messageBatchChecks,
        ...forwardChecks,
        ...recallChecks,
        ...mentionChecks,
        ...sendChecks,
        ...receivedChecks,
        ...receivedForwardChecks,
        ...forwardResourceChecks,
        ...historyLifecycleChecks,
        ...videoChecks,
        ...mergedForwardChecks,
        automaticVideoCodec: installedVideo !== undefined,
        installedVideoDecoder: installedVideo?.passed === true,
        installedVideoFakeCache: installedVideo?.sdkFakeCache === true,
        installedVideo,
        installedMainOnly: true,
        automaticPlatformSelection: true,
        explicitNativeVersion: installedManifest.version,
        tarballRequests,
        ...faceChecks,
        ...elementPreparationChecks,
        ...friendCategoryMutationChecks,
        messageQueryContract: true,
        historyQueryContract: historyQueryChecks.historyQueryContract,
        nativeHistoryQueryAttempted: historyQueryChecks.nativeHistoryQueryAttempted,
        nativeMessageQueryAttempted: false,
        selfProfileContract: true,
        profileMutationAttempted: false,
        groupOperationContract: true,
        groupMutationAttempted: false,
        groupMemberQueryContract: true,
        groupMemberIdentityContract: true,
        nativeGroupMemberQueryAttempted: false,
        groupMetadataEventContract: true,
        businessWatchContract: true,
        nativeGroupMetadataObserved: false,
        friendMetadataEventContract: true,
        nativeFriendMetadataObserved: false,
        friendListQueryContract: friendQueryChecks.friendListQueryContract,
        friendListBatchContract: friendQueryChecks.friendListBatchContract,
        friendProfileQueryContract: friendQueryChecks.friendProfileQueryContract,
        groupListQueryContract: friendQueryChecks.groupListQueryContract,
        nativeGroupListQueryAttempted: friendQueryChecks.nativeGroupListQueryAttempted,
        nativeFriendListQueryAttempted: friendQueryChecks.nativeFriendListQueryAttempted,
        prepared: true,
        closed: true,
        loginAttempted: false,
        registry: 'isolated local fixture serving actual CI tarballs',
      },
      null,
      2,
    ),
  );
  console.log(await readFile('out/consumer.json', 'utf8'));
} catch (error) {
  primary = { error };
} finally {
  await closeConsumerResources(
    {
      client,
      server: registry,
      removeDirectory: () => rm(temporary, { recursive: true, force: true }),
    },
    primary,
  );
}
