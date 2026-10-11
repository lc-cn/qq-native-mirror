import { readNativeTarFiles } from './native-tar-files.mjs';
import { inspectNativeObjectMembers } from './native-object-members.mjs';
/** Per-validation snapshots: parse each archive once without a shell/tar executable. */
export async function readNativePackageMembers(path, cache = new Map()) {
  if (!cache.has(path))
    cache.set(
      path,
      (async () => {
        const files = await readNativeTarFiles(path),
          manifest = files.get('package/manifest.json');
        for (const key of ['package/manifest.json', 'package/package.json'])
          if ((files.get(key)?.length ?? 0) > 32 * 1024 * 1024)
            throw Error('Native metadata exceeds bound');
        const native = manifest ? JSON.parse(manifest) : undefined;
        const codec = native ? native.videoCodec : 'video/video-codec.node';
        const names = [
          'package/package.json',
          'package/manifest.json',
          'package/video/SOURCE-PROVENANCE.json',
          ...(typeof codec === 'string' ? ['package/' + codec] : []),
        ];
        const snapshot = new Map();
        for (const name of names) {
          const bytes = files.get(name);
          if (bytes) snapshot.set(name, Buffer.from(bytes));
        }
        if (native?.npmStorage !== undefined) {
          const original = inspectNativeObjectMembers(files, native, [
            'video/SOURCE-PROVENANCE.json',
            ...(typeof codec === 'string' ? [codec] : []),
          ]);
          for (const [name, bytes] of original) snapshot.set(name, bytes);
        }
        return snapshot;
      })(),
    );
  return cache.get(path);
}
