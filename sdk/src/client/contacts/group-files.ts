import type {
  GroupFileEntry,
  GroupFileListOptions,
  GroupFilePage,
  GroupFilePageOptions,
  GroupFolder,
} from '../../contracts/groups.ts';
import {
  captureCreateGroupFolder,
  captureDeleteGroupFile,
  captureDeleteGroupFolder,
  captureGroupFileCount,
  captureGroupFileList,
  captureGroupFilePage,
} from '../../features/groups/files/group-file-input.ts';
import { sendGroupId } from '../../validation/identifiers.ts';
import type { ContactContext } from './contact-context.ts';

/** Group files and folders bound to the session that selected their group.
 * Operations retain the existing native capability and acknowledgement semantics.
 */
export class GroupFiles {
  readonly groupId: string;
  readonly #context: ContactContext;

  /** @internal Constructed by GroupContact with its captured session context. */
  constructor(context: ContactContext, groupId: string) {
    this.#context = context;
    this.groupId = sendGroupId(groupId);
    Object.freeze(this);
  }

  async count(): Promise<number> {
    this.#context.assertActive();
    return this.#context.invoke('getGroupFileCount', captureGroupFileCount(this.groupId));
  }

  /** Read one correlated native page; this does not promise an atomic snapshot. */
  async getPage(options: GroupFilePageOptions = {}): Promise<GroupFilePage> {
    this.#context.assertActive();
    const captured = captureGroupFilePage(this.groupId, options);
    return this.#context.invoke('getGroupFilePage', {
      groupId: captured.groupId,
      options: captured.params,
    });
  }

  /** Traverse from zero to the end marker; an exhausted page budget rejects. */
  async list(options: GroupFileListOptions = {}): Promise<GroupFileEntry[]> {
    this.#context.assertActive();
    const captured = captureGroupFileList(this.groupId, options);
    const { startIndex: _startIndex, ...params } = captured.params;
    return this.#context.invoke('listGroupFiles', {
      groupId: captured.groupId,
      options: { ...params, maxPages: captured.maxPages },
    });
  }

  /** Submit once and return the native folder snapshot; no readback is implied. */
  async createFolder(name: string): Promise<GroupFolder> {
    this.#context.assertActive();
    return this.#context.invoke('createGroupFolder', captureCreateGroupFolder(this.groupId, name));
  }

  /** Submit once. An uncertain result is never automatically retried. */
  async deleteFolder(folderId: string): Promise<void> {
    this.#context.assertActive();
    return this.#context.invoke(
      'deleteGroupFolder',
      captureDeleteGroupFolder(this.groupId, folderId),
    );
  }

  /** Return the native per-file acknowledgement; disappearance needs readback. */
  async deleteFile(fileId: string): Promise<void> {
    this.#context.assertActive();
    return this.#context.invoke('deleteGroupFile', captureDeleteGroupFile(this.groupId, fileId));
  }
}
