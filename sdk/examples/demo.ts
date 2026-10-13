import { fork, type ChildProcess } from 'node:child_process';

// Node 24 runs the TypeScript child directly. Keep this process free of SDK/native loading.
let child: ChildProcess | undefined;
let shutdownSignal: 'SIGINT' | 'SIGTERM' | undefined;
let settled = false;
let terminateTimer: ReturnType<typeof setTimeout> | undefined;
let killTimer: ReturnType<typeof setTimeout> | undefined;
let stopSent = false;

function logFailure(message: string): void {
  process.stderr.write(`${message}\n`);
}

function killChild(signal: 'SIGTERM' | 'SIGKILL'): void {
  if (settled || !child) return;
  try {
    child.kill(signal);
  } catch {
    logFailure('Demo child termination failed.');
  }
}

function sendStop(): void {
  if (!child || stopSent || settled) return;
  stopSent = true;
  // IPC is the graceful path on Windows too; OS signals provide only a fallback.
  if (child.connected) {
    try {
      child.send({ type: 'stop' }, (error) => {
        if (error) logFailure('Demo stop IPC failed.');
      });
    } catch {
      logFailure('Demo stop IPC failed.');
    }
  }
  terminateTimer = setTimeout(() => {
    killChild('SIGTERM');
  }, 5_000);
  killTimer = setTimeout(() => {
    killChild('SIGKILL');
  }, 7_000);
}

function requestStop(signal: 'SIGINT' | 'SIGTERM'): void {
  if (shutdownSignal || settled) return;
  shutdownSignal = signal;
  sendStop();
}

const onInterrupt = (): void => requestStop('SIGINT');
const onTerminate = (): void => requestStop('SIGTERM');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);

try {
  const exitCode = await new Promise<number>((resolve) => {
    function finish(code: number | null, signal?: NodeJS.Signals | null): void {
      if (settled) return;
      settled = true;
      resolve(
        shutdownSignal === 'SIGINT'
          ? 130
          : shutdownSignal === 'SIGTERM'
            ? 143
            : (code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)),
      );
    }
    try {
      child = fork(new URL('./keyword-reply.ts', import.meta.url), process.argv.slice(2), {
        execPath: process.execPath,
        execArgv: [],
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        windowsHide: true,
      });
      child.once('error', () => {
        logFailure('Demo child process failed.');
        finish(1);
      });
      child.once('close', finish);
      // A reserved signal may have arrived before fork returned.
      if (shutdownSignal) sendStop();
    } catch {
      logFailure('Demo child process could not start.');
      finish(1);
    }
  });
  process.exitCode = exitCode;
} finally {
  if (terminateTimer) clearTimeout(terminateTimer);
  if (killTimer) clearTimeout(killTimer);
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
}
