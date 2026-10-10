import { serializeKernelError } from './errors.ts';
import { constants } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { createKernel } from './kernel.ts';
import type { ClientOptions, LoginRequest } from './contracts/client.ts';
import { isServiceOperation } from './runtime/operations.ts';
import { lockDataDirectory } from './storage/data-directory-lock.ts';
import { loadRecordCodec } from './features/media/record-codec-loader.ts';
import { loadVideoCodec } from './features/media/video-codec-loader.ts';
import { builtinRecordCodec } from './features/media/builtin-record-codec.ts';
import { inspectNativeContracts } from './native/native-contracts.ts';

let kernel: ReturnType<typeof createKernel> | undefined;
let releaseDataLock: (() => void) | undefined;
process.on('exit', () => releaseDataLock?.());
process.on('message', async (message: unknown) => {
  const request = message as {
    id: number;
    method: string;
    options?: ClientOptions;
    login?: LoginRequest;
  };
  if (!request || typeof request.id !== 'number') return;
  const send = (value: unknown) => {
    if (process.connected) process.send?.(value);
  };
  let acquired = false;
  try {
    let result: unknown;
    if (request.method === 'init') {
      if (kernel || releaseDataLock) throw new Error('Native worker is already initialized');
      const options = request.options!;
      await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
      const release = lockDataDirectory(options.dataDir);
      releaseDataLock = release;
      acquired = true;
      const bridge: { exports: { preloadLibrary?: (path: string) => void } } = { exports: {} };
      if (options.bridgePath)
        process.dlopen(
          bridge,
          options.bridgePath,
          constants.dlopen.RTLD_NOW | constants.dlopen.RTLD_GLOBAL,
        );
      for (const library of options.preloadLibraries ??
        (process.platform === 'linux' ? ['libgnutls.so.30'] : [])) {
        if (!bridge.exports.preloadLibrary)
          throw new Error('Registration bridge does not support library preloading');
        bridge.exports.preloadLibrary(library);
      }
      const nativeContracts = await inspectNativeContracts(options.wrapperPath!, options.version);
      const native = { exports: {} };
      process.dlopen(native, options.wrapperPath!);
      const recordCodec =
        options.recordCodecPath === undefined
          ? builtinRecordCodec
          : await loadRecordCodec(options.recordCodecPath);
      const videoCodec =
        options.videoCodecPath === undefined
          ? undefined
          : await loadVideoCodec(options.videoCodecPath);
      kernel = createKernel(
        native.exports,
        {
          dataDir: options.dataDir,
          version: options.version!,
          device: options.device,
          loginTimeoutMs: options.timeoutMs,
          rememberPassword: options.rememberPassword,
          mediaTools: options.mediaTools,
          recordCodec,
          videoCodec,
          nativeContracts,
        },
        (event, payload) =>
          send({
            event,
            payload:
              payload instanceof Error
                ? { message: payload.message }
                : Buffer.isBuffer((payload as { image?: unknown })?.image)
                  ? {
                      ...(payload as object),
                      image: (payload as { image: Buffer }).image.toString('base64'),
                    }
                  : payload,
          }),
      );
      await kernel.prepare();
      result = { exports: Object.keys(native.exports) };
    } else if (request.method === 'login' && kernel) {
      result = await kernel.login(request.login!);
    } else if (isServiceOperation(request.method) && kernel) {
      const { id: _id, method, ...payload } = request;
      result = await kernel.invokeOperation(method, payload);
    } else if (request.method === 'close') {
      await kernel?.close();
      send({ id: request.id, result: null });
      process.exit(0);
    } else throw new Error(`Unknown kernel request: ${request.method}`);
    send({ id: request.id, result });
  } catch (error) {
    if (acquired && !kernel) {
      releaseDataLock?.();
      releaseDataLock = undefined;
    }
    send({ id: request.id, error: serializeKernelError(error) });
  }
});
process.on('disconnect', () => process.exit(0));
