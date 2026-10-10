export interface QQVersion {
  clientVersion: string;
  appId: string;
  qua: string;
}

export interface NativeManifest {
  /** Required for a bundle that uses a Node internal-ABI adapter. */
  nodeVersion?: string;
  nodeConfigSha256?: string;
  schemaVersion: 1;
  id: string;
  platform: NodeJS.Platform;
  arch: string;
  wrapper: string;
  /** Optional bundled video addon/module, covered by the same files SHA-256 inventory. */
  videoCodec?: string;
  npmStorage?: {
    format: 'gzip-objects-v1';
    objects: Array<{
      path: string;
      sha256: string;
      downloadSha256: string;
      size: number;
      downloadSize: number;
    }>;
  };
  version: QQVersion;
  files: Array<{
    path: string;
    url: string;
    sha256: string;
    size?: number;
    encoding?: 'gzip';
    downloadSha256?: string;
  }>;
}

export interface NativeCallbackAudit {
  family: string;
  name: string;
  argumentTypes: string[];
  count: number;
}
