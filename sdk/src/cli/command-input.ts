import type { Peer } from '../contracts/messages.ts';

export function parse(args: string[]) {
  const command = args.shift();
  const flags: Record<string, string> = {};
  while (args.length) {
    const flag = args.shift()!;
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument: ${flag}`);
    if (flag === '--help') {
      flags.help = 'true';
      continue;
    }
    const value = args.shift();
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (Object.hasOwn(flags, flag.slice(2))) throw new Error(`Duplicate option: ${flag}`);
    Object.defineProperty(flags, flag.slice(2), {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { command, flags };
}

export function required(flags: Record<string, string>, key: string, allowEmpty = false) {
  if (flags[key] === undefined || (!allowEmpty && !flags[key]))
    throw new Error(`--${key} is required`);
  return flags[key];
}

export function numeric(flags: Record<string, string>, key: string): string {
  const value = required(flags, key);
  if (!/^\d+$/.test(value)) throw new Error(`--${key} must be a numeric string`);
  return value;
}

export function bool(flags: Record<string, string>, key: string, fallback?: boolean): boolean {
  if (flags[key] === undefined && fallback !== undefined) return fallback;
  const value = required(flags, key);
  if (value !== 'true' && value !== 'false') throw new Error(`--${key} must be true or false`);
  return value === 'true';
}

export function peer(flags: Record<string, string>): Peer {
  const kind = required(flags, 'kind');
  const target = numeric(flags, 'target');
  if (kind !== 'private' && kind !== 'group') throw new Error('--kind must be private or group');
  return kind === 'private'
    ? { type: 'private', userId: target }
    : { type: 'group', groupId: target };
}
