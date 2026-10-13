import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export async function showQr(
  image: Buffer,
  path: string,
  open: boolean,
  signal: AbortSignal,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (signal.aborted) return;
  await writeFile(path, image, { mode: 0o600 });
  if (!open || signal.aborted) return;
  try {
    if (process.platform === 'darwin') await execute('open', [path], { timeout: 3000 });
    else if (process.platform === 'win32')
      await execute(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Invoke-Item -LiteralPath $env:QQ_DEMO_QR_FILE',
        ],
        { env: { ...process.env, QQ_DEMO_QR_FILE: path }, timeout: 3000 },
      );
    else await execute('xdg-open', [path], { timeout: 3000 });
  } catch {
    console.log(`无法自动打开图片，请手动打开：${path}`);
  }
}
