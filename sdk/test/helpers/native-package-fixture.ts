import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { graph, label, sourceRoot } from './source-graph.ts';

/** Copy the package entry's static runtime closure without executing SDK code.
 * Fixtures supply installed platform packages separately; type imports and
 * external modules are not source files to copy. Resolve the whole closure
 * before writing so a missing relative dependency cannot yield a partial fixture.
 */
export async function copyNativePackageSource(destination: string): Promise<void> {
  const pending = [join(sourceRoot, 'native/native-package.ts')];
  const selected = new Set<string>();
  for (const file of pending) {
    if (selected.has(file)) continue;
    const dependencies = graph.get(file);
    if (!dependencies) throw new Error(`Native fixture source is absent: ${label(file)}`);
    selected.add(file);
    for (const edge of dependencies) {
      if (edge.typeOnly || !edge.specifier.startsWith('.')) continue;
      if (!edge.target)
        throw new Error(
          `Native fixture dependency is unresolved: ${label(file)} -> ${edge.specifier}`,
        );
      pending.push(edge.target);
    }
  }
  for (const file of selected) {
    const target = join(destination, relative(sourceRoot, file));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file, target);
  }
}
