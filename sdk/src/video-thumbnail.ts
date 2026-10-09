/** Validate the codec thumbnail's declared format and encoded dimensions. This
 * checks headers, not full image decoding; the supplied codec is trusted code. */
export function videoThumbnail(data: Buffer, format: unknown): string {
  let actualWidth = 0, actualHeight = 0;
  let extension: string;
  if (format === 'png') {
    extension = 'png';
    if (data.length < 24 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || data.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid video thumbnail PNG header');
    actualWidth = data.readUInt32BE(16); actualHeight = data.readUInt32BE(20);
  } else if (format === 'jpg' || format === 'jpeg') {
    extension = 'jpg';
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw new Error('Invalid video thumbnail JPEG header');
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset] !== 0xff) throw new Error('Invalid video thumbnail JPEG marker');
      while (offset < data.length && data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) throw new Error('Truncated video thumbnail JPEG');
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) throw new Error('Invalid video thumbnail JPEG segment');
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker!)) {
        if (length < 8) throw new Error('Invalid video thumbnail JPEG dimensions');
        actualWidth = data.readUInt16BE(offset + 5); actualHeight = data.readUInt16BE(offset + 3); break;
      }
      offset += length;
    }
  } else if (format === 'bmp' || format === 'bmp24') {
    extension = 'bmp';
    if (data.length < 54 || data.toString('ascii', 0, 2) !== 'BM' || data.readUInt32LE(14) < 40 || 14 + data.readUInt32LE(14) > data.length || data.readUInt16LE(26) !== 1 || (format === 'bmp24' && data.readUInt16LE(28) !== 24)) throw new Error('Invalid video thumbnail BMP header');
    actualWidth = data.readInt32LE(18); actualHeight = Math.abs(data.readInt32LE(22));
  } else throw new Error('Unsupported video thumbnail format');
  if (!Number.isSafeInteger(actualWidth) || actualWidth <= 0 || !Number.isSafeInteger(actualHeight) || actualHeight <= 0) throw new Error('Invalid video thumbnail dimensions');
  return extension;
}
