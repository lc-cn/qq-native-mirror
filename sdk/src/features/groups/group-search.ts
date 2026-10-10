import type { GroupSearchMatch } from '../../contracts/groups.ts';
export type { GroupSearchMatch } from '../../contracts/groups.ts';
import type { NativeEventChannel } from '../../runtime/native-event-channel.ts';
import { nativeResultError } from '../../errors.ts';
import { captureGroupSearch } from './group-search-input.ts';
export interface GroupSearchPort {
  searchGroup?: (parameters: {
    keyWords: string;
    groupNum: 25;
    exactSearch: false;
    penetrate: '';
  }) => unknown;
}
export interface GroupSearchContext {
  signal: AbortSignal;
  getSearchService(): GroupSearchPort | null | undefined;
  eventCall: NativeEventChannel['call'];
  awaitAlive<T>(value: T | PromiseLike<T>): Promise<T>;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid native group search result');
  return value as Record<string, unknown>;
}
function field(object: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !('value' in descriptor)) throw Error();
    return descriptor.value;
  } catch {
    throw Error('Invalid native group search result');
  }
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw Error('Invalid native group search result');
  return value;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw Error('Invalid native group search result');
  return value;
}
/** Independently inspected serializers write `errorode`, not the upstream
 * listener declaration's errorCode. Numeric zero is an SDK acceptance policy;
 * native core enum semantics and real search behavior have not been observed.
 * Composition retains one lazy listener until worker exit and forwards its raw callback.
 */
export function createGroupSearch(context: GroupSearchContext) {
  const controller = new AbortController();
  let closed = false,
    quarantined = false;
  const pending = new Map<string, Promise<GroupSearchMatch | undefined>>();
  let queue: Promise<unknown> = Promise.resolve();
  const retire = () => controller.abort(context.signal.reason ?? Error('Group search is closed'));
  context.signal.addEventListener('abort', retire, { once: true });
  if (context.signal.aborted) retire();
  const alive = () => {
    context.signal.throwIfAborted();
    controller.signal.throwIfAborted();
    if (closed) throw Error('Group search is closed');
  };
  async function wait<T>(value: Promise<T>): Promise<T> {
    void value.catch(() => {});
    alive();
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const result = await Promise.race([context.awaitAlive(value), stopped]);
      alive();
      return result;
    } finally {
      controller.signal.removeEventListener('abort', abort);
    }
  }
  function project(
    raw: unknown,
    target: string,
  ): { match: GroupSearchMatch | undefined } | undefined {
    const result = record(raw);
    const keyword = text(field(result, 'keyWord'));
    alive();
    if (keyword !== target) return;
    const code = count(field(result, 'errorode'));
    alive();
    if (code !== 0)
      throw nativeResultError('Native group search callback failed', { result: code });
    const isEnd = field(result, 'isEnd'),
      infos = field(result, 'groupInfos');
    alive();
    if (typeof isEnd !== 'boolean' || !Array.isArray(infos))
      throw Error('Invalid native group search result');
    const length = field(infos as unknown as Record<string, unknown>, 'length');
    alive();
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 1000)
      throw Error('Invalid native group search result');
    const rows = Array.from({ length }, (_, index) =>
      field(infos as unknown as Record<string, unknown>, String(index)),
    );
    alive();
    const seen = new Set<string>();
    let match: GroupSearchMatch | undefined;
    for (const rawRow of rows) {
      const row = record(rawRow),
        detail = record(field(row, 'searchGroupInfo'));
      const outer = captureGroupSearch(field(row, 'groupCode')),
        inner = captureGroupSearch(field(detail, 'groupCode')),
        canonical = BigInt(outer).toString();
      if (BigInt(outer) !== BigInt(inner) || seen.has(canonical))
        throw Error('Invalid native group search identities');
      seen.add(canonical);
      const projected = {
        groupId: outer,
        name: text(field(detail, 'groupName')),
        memberCount: count(field(detail, 'memberNum')),
        maxMemberCount: count(field(detail, 'maxMemberNum')),
        ownerUid: text(field(detail, 'ownerUid')),
        description: text(field(detail, 'fingerMemo')),
      };
      if (!projected.ownerUid) throw Error('Invalid native group search owner');
      alive();
      if (BigInt(outer) === BigInt(target)) match = projected;
    }
    alive();
    return match || isEnd === true ? { match } : undefined;
  }
  async function perform(target: string) {
    alive();
    if (quarantined) throw Error('Group search channel is invalidated');
    try {
      const service = context.getSearchService();
      alive();
      const method = service?.searchGroup;
      alive();
      if (typeof method !== 'function') throw Error('Native service is missing searchGroup');
      const result = await wait(
        context.eventCall<[unknown], { match: GroupSearchMatch | undefined }>(
          'Search/onSearchGroupResult',
          (raw) => project(raw, target),
          () => {
            alive();
            return Reflect.apply(method, service, [
              { keyWords: target, groupNum: 25, exactSearch: false, penetrate: '' },
            ]) as unknown;
          },
          5000,
          (value) => {
            const status = field(record(value), 'result');
            alive();
            return status === 0;
          },
          controller.signal,
        ),
      );
      alive();
      return result.match;
    } catch (error) {
      quarantined = true;
      throw error;
    }
  }
  return {
    searchGroup(groupId: unknown): Promise<GroupSearchMatch | undefined> {
      const target = captureGroupSearch(groupId);
      alive();
      let shared = pending.get(target);
      if (!shared) {
        shared = queue.then(() => perform(target));
        pending.set(target, shared);
        queue = shared.catch(() => {});
        void shared
          .finally(() => {
            if (pending.get(target) === shared) pending.delete(target);
          })
          .catch(() => {});
      }
      return shared.then((match) => {
        alive();
        return match ? { ...match } : undefined;
      });
    },
    close() {
      if (closed) return;
      closed = true;
      controller.abort(Error('Group search is closed'));
      pending.clear();
      context.signal.removeEventListener('abort', retire);
    },
  };
}
