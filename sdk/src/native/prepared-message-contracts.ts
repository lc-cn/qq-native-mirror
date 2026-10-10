import type { NativePeer } from './message-contracts.ts';

/** Outbound envelopes constructed by this SDK. These describe the builders'
 * output, not arbitrary incoming native callbacks or a complete proprietary ABI.
 * They deliberately have no index signature or native-object inheritance.
 */
export interface PreparedTextElement {
  elementType: 1;
  elementId: '';
  textElement: {
    content: string;
    atType: 0 | 1 | 2;
    atUid: string;
    atTinyId: '';
    atNtUid: string;
  };
}

export interface PreparedImageElement {
  elementType: 2;
  elementId: '';
  picElement: {
    md5HexStr: string;
    fileSize: string;
    picWidth: number;
    picHeight: number;
    fileName: string;
    sourcePath: string;
    original: true;
    picType: 1000 | 2000;
    picSubType: 0;
    fileUuid: '';
    fileSubId: '';
    thumbFileSize: 0;
    summary: '';
  };
}

export interface PreparedFileElement {
  elementType: 3;
  elementId: '';
  fileElement: {
    fileName: string;
    folderId: '';
    filePath: string;
    fileSize: string;
  };
}

export interface PreparedRecordElement {
  elementType: 4;
  elementId: '';
  pttElement: {
    fileName: string;
    filePath: string;
    md5HexStr: string;
    fileSize: string;
    duration: number;
    formatType: 1;
    voiceType: 1;
    voiceChangeType: 0;
    canConvert2Text: true;
    waveAmplitudes: number[];
    fileSubId: '';
    playState: 1;
    autoConvertText: 0;
    storeID: 0;
    otherBusinessInfo: { aiVoiceType: 0 };
  };
}

export interface PreparedVideoElement {
  elementType: 5;
  elementId: '';
  videoElement: {
    fileName: string;
    filePath: string;
    videoMd5: string;
    thumbMd5: string;
    fileTime: number;
    thumbPath: Map<number, string>;
    thumbSize: number;
    thumbWidth: number;
    thumbHeight: number;
    fileSize: string;
  };
}

export interface PreparedFaceElement {
  elementType: 6;
  elementId: '';
  faceElement: {
    faceIndex: number;
    faceType: 1 | 2 | 3;
    faceText: string;
    sourceType: 1;
    stickerType?: number;
    packId?: string;
    stickerId?: string;
  };
}

export interface PreparedReplyElement {
  elementType: 7;
  elementId: '';
  replyElement: {
    replayMsgSeq: string;
    replayMsgId: string;
    senderUin: string;
    senderUinStr: string;
    replyMsgClientSeq: string;
    _replyMsgPeer: NativePeer;
  };
}

export type PreparedMessageElement =
  | PreparedTextElement
  | PreparedImageElement
  | PreparedFileElement
  | PreparedRecordElement
  | PreparedVideoElement
  | PreparedFaceElement
  | PreparedReplyElement;
