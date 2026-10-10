import { qqFaceRows } from './qq-faces.ts';
import type { NativeObject as Native } from '../../native/native-object.ts';

const faces = new Map(
  qqFaceRows.map(([id, text, stickerType, packId, stickerId]) => [
    id,
    { text, stickerType, packId, stickerId },
  ]),
);
export function validateFaceId(id: unknown): asserts id is number {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0)
    throw new Error('Face id must be a nonnegative safe integer');
  if (!faces.has(id)) throw new Error(`Unsupported QQ face id: ${id}`);
}
/** Standard face converter at the pinned NapCat commit, api/msg.ts lines 707-748.
 * Animation metadata overrides the classic/extended type only when stickerType
 * is truthy. Zero remains meaningful metadata and must not be dropped.
 */
export function faceElement(id: unknown): Native {
  validateFaceId(id);
  const face = faces.get(id)!;
  return {
    elementType: 6,
    elementId: '',
    faceElement: {
      faceIndex: id,
      faceType: face.stickerType ? 3 : id >= 222 ? 2 : 1,
      faceText: face.text,
      sourceType: 1,
      ...(face.stickerType !== undefined
        ? { stickerType: face.stickerType, packId: face.packId, stickerId: face.stickerId }
        : {}),
    },
  };
}
