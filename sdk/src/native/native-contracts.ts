import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Internal worker provenance computed from the binary, never ClientOptions. */
export interface NativeContractProfile {
  readonly platform: string;
  readonly arch: string;
  readonly clientVersion: string;
  readonly wrapperSha256: string;
}

type NativeCapability =
  | 'categoryCreation'
  | 'groupFileCount'
  | 'groupSearch'
  | 'groupFolderDeletion'
  | 'groupFolderCreation';
type BinaryContract = readonly [
  platform: string,
  arch: string,
  version: string,
  sha256: string,
  capabilities: readonly NativeCapability[],
];

// Each row binds measured binary provenance to independently inspected contracts.
// Adding a new binary requires its own capability list; a known version or
// another feature's evidence never grants an unlisted native operation.
// Evidence: friend-category-create, group-file-count, group-search and
// group-folder contract records under docs/evidence/.
const binaryProfiles: readonly BinaryContract[] = [
  [
    'linux',
    'x64',
    '3.2.32-52194',
    '7882b8e3055cd38584861042befacd8be9939896f5cbbca6fa4a230926b48526',
    [
      'categoryCreation',
      'groupFileCount',
      'groupSearch',
      'groupFolderDeletion',
      'groupFolderCreation',
    ],
  ],
  [
    'linux',
    'arm64',
    '3.2.32-52194',
    'c302361f52494de257044e912e43ed244bb29ee59f59345d25a8959327828337',
    [
      'categoryCreation',
      'groupFileCount',
      'groupSearch',
      'groupFolderDeletion',
      'groupFolderCreation',
    ],
  ],
  [
    'darwin',
    'arm64',
    '7.0.2-53644',
    'fbc8ad9b328d05e16784d76b0181dda894c17001179dbf8c0d5dd00dc6271358',
    [
      'categoryCreation',
      'groupFileCount',
      'groupSearch',
      'groupFolderDeletion',
      'groupFolderCreation',
    ],
  ],
  [
    'darwin',
    'x64',
    '7.0.2-53644',
    'e91c58872d3d498f2d3ac1c304ab3ae4602d016274cf3e0f0cb651ad765f1f54',
    [
      'categoryCreation',
      'groupFileCount',
      'groupSearch',
      'groupFolderDeletion',
      'groupFolderCreation',
    ],
  ],
  [
    'win32',
    'x64',
    '9.9.33-52230',
    '63112ab9161e127f5f7e17998a7196e143808923fb54cbbf7b4e21426187a5f0',
    [
      'categoryCreation',
      'groupFileCount',
      'groupSearch',
      'groupFolderDeletion',
      'groupFolderCreation',
    ],
  ],
  [
    'win32',
    'arm64',
    '9.9.33-52230',
    '54e5a6ce127a1f973f28e38ddfbf1338403ea323a141546a6578dd25332c928a',
    [
      'categoryCreation',
      'groupFileCount',
      'groupSearch',
      'groupFolderDeletion',
      'groupFolderCreation',
    ],
  ],
];

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
    !binaryProfiles.some(
      ([platform, arch, tag]) =>
        platform === process.platform && arch === process.arch && tag === clientVersion,
    )
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

function matchesContract(
  profile: NativeContractProfile | undefined,
  version: string,
  capability: NativeCapability,
): boolean {
  return (
    !!profile &&
    profile.clientVersion === version &&
    binaryProfiles.some(
      ([platform, arch, tag, sha, capabilities]) =>
        platform === profile.platform &&
        arch === profile.arch &&
        tag === profile.clientVersion &&
        sha === profile.wrapperSha256 &&
        capabilities.includes(capability),
    )
  );
}

export function supportsCategoryCreation(
  profile: NativeContractProfile | undefined,
  version: string,
): boolean {
  return matchesContract(profile, version, 'categoryCreation');
}

export function supportsGroupFileCount(
  profile: NativeContractProfile | undefined,
  version: string,
): boolean {
  return matchesContract(profile, version, 'groupFileCount');
}

export function supportsGroupSearch(
  profile: NativeContractProfile | undefined,
  version: string,
): boolean {
  return matchesContract(profile, version, 'groupSearch');
}

export function supportsGroupFolderDeletion(
  profile: NativeContractProfile | undefined,
  version: string,
): boolean {
  return matchesContract(profile, version, 'groupFolderDeletion');
}

export function supportsGroupFolderCreation(
  profile: NativeContractProfile | undefined,
  version: string,
): boolean {
  return matchesContract(profile, version, 'groupFolderCreation');
}
