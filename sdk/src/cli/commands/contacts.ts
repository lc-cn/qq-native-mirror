import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { captureContactOperation } from '../../features/contacts/contact-operation-input.ts';
import {
  captureFriendCategoryAssignment,
  captureFriendCategoryId,
  captureFriendCategoryOrder,
  captureRenameFriendCategory,
} from '../../features/contacts/friend-categories.ts';
import { required, numeric, bool } from '../command-input.ts';
import type { ClientCommandDefinition } from '../command-contracts.ts';

/** Contacts CLI plans use the public client and shared domain input rules. */
export const contactsCommands = {
  contacts: {
    flags: ['config', 'uin'],
    prepare() {
      return (client) => client.listFriends();
    },
  },
  nickname: {
    flags: ['config', 'uin', 'name'],
    prepare(flags) {
      const name = required(flags, 'name');
      if (!name.trim()) throw new Error('--name must not be blank');
      return (client) => client.setNickname(name);
    },
  },
  signature: {
    flags: ['config', 'uin', 'text'],
    prepare(flags) {
      const text = required(flags, 'text', true);
      return (client) => client.setSignature(text);
    },
  },
  profile: {
    flags: ['config', 'uin', 'target'],
    prepare(flags) {
      const input = captureContactOperation('getUserProfile', {
        userId: numeric(flags, 'target'),
      }).payload;
      return (client) => client.getUserProfile(input.userId);
    },
  },
  requests: {
    flags: ['config', 'uin'],
    prepare() {
      return (client) => client.listFriendRequests();
    },
  },
  request: {
    flags: ['config', 'uin', 'uid', 'time', 'accept'],
    prepare(flags) {
      const request = { uid: required(flags, 'uid'), time: numeric(flags, 'time') };
      const accept = bool(flags, 'accept');
      return (client) => client.handleFriendRequest(request, accept);
    },
  },
  'friend-remark': {
    flags: ['config', 'uin', 'target', 'remark'],
    prepare(flags) {
      const input = captureContactOperation('setFriendRemark', {
        userId: numeric(flags, 'target'),
        remark: required(flags, 'remark', true),
      }).payload;
      return (client) => client.setFriendRemark(input.userId, input.remark);
    },
  },
  'friend-category-rename': {
    flags: ['config', 'uin', 'category-id', 'name'],
    prepare(flags) {
      const rawId = required(flags, 'category-id');
      if (!/^\d+$/.test(rawId)) throw new Error('--category-id must be a uint32 decimal integer');
      const captured = captureRenameFriendCategory(Number(rawId), required(flags, 'name'));
      return (client) => client.renameFriendCategory(captured.categoryId, captured.name);
    },
  },
  'friend-category-add': {
    flags: ['config', 'uin', 'name'],
    prepare(flags) {
      const name = required(flags, 'name');
      if (!name.trim()) throw new Error('--name must not be blank');
      return (client) => client.addFriendCategory(name);
    },
  },
  'friend-category-delete': {
    flags: ['config', 'uin', 'category-id'],
    prepare(flags) {
      const rawId = required(flags, 'category-id');
      if (!/^\d+$/.test(rawId)) throw new Error('--category-id must be a uint32 decimal integer');
      const categoryId = captureFriendCategoryId(Number(rawId));
      return (client) => client.deleteFriendCategory(categoryId);
    },
  },
  'friend-category-set': {
    flags: ['config', 'uin', 'target', 'category-id'],
    prepare(flags) {
      const rawId = required(flags, 'category-id');
      if (!/^\d+$/.test(rawId)) throw new Error('--category-id must be a uint32 decimal integer');
      const captured = captureFriendCategoryAssignment(required(flags, 'target'), Number(rawId));
      return (client) => client.setFriendCategory(captured.userId, captured.categoryId);
    },
  },
  'friend-category-reorder': {
    flags: ['config', 'uin', 'categories-file'],
    async prepare(flags) {
      const categories = captureFriendCategoryOrder(
        JSON.parse(await readFile(resolve(required(flags, 'categories-file')), 'utf8')),
      );
      return (client) => client.reorderFriendCategories(categories);
    },
  },
  'friend-categories': {
    flags: ['config', 'uin'],
    prepare() {
      return (client) => client.listFriendCategories();
    },
  },
  'friend-delete': {
    flags: ['config', 'uin', 'target', 'block', 'both'],
    prepare(flags) {
      const input = captureContactOperation('deleteFriend', {
        userId: numeric(flags, 'target'),
        options: { block: bool(flags, 'block', false), both: bool(flags, 'both', false) },
      }).payload;
      return (client) => client.deleteFriend(input.userId, input.options);
    },
  },
} satisfies Record<string, ClientCommandDefinition>;
