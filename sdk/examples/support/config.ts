import type { ClientOptions, LoginRequest, Account } from 'qq-native-client';
import { readFile, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';

export interface DemoConfig {
  client: Omit<ClientOptions, 'login'>;
  login: LoginRequest;
  keyword: string;
  reply: string;
  privateMessages: boolean;
  groupMessages: boolean;
  userIds: string[];
  groupIds: string[];
  openQr: boolean;
  loadContacts: boolean;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}
function text(value: unknown, fallback: string, label: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim()) throw Error(`${label} 必须是非空字符串`);
  return value;
}
function flag(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw Error(`${label} 必须是布尔值`);
  return value;
}
function ids(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((id: unknown) => typeof id === 'string' && /^\d+$/.test(id))
  )
    throw Error(`${label} 必须是 QQ 号码字符串数组`);
  return value as string[];
}
const sessionFile = 'demo-session.json';
async function savedLogin(dataDir: string): Promise<LoginRequest> {
  let contents: string;
  try {
    contents = await readFile(join(dataDir, sessionFile), 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return { method: 'qr' };
    throw error;
  }
  const saved = object(JSON.parse(contents), sessionFile);
  if (saved.schemaVersion !== 1 || typeof saved.uin !== 'string' || !/^[1-9]\d*$/.test(saved.uin))
    throw Error('本地账号标记无效，请使用 --qr 重新扫码');
  return { method: 'restore', uin: saved.uin };
}
export async function loadDemoConfig(file?: string, forceQr = false): Promise<DemoConfig> {
  const base = file === undefined ? resolve('.local') : dirname(resolve(file));
  const raw =
    file === undefined ? {} : object(JSON.parse(await readFile(resolve(file), 'utf8')), '配置');
  const client = { ...object(raw.client ?? {}, 'client') };
  if ('login' in client) throw Error('请使用顶层 login 配置，以便先订阅二维码再登录');
  const dataDir = resolve(base, text(client.dataDir, 'demo-account', 'client.dataDir'));
  client.dataDir = dataDir;
  client.cacheDir = resolve(base, text(client.cacheDir, 'demo-native-cache', 'client.cacheDir'));
  for (const key of ['wrapperPath', 'bridgePath', 'recordCodecPath', 'videoCodecPath'] as const)
    if (client[key] !== undefined)
      client[key] = resolve(base, text(client[key], '', `client.${key}`));
  if (client.autoReconnect !== undefined && client.autoReconnect !== false)
    throw Error('这个示例不自动重新登录，请将 client.autoReconnect 设为 false');
  client.autoReconnect = false;
  client.rememberPassword ??= true;
  const supplied = object(
    forceQr ? { method: 'qr' } : (raw.login ?? (await savedLogin(dataDir))),
    'login',
  );
  let login: LoginRequest;
  if (supplied.method === 'qr') login = { method: 'qr' };
  else if (supplied.method === 'restore' || supplied.method === 'quick') {
    if (
      supplied.uin !== undefined &&
      (typeof supplied.uin !== 'string' || !/^[1-9]\d*$/.test(supplied.uin))
    )
      throw Error('login.uin 必须是 QQ 号码字符串');
    if (supplied.method === 'quick' && supplied.uin === undefined)
      throw Error('quick 登录需要 login.uin');
    login =
      supplied.method === 'quick'
        ? { method: 'quick', uin: supplied.uin as string }
        : {
            method: 'restore',
            ...(supplied.uin === undefined ? {} : { uin: supplied.uin as string }),
          };
  } else throw Error('login.method 只能是 qr、restore 或 quick');
  return {
    client: client as unknown as Omit<ClientOptions, 'login'>,
    login,
    keyword: text(raw.keyword, 'ping', 'keyword').trim(),
    reply: text(raw.reply, 'pong', 'reply'),
    privateMessages: flag(raw.privateMessages, true, 'privateMessages'),
    groupMessages: flag(raw.groupMessages, true, 'groupMessages'),
    userIds: ids(raw.userIds, 'userIds'),
    groupIds: ids(raw.groupIds, 'groupIds'),
    openQr: flag(raw.openQr, true, 'openQr'),
    loadContacts: flag(raw.loadContacts, true, 'loadContacts'),
  };
}

export async function saveDemoAccount(account: Account, dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temporary = join(dataDir, `${sessionFile}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, uin: account.uin }), {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, join(dataDir, sessionFile));
  } catch (error) {
    const [cleanup] = await Promise.allSettled([rm(temporary, { force: true })]);
    if (cleanup.status === 'rejected')
      throw new AggregateError([error, cleanup.reason], '保存账号标记及清理临时文件失败', {
        cause: error,
      });
    throw error;
  }
}
