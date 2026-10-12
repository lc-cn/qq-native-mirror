// Compatibility exports for existing internal contract consumers. Protocols own
// their result decoding; group-files owns capability gates and action lifetime.
export { getGroupFileCount } from './group-file-count.ts';
export type { GroupFileCountContext } from './group-file-count.ts';
export { createGroupFolder, deleteGroupFolder } from './group-folder-operations.ts';
export type {
  GroupFolderCreationContext,
  GroupFolderDeletionContext,
  GroupFolderDeletionContext as GroupFileContext,
} from './group-folder-operations.ts';
