import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, constants } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkerBootstrap } from '../src/worker/bootstrap.ts';

for (const withBridge of [false, true]) {
  test(`Node bootstrap preserves dlopen argument arity ${withBridge ? 'with bridge' : 'without bridge'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'bootstrap-adapter-'));
    const bootstrap = createWorkerBootstrap(() => {});
    const original = process.dlopen;
    const calls: { path: string; argc: number; flags: number | undefined }[] = [];
    const stoppedBeforeNative = new Error('Controlled wrapper boundary');
    const wrapperPath = join(root, 'unused-wrapper.node');
    const bridgePath = join(root, 'unused-bridge.node');
    try {
      process.dlopen = function (_target, path, flags) {
        calls.push({ path, argc: arguments.length, flags });
        if (path === wrapperPath) throw stoppedBeforeNative;
      };
      await assert.rejects(
        bootstrap.initialize({
          dataDir: join(root, 'data'),
          wrapperPath,
          bridgePath: withBridge ? bridgePath : undefined,
          preloadLibraries: [],
          version: { clientVersion: 'fixture', appId: 'fixture', qua: 'fixture' },
        }),
        (error: unknown) => error === stoppedBeforeNative,
      );
      assert.deepEqual(calls, [
        ...(withBridge
          ? [
              {
                path: bridgePath,
                argc: 3,
                flags: constants.dlopen.RTLD_NOW | constants.dlopen.RTLD_GLOBAL,
              },
            ]
          : []),
        { path: wrapperPath, argc: 2, flags: undefined },
      ]);
    } finally {
      process.dlopen = original;
      bootstrap.releaseOnExit();
      await rm(root, { recursive: true, force: true });
    }
  });
}
