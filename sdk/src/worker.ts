import { serializeKernelError } from './errors.ts';
import { constants } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { createKernel } from './kernel.ts';
import type { ClientOptions, LoginRequest } from './types.ts';
import type { ServiceOperation } from './native-services.ts';
import { lockDataDirectory } from './data-directory-lock.ts';
import { loadRecordCodec } from './record-codec-loader.ts';
import { loadVideoCodec } from './video-codec-loader.ts';
import { builtinRecordCodec } from './builtin-record-codec.ts';

const operations = new Set(['listFriends', 'listFriendCategories', 'listGroups', 'getGroupInfo', 'getGroupMembers', 'sendPrivateMessage', 'sendGroupMessage', 'sendMergedForward', 'getMessage', 'getMessages', 'getHistory', 'recallMessage', 'getForwardMessages', 'getForwardResource', 'forwardMessages',
  'setGroupName', 'setGroupRemark', 'setGroupMute', 'setGroupMemberMute', 'setGroupMemberCard', 'setGroupAdmin', 'kickGroupMember', 'leaveGroup',
  'setNickname', 'setSignature', 'listGroupNotices', 'publishGroupNotice', 'deleteGroupNotice', 'downloadAttachment', 'getUserProfile', 'setFriendRemark', 'deleteFriend', 'listFriendRequests', 'handleFriendRequest', 'listGroupRequests', 'handleGroupRequest']);

let kernel: ReturnType<typeof createKernel> | undefined;
let releaseDataLock: (() => void) | undefined;
process.on('exit', () => releaseDataLock?.());
process.on('message', async (message: unknown) => {
  const request = message as { id: number; method: string; options?: ClientOptions; login?: LoginRequest };
  if (!request || typeof request.id !== 'number') return;
  const send = (value: unknown) => { if (process.connected) process.send?.(value); };
  let acquired = false;
  try {
    let result: unknown;
    if (request.method === 'init') {
      if (kernel || releaseDataLock) throw new Error('Native worker is already initialized');
      const options = request.options!;
      await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
      const release = lockDataDirectory(options.dataDir);
      releaseDataLock = release; acquired = true;
      const bridge: { exports: { preloadLibrary?: (path: string) => void } } = { exports: {} };
      if (options.bridgePath) process.dlopen(bridge, options.bridgePath, constants.dlopen.RTLD_NOW | constants.dlopen.RTLD_GLOBAL);
      for (const library of options.preloadLibraries ?? (process.platform === 'linux' ? ['libgnutls.so.30'] : [])) {
        if (!bridge.exports.preloadLibrary) throw new Error('Registration bridge does not support library preloading');
        bridge.exports.preloadLibrary(library);
      }
      const native = { exports: {} };
      process.dlopen(native, options.wrapperPath!);
      const recordCodec = options.recordCodecPath === undefined ? builtinRecordCodec : await loadRecordCodec(options.recordCodecPath);
      const videoCodec = options.videoCodecPath === undefined ? undefined : await loadVideoCodec(options.videoCodecPath);
      kernel = createKernel(native.exports, { dataDir: options.dataDir, version: options.version!, device: options.device, loginTimeoutMs: options.timeoutMs, rememberPassword: options.rememberPassword, mediaTools: options.mediaTools, recordCodec, videoCodec },
        (event, payload) => send({ event, payload: payload instanceof Error ? { message: payload.message } : Buffer.isBuffer((payload as { image?: unknown })?.image)
          ? { ...(payload as object), image: (payload as { image: Buffer }).image.toString('base64') } : payload }));
      await kernel.prepare();
      result = { exports: Object.keys(native.exports) };
    } else if (request.method === 'login' && kernel) {
      result = await kernel.login(request.login!);
    } else if (operations.has(request.method) && kernel) {
      const { id: _id, method, ...payload } = request;
      result = await kernel.invokeOperation(method as ServiceOperation, payload);
    } else if (request.method === 'close') {
      await kernel?.close();
      send({ id: request.id, result: null });
      process.exit(0);
    } else throw new Error(`Unknown kernel request: ${request.method}`);
    send({ id: request.id, result });
  } catch (error) {
    if (acquired && !kernel) { releaseDataLock?.(); releaseDataLock = undefined; }
    send({ id: request.id, error: serializeKernelError(error) });
  }
});
process.on('disconnect', () => process.exit(0));
