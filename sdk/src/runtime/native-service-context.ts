import type { NativeObject } from '../native/native-object.ts';
import type { NativeContractProfile } from '../native/native-contracts.ts';
import type { MediaTools } from '../features/media/media-send.ts';
import type { RecordCodec } from '../features/media/media-record.ts';
import type { VideoCodec } from '../features/media/video-codec-loader.ts';
import type { NativeCallbackAudit } from '../types.ts';

/** Dependencies for one account's native service composition.
 * Session is a proprietary, versioned dynamic surface. Its runtime method guards
 * remain in native-services; this type does not assert an unverified stable ABI.
 */
export interface NativeServiceContext {
  readonly session: NativeObject;
  readonly version: string;
  readonly events: {
    readonly emit: (event: string, payload: unknown) => void;
  };
  /** Authenticated account identifiers; neither field is inferred here. */
  readonly identity?: {
    readonly userId?: string;
    readonly uid?: string;
  };
  readonly media?: {
    readonly tools?: MediaTools;
    readonly recordCodec?: RecordCodec;
    readonly videoCodec?: VideoCodec;
  };
  readonly auditCallback?: (
    info: Pick<NativeCallbackAudit, 'family' | 'name' | 'argumentTypes'>,
  ) => void;
  /** Worker-computed binary provenance, never a user-declared capability. */
  readonly binaryProfile?: NativeContractProfile;
}
