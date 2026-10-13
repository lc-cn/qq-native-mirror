import type { Account, ClientState, Message } from 'qq-native-client';
import type { DemoConfig } from './config.ts';

/** Reply eligibility for this manual session; it never sends or retries messages. */
export class ReplyPolicy {
  #account: Account | undefined;
  #readyAt = 0;
  readonly #seen = new Set<string>();
  readonly #cooldown = new Map<string, number>();
  private readonly config: DemoConfig;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  constructor(config: DemoConfig, now: () => number, log: (message: string) => void) {
    this.config = config;
    this.now = now;
    this.log = log;
  }
  get online(): boolean {
    return this.#account !== undefined;
  }
  ready = (account: Account): void => {
    this.#account = { ...account };
    this.#readyAt = this.now();
    this.#seen.clear();
    this.#cooldown.clear();
    this.log(
      `已上线：QQ ${account.uin}。现在可以在私聊或群聊发送 ${JSON.stringify(this.config.keyword)}。`,
    );
  };
  offline = (): void => {
    if (this.online) this.log('账号已离线，停止回复；按 Ctrl+C 退出。');
    this.clear();
  };
  clear(): void {
    this.#account = undefined;
  }
  accepts(message: Message, state: ClientState): boolean {
    const account = this.#account;
    if (!account || state !== 'online') return false;
    if (
      message.sender.userId === account.uin ||
      (account.uid.length > 0 && message.sender.uid === account.uid)
    )
      return false;
    const timestamp = message.time >= 1e12 ? message.time : message.time * 1000;
    if (!Number.isFinite(timestamp) || timestamp < this.#readyAt - 5000) return false;
    const content = message.elements
      .filter((element) => element.type === 'text')
      .map((element) => element.text)
      .join('')
      .trim();
    if (content !== this.config.keyword) return false;
    const peer = message.peer;
    if (
      peer.type === 'group'
        ? !this.config.groupMessages ||
          (this.config.groupIds.length > 0 && !this.config.groupIds.includes(peer.groupId))
        : !this.config.privateMessages ||
          (this.config.userIds.length > 0 && !this.config.userIds.includes(peer.userId))
    )
      return false;
    const destination = peer.type === 'group' ? peer.groupId : peer.userId;
    const key = `${peer.type}:${destination}:${message.messageId}`;
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    if (this.#seen.size > 1000) this.#seen.delete(this.#seen.values().next().value!);
    const peerKey = `${peer.type}:${destination}`,
      now = this.now();
    if (now - (this.#cooldown.get(peerKey) ?? -Infinity) < 3000) return false;
    this.#cooldown.set(peerKey, now);
    if (this.#cooldown.size > 1000) this.#cooldown.delete(this.#cooldown.keys().next().value!);
    return true;
  }
}
