import type { OperationCall, OperationResult } from '../../runtime/operation-contracts.ts';
import { captureContactOperation } from '../../features/contacts/contact-operation-input.ts';
import { sendUserId } from '../../validation/identifiers.ts';

/** Parent-process commands bound to one online authorization. Implementations
 * check that authorization again after callers have captured their input.
 */
export interface ContactContext {
  assertActive(): void;
  invoke<C extends OperationCall>(...command: C): Promise<OperationResult<C[0]>>;
}

/** Contact actions share a decimal account identity. UID-only addressing remains
 * available on the direct send API, whose other operations do not accept a UID.
 */
export function contactUserId(value: string): string {
  return sendUserId(captureContactOperation('getUserProfile', { userId: value }).payload.userId);
}
