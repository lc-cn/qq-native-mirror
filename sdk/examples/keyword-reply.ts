import { createClient } from 'qq-native-client';
import { runWhenMain } from './support/cli.ts';
import type { DemoConfig } from './support/config.ts';
import { ReplyPolicy } from './support/reply-policy.ts';
import { DemoLifetime, type DemoDependencies, type DemoOutcome } from './support/runtime.ts';

export { loadDemoConfig, saveDemoAccount, type DemoConfig } from './support/config.ts';
export type { DemoClient, DemoDependencies } from './support/runtime.ts';

/** Complete SDK usage; filesystem and process plumbing live in support/. */
export async function runDemo(
  config: DemoConfig,
  signal: AbortSignal,
  dependencies: DemoDependencies,
): Promise<void> {
  const { createClient, log } = dependencies;
  const lifetime = new DemoLifetime(config, signal, dependencies);
  const replies = new ReplyPolicy(config, dependencies.now, log);
  let outcome: DemoOutcome = { ok: true };

  try {
    if (signal.aborted) return;
    log(
      `加载原生资源：${process.platform}/${process.arch}；${config.client.wrapperPath ? '指定本地 wrapper' : '默认平台包／镜像最新版本'}`,
    );
    log(`账号目录：${config.client.dataDir}`);
    const client = await createClient(config.client);
    lifetime.attach(
      () => client.close(),
      () => {
        replies.clear();
        client.removeAllListeners();
      },
    );
    if (signal.aborted) return;

    client.on('qrcode', ({ image }) => lifetime.showQr(image, () => replies.online));
    client.on('qr-scanned', () => log('二维码已扫描，请在手机 QQ 确认登录。'));
    client.on('authenticated', (account) =>
      log(`认证完成：QQ ${account.uin}，正在等待原生 Session 上线…`),
    );
    client.on('ready', (account) => {
      if (!signal.aborted) replies.ready(account);
    });
    client.on('offline', replies.offline);
    client.on('disconnected', replies.offline);
    client.on('terminated', lifetime.terminate);
    client.on('login-error', (error) => lifetime.report('登录通知', error));
    client.on('diagnostic', ({ stage }) => log(`初始化诊断：${stage}`));

    client.on('message', (message) => {
      if (signal.aborted || !replies.accepts(message, client.state)) return;
      const rss = process.memoryUsage().rss;
      log(`当前内存使用量：${rss} 字节`);
      lifetime.observe(
        (async () => {
          const receipt = await message.reply(
            `${config.reply}\n当前内存使用量：${(rss / 1024 / 1024).toFixed(2)} MB`,
            true,
          );
          if (!signal.aborted) log(`已回复，消息 ID ${receipt.messageId}`);
        })(),
        '回复失败，远端效果可能未知',
      );
    });

    log('原生资源已加载，开始登录。');
    log(
      config.login.method === 'qr'
        ? '本轮使用二维码登录。'
        : '本轮恢复本地账号授权，不生成二维码。',
    );
    const account = await client.login(config.login);
    if (signal.aborted) return;
    if (!replies.online) replies.ready(account);
    await dependencies.saveAccount(account, config.client.dataDir);
    log('已保存账号标记；原生授权数据保留在账号目录中，下次默认恢复登录。');
    await lifetime.clearQr();

    if (config.loadContacts) {
      log('读取好友和群列表…');
      const [friends, groups] = await Promise.allSettled([
        client.listFriends(),
        client.listGroups(),
      ]);
      if (signal.aborted) return;
      if (friends.status === 'fulfilled') log(`好友资源已加载：${friends.value.length} 个`);
      else lifetime.report('好友列表读取失败', friends.reason);
      if (groups.status === 'fulfilled') log(`群资源已加载：${groups.value.length} 个`);
      else lifetime.report('群列表读取失败', groups.reason);
    }
    log('监听中：精确匹配关键词；每个会话 3 秒内最多回复一次。按 Ctrl+C 退出。');
    await lifetime.waitForStop();
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    await lifetime.finish(outcome);
  }
}

runWhenMain(import.meta.url, runDemo, createClient);
