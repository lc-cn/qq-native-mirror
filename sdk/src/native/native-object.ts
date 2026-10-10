/**
 * Type erasure at the proprietary `.node` boundary.
 *
 * QQ exposes version-dependent objects without a stable TypeScript declaration.
 * Keep this escape hatch internal: adapters must validate native results before
 * projecting public DTOs, and public inputs start as `unknown`. This type conveys
 * neither a supported ABI nor a successful operation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- One explicit quarantine for undocumented native fields and callable members.
export type NativeValue = any;

/** An opaque native object, accessed only by the native runtime and adapters. */
export type NativeObject = Record<string, NativeValue>;
