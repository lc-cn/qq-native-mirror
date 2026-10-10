import { nativeResultError } from '../../errors.ts';
import type { GroupEssenceContent, GroupEssencePage } from '../../types.ts';
import { captureGroupEssencePage } from './group-essence-input.ts';
import { requestQunPage, type QunWebReadContext } from './qun-web-read.ts';

/** Fixed NapCatQQ26d7533e WebApi74-94 and types/webapi108-130.
 * Native fetchGroupEssenceList has a serializer but its measured Linux primary
 * service implementation is a stub. This reader uses the explicit HTTP contract
 * and native-owned login tickets; it never falls back after dispatch or infers
 * content type meanings, operator identities, cursor arithmetic or completeness.
 */
function invalid(): Error {
  return nativeResultError('Invalid group essence page', { result: 'invalid-result' });
}
function field(value: unknown, key: string, optional = false): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const item = Object.getOwnPropertyDescriptor(value, key);
  if (!item) {
    if (optional) return;
    throw invalid();
  }
  if (!('value' in item)) throw invalid();
  return item.value;
}
function uint32(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw invalid();
  return value;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw invalid();
  return value;
}
function identifier(value: unknown): string {
  const id = string(value);
  if (!/^\d+$/.test(id) || BigInt(id) > 0xffff_ffff_ffff_ffffn) throw invalid();
  return id;
}
function rows<T>(value: unknown, project: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) throw invalid();
  return Array.from({ length: value.length }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item || !('value' in item)) throw invalid();
    return project(item.value);
  });
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid();
  return value;
}
function content(value: unknown): GroupEssenceContent {
  const result: GroupEssenceContent = { type: uint32(field(value, 'msg_type')) };
  const text = field(value, 'text', true);
  const image = field(value, 'image_url', true);
  if (text !== undefined) result.text = string(text);
  if (image !== undefined) result.imageUrl = string(image);
  return result;
}

export async function getGroupEssencePage(
  context: QunWebReadContext,
  groupId: unknown,
  options: unknown = undefined,
): Promise<GroupEssencePage> {
  const query = captureGroupEssencePage(groupId, options);
  context.signal?.throwIfAborted();
  const raw = await requestQunPage(
    context,
    'essence',
    new URLSearchParams({
      page_start: String(query.pageStart),
      page_limit: String(query.pageLimit),
      group_code: query.groupId,
    }),
  );
  context.signal?.throwIfAborted();
  const code = field(raw, 'retcode');
  if (typeof code !== 'number' || !Number.isSafeInteger(code)) throw invalid();
  if (code !== 0) throw nativeResultError('Group essence page returned failure', { result: code });
  const data = field(raw, 'data');
  const list = field(data, 'msg_list');
  if (!Array.isArray(list) || list.length > query.pageLimit) throw invalid();
  const seen = new Set<string>();
  const messages = rows(list, (value) => {
    const group = identifier(field(value, 'group_code'));
    if (BigInt(group) !== BigInt(query.groupId)) throw invalid();
    const sequence = uint32(field(value, 'msg_seq'));
    const random = uint32(field(value, 'msg_random'));
    const key = `${sequence}:${random}`;
    if (seen.has(key)) throw invalid();
    seen.add(key);
    return {
      groupId: group,
      sequence,
      random,
      senderId: identifier(field(value, 'sender_uin')),
      senderNickname: string(field(value, 'sender_nick')),
      sentAt: uint32(field(value, 'sender_time')),
      operatorId: identifier(field(value, 'add_digest_uin')),
      operatorNickname: string(field(value, 'add_digest_nick')),
      setAt: uint32(field(value, 'add_digest_time')),
      content: rows(field(value, 'msg_content'), content),
      removable: boolean(field(value, 'can_be_removed')),
    };
  });
  const page = {
    ...query,
    messages,
    isEnd: boolean(field(data, 'is_end')),
    groupRole: uint32(field(data, 'group_role')),
  };
  string(field(data, 'config_page_url')); // Credential-bearing URLs stay in the worker.
  context.signal?.throwIfAborted();
  return page;
}
