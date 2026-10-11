import { createGroupFilePages, type GroupFilePagesContext } from './group-file-pages.ts';
import { FeatureLifetime } from '../../runtime/feature-lifetime.ts';
import type { GroupFolder } from '../../contracts/groups.ts';
import {
  captureCreateGroupFolder,
  captureDeleteGroupFolder,
  captureDeleteGroupFile,
  captureGroupFileCount,
  captureGroupFilePage,
  captureGroupFileList,
} from './group-file-input.ts';
import { createGroupFolder, deleteGroupFolder } from './group-folder-operations.ts';
import { getGroupFileCount } from './group-file-count.ts';
import { deleteGroupFile, type GroupFileDeletionContext } from './group-file-deletion.ts';
import type { GroupFileCountContext } from './group-file-count.ts';
import type {
  GroupFolderDeletionContext,
  GroupFolderCreationContext,
} from './group-folder-operations.ts';

export interface GroupFilesContext {
  readonly signal: AbortSignal;
  readonly getFileCountService: GroupFileCountContext['getRichMediaService'];
  readonly getFolderCreationService: GroupFolderCreationContext['getRichMediaService'];
  readonly getFolderDeletionService: GroupFolderDeletionContext['getRichMediaService'];
  readonly awaitAlive: <T>(value: T | PromiseLike<T>, requestSignal?: AbortSignal) => Promise<T>;
  /** Composition binds these decisions to the worker's measured binary profile. */
  readonly getFilePageService?: GroupFilePagesContext['getFilePageService'];
  readonly supportsFilePage?: GroupFilePagesContext['supportsFilePage'];
  readonly history?: GroupFilePagesContext['history'];
  readonly supportsFileCount: () => boolean;
  readonly supportsFolderCreation: () => boolean;
  readonly supportsFolderDeletion: () => boolean;
  readonly getFileDeletionService?: GroupFileDeletionContext['getRichMediaService'];
  readonly supportsFileDeletion?: () => boolean;
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
 * Existing mutation adapters retain acknowledgement policy. The page owner
 * owns cancellable correlation while its token history survives account close.
 */
export function createGroupFiles(context: GroupFilesContext) {
  const { signal, awaitAlive } = context;
  let closed = false;
  const actions = new FeatureLifetime({
    signal,
    awaitAlive,
    closedMessage: 'Group file actions are closed',
  });
  const { signal: actionSignal, wait: waitForAction } = actions;
  const requireActionContract = (support: () => boolean, operation: string) => {
    actionSignal.throwIfAborted();
    const supported = support.call(context);
    actionSignal.throwIfAborted();
    requireContract(supported, operation);
  };
  const pageAlive = (requestSignal?: AbortSignal) => {
    signal.throwIfAborted();
    requestSignal?.throwIfAborted();
    if (closed) throw new Error('Group file page owner is closed');
  };
  const pages =
    context.history && context.getFilePageService
      ? createGroupFilePages({
          signal,
          history: context.history,
          getFilePageService: context.getFilePageService,
          supportsFilePage: context.supportsFilePage ?? (() => false),
        })
      : undefined;
  return {
    async getGroupFilePage(groupId: unknown, options?: unknown, requestSignal?: AbortSignal) {
      if (pages) {
        const page = await pages.getGroupFilePage(groupId, options, requestSignal);
        pageAlive(requestSignal);
        return page;
      }
      captureGroupFilePage(groupId, options);
      requireContract(false, 'Group file page');
      throw new Error('Group file page owner unavailable');
    },
    async listGroupFiles(groupId: unknown, options?: unknown, requestSignal?: AbortSignal) {
      if (pages) {
        const items = await pages.listGroupFiles(groupId, options, requestSignal);
        pageAlive(requestSignal);
        return items;
      }
      captureGroupFileList(groupId, options);
      requireContract(false, 'Group file page');
      throw new Error('Group file page owner unavailable');
    },
    receiveFileInfo(raw: unknown) {
      pages?.receiveFileInfo(raw);
    },
    close() {
      if (closed) return;
      closed = true;
      actions.close();
      pages?.close();
    },
    async getGroupFileCount(groupId: unknown): Promise<number> {
      const captured = captureGroupFileCount(groupId);
      requireActionContract(context.supportsFileCount, 'Group file count');
      return getGroupFileCount(
        {
          signal: actionSignal,
          awaitAlive: waitForAction,
          getRichMediaService: context.getFileCountService,
        },
        captured.groupId,
      );
    },
    async createGroupFolder(groupId: unknown, name: unknown): Promise<GroupFolder> {
      const captured = captureCreateGroupFolder(groupId, name);
      requireActionContract(context.supportsFolderCreation, 'Group folder creation');
      return createGroupFolder(
        {
          signal: actionSignal,
          awaitAlive: waitForAction,
          getRichMediaService: context.getFolderCreationService,
        },
        captured.groupId,
        captured.name,
      );
    },
    async deleteGroupFolder(groupId: unknown, folderId: unknown): Promise<void> {
      const captured = captureDeleteGroupFolder(groupId, folderId);
      requireActionContract(context.supportsFolderDeletion, 'Group folder deletion');
      return deleteGroupFolder(
        {
          signal: actionSignal,
          awaitAlive: waitForAction,
          getRichMediaService: context.getFolderDeletionService,
        },
        captured.groupId,
        captured.folderId,
      );
    },
    async deleteGroupFile(groupId: unknown, fileId: unknown): Promise<void> {
      const captured = captureDeleteGroupFile(groupId, fileId);
      requireActionContract(context.supportsFileDeletion ?? (() => false), 'Group file deletion');
      return deleteGroupFile(
        {
          signal: actionSignal,
          awaitAlive: waitForAction,
          getRichMediaService: () => {
            const acquire = context.getFileDeletionService;
            actionSignal.throwIfAborted();
            if (typeof acquire !== 'function')
              throw new Error('Group file deletion service unavailable');
            return acquire.call(context);
          },
        },
        captured.groupId,
        captured.fileId,
      );
    },
  };
}
