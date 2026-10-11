import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { hasNativeContractVersion, type NativeContractProfile } from './native-contracts.ts';

/** Measure the selected wrapper in the worker host; caller metadata cannot
 * substitute its platform or digest. Unknown versions acquire no file handle. */
export async function inspectNativeContracts(
  wrapperPath: string,
  version: unknown,
): Promise<NativeContractProfile | undefined> {
  const clientVersion =
    version && typeof version === 'object'
      ? (version as { clientVersion?: unknown }).clientVersion
      : undefined;
  if (
    typeof clientVersion !== 'string' ||
    !hasNativeContractVersion(process.platform, process.arch, clientVersion)
  )
    return;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(wrapperPath)) hash.update(chunk);
  return Object.freeze({
    platform: process.platform,
    arch: process.arch,
    clientVersion,
    wrapperSha256: hash.digest('hex'),
  });
}
