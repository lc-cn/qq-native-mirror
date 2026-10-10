/** Fixed NapCatQQ 26d7533e: types/notify.ts ShutUpGroupMember,
 * api/group.ts getGroupShutUpMemberList, Group listener onShutUpMemberListChanged.
 * shutUpTime has no established unit here; never synthesize an expiry/duration. */
import type { GroupMutedMember } from '../../contracts/groups.ts';
export function projectGroupMuteList(value: unknown): GroupMutedMember[] {
  if (!Array.isArray(value)) throw new Error('Invalid native group mute list');
  return Array.from(value, (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Invalid native group mute member');
    const field = (key: string) => Object.getOwnPropertyDescriptor(raw, key)?.value;
    const uid = field('uid'),
      userId = field('uin'),
      nickname = field('nick'),
      card = field('cardName');
    const nativeRole = field('role'),
      shutUpTime = field('shutUpTime');
    const roles = ['unspecified', 'stranger', 'member', 'admin', 'owner'] as const;
    if (
      typeof uid !== 'string' ||
      !uid.trim() ||
      typeof userId !== 'string' ||
      !/^\d+$/.test(userId) ||
      typeof nickname !== 'string' ||
      typeof card !== 'string' ||
      typeof nativeRole !== 'number' ||
      !Number.isInteger(nativeRole) ||
      nativeRole < 0 ||
      nativeRole >= roles.length ||
      typeof shutUpTime !== 'number' ||
      !Number.isSafeInteger(shutUpTime) ||
      shutUpTime < 0
    ) {
      throw new Error('Invalid native group mute member');
    }
    return { uid, userId, nickname, card, role: roles[nativeRole], shutUpTime };
  });
}
