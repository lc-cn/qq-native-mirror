import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientOptions } from 'qq-native-client';
import { loadDemoConfig, saveDemoAccount, type DemoConfig } from './config.ts';
import { showQr } from './qrcode.ts';
import type { DemoClient, DemoDependencies } from './runtime.ts';

export function runWhenMain(
  url: string,
  runDemo: (
    config: DemoConfig,
    signal: AbortSignal,
    dependencies: DemoDependencies,
  ) => Promise<void>,
  createClient: (options: ClientOptions) => Promise<DemoClient>,
): void {
  async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
      console.log(
        '用法：npm run demo -- [--config .local/demo.json] [--qr]\n首次扫码，之后默认恢复本地账号；--qr 强制重新扫码。\n私聊和群聊精确匹配 ping 后引用回复 pong。\n首次运行自动加载平台原生资源；Ctrl+C 关闭，加载卡住时最多 7 秒强制退出。',
      );
      return;
    }
    let file: string | undefined;
    let forceQr = false;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--qr' && !forceQr) forceQr = true;
      else if (
        args[index] === '--config' &&
        file === undefined &&
        args[index + 1] &&
        !args[index + 1]!.startsWith('--')
      )
        file = args[++index];
      else throw Error('参数错误，使用 --help 查看用法');
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    const onControl = (message: unknown) => {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'stop')
        stop();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('disconnect', stop);
    process.on('message', onControl);
    try {
      const config = await loadDemoConfig(file, forceQr);
      await runDemo(config, controller.signal, {
        createClient,
        showQr,
        removeQr: (path) => rm(path, { force: true }),
        saveAccount: saveDemoAccount,
        log: console.log,
        now: Date.now,
      });
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.off('disconnect', stop);
      process.off('message', onControl);
    }
  }
  if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url)) {
    main()
      .catch((error: unknown) => {
        console.error(`示例失败：${error instanceof Error ? error.message : '未知错误'}`);
        if (error instanceof AggregateError)
          for (const detail of error.errors as unknown[])
            console.error(`  原因：${detail instanceof Error ? detail.message : '未知错误'}`);
        process.exitCode = 1;
      })
      .finally(() => {
        if (process.connected) process.disconnect();
      });
  }
}
