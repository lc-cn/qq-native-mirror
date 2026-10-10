import { constants } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { createKernel } from '../kernel.ts';
import { lockDataDirectory } from '../storage/data-directory-lock.ts';
import { loadRecordCodec } from '../features/media/record-codec-loader.ts';
import { loadVideoCodec } from '../features/media/video-codec-loader.ts';
import { builtinRecordCodec } from '../features/media/builtin-record-codec.ts';
import { inspectNativeContracts } from '../native/native-contracts.ts';
import { NativeWorkerBootstrap } from './native-bootstrap.ts';

/** Bind Node acquisition ports once; the IPC entry never loads native addons. */
export function createWorkerBootstrap(emit: (event: string, payload: unknown) => void) {
  return new NativeWorkerBootstrap(
    {
      createDataDirectory: (path) => mkdir(path, { recursive: true, mode: 0o700 }),
      lockDataDirectory,
      loadAddon: (target, path, flags) => process.dlopen(target, path, flags),
      globalLoadFlags: constants.dlopen.RTLD_NOW | constants.dlopen.RTLD_GLOBAL,
      defaultPreloadLibraries: process.platform === 'linux' ? ['libgnutls.so.30'] : [],
      inspectNativeContracts,
      builtinRecordCodec,
      loadRecordCodec,
      loadVideoCodec,
      createKernel,
    },
    emit,
  );
}
