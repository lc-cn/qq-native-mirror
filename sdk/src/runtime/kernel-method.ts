/** The measured kernel surface used for preparation and account startup.
 * Business service methods belong to their domain ports, not this dispatcher.
 */
type KernelMethod =
  | 'get'
  | 'create'
  | 'getNTWrapperSession'
  | 'initWithDeskTopConfig'
  | 'initConfig'
  | 'setRemerberPwd'
  | 'addKernelLoginListener'
  | 'getMachineGuid'
  | 'init'
  | 'start'
  | 'startNT';

/** Capture once, retaining the proprietary receiver. A property getter can
 * synchronously retire the owner; recheck after capture and before dispatch.
 * Optional lookup selects an exported surface without invoking it as a probe.
 */
export function captureKernelMethod(
  receiver: unknown,
  name: KernelMethod,
  assertActive: () => void,
): ((...args: unknown[]) => unknown) | undefined {
  assertActive();
  const target =
    receiver !== null && (typeof receiver === 'object' || typeof receiver === 'function')
      ? (receiver as Record<string, unknown>)
      : undefined;
  const method = target?.[name];
  assertActive();
  if (typeof method !== 'function') return;
  return (...args) => {
    assertActive();
    return Reflect.apply(method, receiver, args) as unknown;
  };
}

export function invokeKernelMethod(
  receiver: unknown,
  name: KernelMethod,
  args: readonly unknown[],
  assertActive: () => void,
): unknown {
  const method = captureKernelMethod(receiver, name, assertActive);
  if (!method) throw new Error(`Native kernel is missing ${name}`);
  return method(...args);
}
