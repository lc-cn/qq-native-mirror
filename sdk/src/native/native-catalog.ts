import type { ClientOptions } from '../contracts/client.ts';
import type { QQVersion } from '../contracts/native.ts';
import { readNativeResponse } from './native-response.ts';
export const DEFAULT_NATIVE_CATALOG =
  'https://raw.githubusercontent.com/lc-cn/qq-native-mirror/main/catalog.json';
export interface NativeCatalog {
  schemaVersion: 1;
  packages: Array<{
    platform: string;
    arch: string;
    version: QQVersion;
    manifestUrl: string;
    manifestSha256: string;
  }>;
}
function httpsUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid native catalog URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Native catalog requires HTTPS without credentials');
  return url.href;
}
function order(value: string): number[] {
  if (!/^\d+(?:\.\d+)*(?:-\d+)?$/.test(value)) throw new Error('Invalid catalog clientVersion');
  const parts = value.split(/[.-]/).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part)))
    throw new Error('Invalid catalog clientVersion');
  return parts;
}
export function selectNativePackage(
  catalog: NativeCatalog,
  platform: string,
  arch: string,
  requested?: QQVersion,
) {
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.packages))
    throw new Error('Invalid native catalog');
  if (
    catalog.packages.some(
      (p) =>
        !p || typeof p !== 'object' || typeof p.platform !== 'string' || typeof p.arch !== 'string',
    )
  )
    throw new Error('Invalid native catalog package');
  const matches = catalog.packages.filter(
    (p) =>
      p.platform === platform &&
      p.arch === arch &&
      (!requested || p.version?.clientVersion === requested.clientVersion),
  );
  for (const p of matches) {
    order(p.version?.clientVersion);
    if (
      typeof p.version.appId !== 'string' ||
      !p.version.appId ||
      typeof p.version.qua !== 'string' ||
      !p.version.qua ||
      typeof p.manifestSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(p.manifestSha256)
    )
      throw new Error('Invalid catalog package');
    httpsUrl(p.manifestUrl);
  }
  matches.sort((a, b) => {
    const x = order(a.version.clientVersion),
      y = order(b.version.clientVersion);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const delta = (y[i] ?? 0) - (x[i] ?? 0);
      if (delta) return delta;
    }
    return 0;
  });
  if (!matches.length) throw new Error(`No native package for ${platform}/${arch}`);
  const selected = matches[0]!;
  if (
    matches.some(
      (p) => p !== selected && p.version.clientVersion === selected.version.clientVersion,
    )
  )
    throw new Error('Ambiguous native catalog version');
  return selected;
}
export async function resolveNativeCatalog(options: ClientOptions): Promise<ClientOptions> {
  const url = httpsUrl(options.catalogUrl ?? DEFAULT_NATIVE_CATALOG);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  const body = (
    await readNativeResponse(response, {
      maxBytes: 1024 * 1024,
      errors: {
        http: (status) => `Native catalog unavailable: HTTP ${status}`,
        empty: () => 'Native catalog response is empty',
        tooLarge: 'Native catalog too large',
      },
    })
  ).toString('utf8');
  const selected = selectNativePackage(
    JSON.parse(body),
    process.platform,
    process.arch,
    options.version,
  );
  return {
    ...options,
    version: options.version ?? selected.version,
    manifestUrl: selected.manifestUrl,
    manifestSha256: selected.manifestSha256,
  };
}
