import type { GroupFolder } from '../../contracts/groups.ts';
import {
  captureCreateGroupFolder,
  captureDeleteGroupFolder,
  captureGroupFileCount,
} from './group-file-input.ts';
import {
  createGroupFolder,
  deleteGroupFolder,
  getGroupFileCount,
} from './group-file-operations.ts';
import type {
  GroupFileContext,
  GroupFileCountContext,
  GroupFolderCreationContext,
} from './group-file-operations.ts';

export interface GroupFilesContext {
  readonly signal: AbortSignal;
  readonly getFileCountService: GroupFileCountContext['getRichMediaService'];
  readonly getFolderCreationService: GroupFolderCreationContext['getRichMediaService'];
  readonly getFolderDeletionService: GroupFileContext['getRichMediaService'];
  readonly awaitAlive: GroupFileContext['awaitAlive'];
  /** Composition binds these decisions to the worker's measured binary profile. */
  readonly supportsFileCount: () => boolean;
  readonly supportsFolderCreation: () => boolean;
  readonly supportsFolderDeletion: () => boolean;
}

function requireContract(supported: boolean, operation: string): void {
  if (!supported)
    throw Object.assign(new Error(`${operation} contract is not verified for this native binary`), {
      code: 'unsupported-native-contract',
    });
}

/** Own group-file dispatch policy behind named operations. Validate and capture
 * inputs before checking provenance or acquiring a native method. The injected
 * ports remain lazy and operation-specific; this owner cannot access a Session.
 * Account cancellation and native acknowledgement remain with the existing
 * operation adapters, so this layer introduces no retry or second lifetime.
 */
export function createGroupFiles(context: GroupFilesContext) {
  const { signal, awaitAlive } = context;
  return {
    async getGroupFileCount(groupId: unknown): Promise<number> {
      const captured = captureGroupFileCount(groupId);
      requireContract(context.supportsFileCount(), 'Group file count');
      return getGroupFileCount(
        { signal, awaitAlive, getRichMediaService: context.getFileCountService },
        captured.groupId,
      );
    },
    async createGroupFolder(groupId: unknown, name: unknown): Promise<GroupFolder> {
      const captured = captureCreateGroupFolder(groupId, name);
      requireContract(context.supportsFolderCreation(), 'Group folder creation');
      return createGroupFolder(
        { signal, awaitAlive, getRichMediaService: context.getFolderCreationService },
        captured.groupId,
        captured.name,
      );
    },
    async deleteGroupFolder(groupId: unknown, folderId: unknown): Promise<void> {
      const captured = captureDeleteGroupFolder(groupId, folderId);
      requireContract(context.supportsFolderDeletion(), 'Group folder deletion');
      return deleteGroupFolder(
        { signal, awaitAlive, getRichMediaService: context.getFolderDeletionService },
        captured.groupId,
        captured.folderId,
      );
    },
  };
}
