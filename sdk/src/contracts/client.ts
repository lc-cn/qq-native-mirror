import type { QQVersion } from './native.ts';

export type LoginRequest =
  { method: 'qr' } | { method: 'quick'; uin: string } | { method: 'restore'; uin?: string };

export interface ClientOptions {
  /** HTTPS native catalog; defaults to the project's GitHub mirror. */
  catalogUrl?: string;
  /** HTTPS proxy prefixes for native file URLs, e.g. https://proxy.example/. Original URL is the final fallback. */
  downloadMirrors?: string[];
  wrapperPath?: string;
  /** Complete native package manifest; relative file URLs resolve against this URL. */
  manifestUrl?: string;
  cacheDir?: string;
  /** Required trusted digest when fetching a manifest from a mirror. */
  manifestSha256?: string;
  bridgePath?: string;
  /** Libraries loaded globally before the QQ wrapper. Linux defaults to libgnutls.so.30. */
  preloadLibraries?: string[];
  dataDir: string;
  version?: QQVersion;
  device?: { hostname?: string; osVersion?: string };
  login?: LoginRequest;
  /** Explicit native password-retention setting; omitted leaves the native default unchanged. Not a guarantee of QR restoration. */
  rememberPassword?: boolean;
  /** Absolute executable paths for real video metadata and thumbnail generation. */
  mediaTools?: { ffmpeg: string; ffprobe: string };
  /** Optional local codec override; defaults to bundled silk-wasm for PCM16 WAV/Tencent SILK. */
  recordCodecPath?: string;
  /** Local video codec override; otherwise uses the verified native bundle's declaration. */
  videoCodecPath?: string;
  /** Positive Node timer duration in milliseconds (maximum 2147483647). */
  timeoutMs?: number;
  /** Restore only after a disconnect explicitly classified as retryable. Unknown failures and kicks never trigger automatic login. */
  autoReconnect?: boolean | { maxAttempts?: number; delayMs?: number };
}

export interface Account {
  uin: string;
  uid: string;
}

export type ClientState =
  'idle' | 'connecting' | 'online' | 'disconnected' | 'closing' | 'closed' | 'failed';

export interface OfflineInfo {
  source: 'login' | 'msf' | 'kicked';
  kind: 'unknown' | 'transport' | 'logout' | 'forced';
  retryable: boolean;
  args: unknown[];
  status?: number;
  reason?: number;
  code?: number | string;
  description?: string;
  kickedInfo?: unknown;
}
