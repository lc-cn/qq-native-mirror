import { captureGroupRequestOperation } from '../../features/groups/group-request-input.ts';
import { resolve } from 'node:path';
import { captureGroupOperation } from '../../features/groups/group-operation-input.ts';
import { captureGroupSearch } from '../../features/groups/group-search-input.ts';
import {
  captureCreateGroupFolder,
  captureDeleteGroupFolder,
  captureDeleteGroupFile,
  captureGroupFileCount,
  captureGroupFilePage,
  captureGroupFileList,
} from '../../features/groups/group-file-input.ts';
import {
  captureGroupEssenceRequest,
  captureGroupEssencePage,
  captureGroupEssenceList,
} from '../../features/groups/group-essence-input.ts';
import { required, numeric, bool } from '../command-input.ts';
import type {
  ClientCommandDefinition,
  ClientCommandAction,
  CommandFlags,
} from '../command-contracts.ts';

/** Groups CLI plans use the public client and shared domain input rules. */
export const groupsCommands = {
  groups: {
    flags: ['config', 'uin'],
    prepare() {
      return (client) => client.listGroups();
    },
  },
  members: {
    flags: ['config', 'uin', 'group-id'],
    prepare(flags) {
      const groupId = numeric(flags, 'group-id');
      return (client) => client.getGroupMembers(groupId);
    },
  },
  'group-requests': {
    flags: ['config', 'uin', 'doubt', 'limit', 'before'],
    prepare(flags) {
      const limit = flags.limit === undefined ? 20 : Number(numeric(flags, 'limit'));
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error('--limit must be an integer between 1 and 100');
      const options = {
        limit,
        doubt: bool(flags, 'doubt', false),
        ...(flags.before !== undefined ? { before: numeric(flags, 'before') } : {}),
      };
      const input = captureGroupRequestOperation('listGroupRequests', { options }).payload;
      return (client) => client.listGroupRequests(input.options);
    },
  },
  'group-request': {
    flags: ['config', 'uin', 'group-id', 'sequence', 'type', 'accept', 'doubt', 'reason'],
    prepare(flags) {
      const type = Number(numeric(flags, 'type'));
      if (type !== 1 && type !== 5 && type !== 7) throw new Error('--type must be 1, 5 or 7');
      const request: { groupId: string; sequence: string; type: 1 | 5 | 7; doubt: boolean } = {
        groupId: numeric(flags, 'group-id'),
        sequence: numeric(flags, 'sequence'),
        type,
        doubt: bool(flags, 'doubt', false),
      };
      const accept = bool(flags, 'accept');
      const input = captureGroupRequestOperation('handleGroupRequest', {
        request,
        accept,
        reason: flags.reason,
      }).payload;
      return (client) => client.handleGroupRequest(input.request, input.accept, input.reason);
    },
  },
  'group-muted': {
    flags: ['config', 'uin', 'group-id'],
    prepare(flags) {
      const groupId = numeric(flags, 'group-id');
      return (client) => client.listGroupMutedMembers(groupId);
    },
  },
  'group-info': {
    flags: ['config', 'uin', 'group-id'],
    prepare(flags) {
      const groupId = numeric(flags, 'group-id');
      return (client) => client.getGroupInfo(groupId);
    },
  },
  'group-name': {
    flags: ['config', 'uin', 'group-id', 'name'],
    prepare(flags) {
      const group = numeric(flags, 'group-id');
      const name = required(flags, 'name');
      if (!name.trim()) throw new Error('--name must not be blank');
      const input = captureGroupOperation('setGroupName', { groupId: group, name }).payload;
      return (client) => client.setGroupName(input.groupId, input.name);
    },
  },
  'group-search': {
    flags: ['config', 'uin', 'group-id'],
    prepare(flags) {
      const group = captureGroupSearch(required(flags, 'group-id'));
      return (client) => client.searchGroup(group);
    },
  },
  'group-file-count': {
    flags: ['config', 'uin', 'group-id'],
    prepare(flags) {
      const captured = captureGroupFileCount(required(flags, 'group-id'));
      return (client) => client.getGroupFileCount(captured.groupId);
    },
  },
  'group-file-list': {
    flags: [
      'config',
      'uin',
      'group-id',
      'folder-id',
      'sort-type',
      'file-count',
      'start-index',
      'sort-order',
      'show-onlinedoc-folder',
    ],
    prepare: (flags) => prepareGroupFiles(flags, false),
  },
  'group-file-all': {
    flags: [
      'config',
      'uin',
      'group-id',
      'folder-id',
      'sort-type',
      'file-count',
      'sort-order',
      'show-onlinedoc-folder',
      'max-pages',
    ],
    prepare: (flags) => prepareGroupFiles(flags, true),
  },
  'group-folder-create': {
    flags: ['config', 'uin', 'group-id', 'name'],
    prepare(flags) {
      const captured = captureCreateGroupFolder(
        required(flags, 'group-id'),
        required(flags, 'name'),
      );
      return (client) => client.createGroupFolder(captured.groupId, captured.name);
    },
  },
  'group-folder-delete': {
    flags: ['config', 'uin', 'group-id', 'folder-id'],
    prepare(flags) {
      const captured = captureDeleteGroupFolder(
        required(flags, 'group-id'),
        required(flags, 'folder-id'),
      );
      return (client) => client.deleteGroupFolder(captured.groupId, captured.folderId);
    },
  },
  'group-file-delete': {
    flags: ['config', 'uin', 'group-id', 'file-id'],
    prepare(flags) {
      const captured = captureDeleteGroupFile(
        required(flags, 'group-id'),
        required(flags, 'file-id'),
      );
      return (client) => client.deleteGroupFile(captured.groupId, captured.fileId);
    },
  },
  'group-remark': {
    flags: ['config', 'uin', 'group-id', 'remark'],
    prepare(flags) {
      const group = numeric(flags, 'group-id');
      const remark = required(flags, 'remark', true);
      const input = captureGroupOperation('setGroupRemark', { groupId: group, remark }).payload;
      return (client) => client.setGroupRemark(input.groupId, input.remark);
    },
  },
  'group-essence': {
    flags: ['config', 'uin', 'group-id', 'message-id', 'enabled'],
    prepare(flags) {
      const captured = captureGroupEssenceRequest(
        numeric(flags, 'group-id'),
        numeric(flags, 'message-id'),
        bool(flags, 'enabled'),
      );
      return (client) =>
        client.setGroupEssenceMessage(captured.groupId, captured.messageId, captured.enabled);
    },
  },
  'group-mute': {
    flags: ['config', 'uin', 'group-id', 'enabled'],
    prepare(flags) {
      const group = numeric(flags, 'group-id');
      const enabled = bool(flags, 'enabled');
      const input = captureGroupOperation('setGroupMute', { groupId: group, enabled }).payload;
      return (client) => client.setGroupMute(input.groupId, input.enabled);
    },
  },
  'member-mute': {
    flags: ['config', 'uin', 'group-id', 'user-id', 'seconds'],
    prepare(flags) {
      const group = numeric(flags, 'group-id');
      const user = numeric(flags, 'user-id');
      const seconds = Number(numeric(flags, 'seconds'));
      if (!Number.isSafeInteger(seconds))
        throw new Error('--seconds must be a nonnegative safe integer');
      const input = captureGroupOperation('setGroupMemberMute', {
        groupId: group,
        userId: user,
        seconds,
      }).payload;
      return (client) => client.setGroupMemberMute(input.groupId, input.userId, input.seconds);
    },
  },
  'member-card': {
    flags: ['config', 'uin', 'group-id', 'user-id', 'card'],
    prepare(flags) {
      const group = numeric(flags, 'group-id');
      const user = numeric(flags, 'user-id');
      const card = required(flags, 'card', true);
      const input = captureGroupOperation('setGroupMemberCard', {
        groupId: group,
        userId: user,
        card,
      }).payload;
      return (client) => client.setGroupMemberCard(input.groupId, input.userId, input.card);
    },
  },
  'member-admin': {
    flags: ['config', 'uin', 'group-id', 'user-id', 'enabled'],
    prepare(flags) {
      const group = numeric(flags, 'group-id');
      const user = numeric(flags, 'user-id');
      const enabled = bool(flags, 'enabled');
      const input = captureGroupOperation('setGroupAdmin', {
        groupId: group,
        userId: user,
        enabled,
      }).payload;
      return (client) => client.setGroupAdmin(input.groupId, input.userId, input.enabled);
    },
  },
  'group-kick': {
    flags: ['config', 'uin', 'group-id', 'user-id', 'reject-rejoin', 'reason'],
    prepare(flags) {
      const group = numeric(flags, 'group-id');
      const user = numeric(flags, 'user-id');
      const options = {
        rejectRejoin: bool(flags, 'reject-rejoin', false),
        reason: flags.reason ?? '',
      };
      const input = captureGroupOperation('kickGroupMember', {
        groupId: group,
        userId: user,
        options,
      }).payload;
      return (client) => client.kickGroupMember(input.groupId, input.userId, input.options);
    },
  },
  'group-essence-list': {
    flags: ['config', 'uin', 'group-id', 'page-start', 'page-limit'],
    prepare(flags) {
      const group = numeric(flags, 'group-id');
      const page = (name: string) => {
        const value = flags[name];
        if (value === undefined) return undefined;
        if (!/^\d+$/.test(value)) throw new Error(`--${name} must be a decimal integer`);
        return Number(value);
      };
      const query = captureGroupEssencePage(group, {
        pageStart: page('page-start'),
        pageLimit: page('page-limit'),
      });
      return (client) =>
        client.getGroupEssencePage(query.groupId, {
          pageStart: query.pageStart,
          pageLimit: query.pageLimit,
        });
    },
  },
  'group-essence-all': {
    flags: ['config', 'uin', 'group-id', 'max-pages'],
    prepare(flags) {
      const group = numeric(flags, 'group-id');
      const value = flags['max-pages'];
      if (value !== undefined && !/^\d+$/.test(value))
        throw new Error('--max-pages must be a decimal integer');
      const query = captureGroupEssenceList(group, {
        maxPages: value === undefined ? undefined : Number(value),
      });
      return (client) =>
        client.listGroupEssenceMessages(query.groupId, { maxPages: query.maxPages });
    },
  },
  'group-notices': {
    flags: ['config', 'uin', 'group-id'],
    prepare(flags) {
      const group = numeric(flags, 'group-id');
      return (client) => client.listGroupNotices(group);
    },
  },
  'group-notice-publish': {
    flags: ['config', 'uin', 'group-id', 'text', 'image', 'pinned', 'confirm-required'],
    prepare(flags) {
      const group = numeric(flags, 'group-id');
      const text = required(flags, 'text');
      if (!text.trim()) throw new Error('--text must not be blank');
      const options = {
        pinned: bool(flags, 'pinned', false),
        confirmRequired: bool(flags, 'confirm-required', false),
        ...(flags.image !== undefined ? { imagePath: resolve(required(flags, 'image')) } : {}),
      };
      return (client) => client.publishGroupNotice(group, text, options);
    },
  },
  'group-notice-delete': {
    flags: ['config', 'uin', 'group-id', 'notice-id'],
    prepare(flags) {
      const group = numeric(flags, 'group-id');
      const noticeId = required(flags, 'notice-id');
      return (client) => client.deleteGroupNotice(group, noticeId);
    },
  },
  'group-leave': {
    flags: ['config', 'uin', 'group-id'],
    prepare(flags) {
      const group = numeric(flags, 'group-id');
      const input = captureGroupOperation('leaveGroup', { groupId: group }).payload;
      return (client) => client.leaveGroup(input.groupId);
    },
  },
} satisfies Record<string, ClientCommandDefinition>;

function prepareGroupFiles(flags: CommandFlags, all: boolean): ClientCommandAction {
  const integerFlag = (name: string, signed = false) => {
    const value = flags[name];
    if (value === undefined) return undefined;
    if (!(signed ? /^-?\d+$/ : /^\d+$/).test(value))
      throw new Error(`--${name} must be a decimal integer`);
    return Number(value);
  };
  const options = {
    folderId: flags['folder-id'],
    sortType: integerFlag('sort-type', true),
    fileCount: integerFlag('file-count'),
    sortOrder: integerFlag('sort-order'),
    showOnlinedocFolder: integerFlag('show-onlinedoc-folder'),
  };
  const group = required(flags, 'group-id');
  if (!all) {
    const captured = captureGroupFilePage(group, {
      ...options,
      startIndex: integerFlag('start-index'),
    });
    return (client) => client.getGroupFilePage(captured.groupId, captured.params);
  }
  const captured = captureGroupFileList(group, {
    ...options,
    maxPages: integerFlag('max-pages'),
  });
  const { startIndex: _startIndex, ...params } = captured.params;
  return (client) =>
    client.listGroupFiles(captured.groupId, {
      ...params,
      maxPages: captured.maxPages,
    });
}
