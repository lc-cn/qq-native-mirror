import type { ClientLifecycleContext } from '../../src/runtime/client-lifecycle.ts';

/** Compile-only checks against the actual lifecycle outlet, never called. */
export function lifecycleEventTypes(context: ClientLifecycleContext): void {
  context.emit('state', 'online');
  context.emit('log', { stream: 'stderr', text: 'fixture' });
  context.emit('terminated', new Error('fixture'));
  context.forward('unrecognized-native-event', { opaque: true });
  context.forward('reconnect-error', undefined);
  // @ts-expect-error State belongs to the closed public state vocabulary.
  context.emit('state', 'unrecognized-state');
  // @ts-expect-error Log streams are stdout or stderr.
  context.emit('log', { stream: 'file', text: 'fixture' });
  // @ts-expect-error Termination is produced with an Error.
  context.emit('terminated', { message: 'fixture' });
  // @ts-expect-error Arbitrary IPC events belong to forward.
  context.emit('unrecognized-native-event', undefined);
  // @ts-expect-error Unknown reconnect failures belong to forward.
  context.emit('reconnect-error', undefined);
}
