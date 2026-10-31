import { createHash, timingSafeEqual } from 'node:crypto';
import { RelayError } from './public-network.mjs';

export const IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}
function validDimensions(width, height) { return width > 0 && height > 0 && width <= 32768 && height <= 32768 && width * height <= 100000000; }

function validPNG(bytes) {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let offset = 8, header = false, data = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (length > bytes.length - offset - 12 || !/^[A-Za-z]{4}$/.test(type)) return false;
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) return false;
    if (!header) {
      if (type !== 'IHDR' || length !== 13 || !validDimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12))) return false;
      header = true;
    } else if (type === 'IHDR') return false;
    if (type === 'IDAT') data = true;
    offset += length + 12;
    if (type === 'IEND') return data && length === 0 && offset === bytes.length;
  }
  return false;
}

function validJPEG(bytes) {
  if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216) return false;
  let offset = 2, dimensions = false, scan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) return false;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 217) return dimensions && scan && offset === bytes.length;
    if (marker === 0 || marker === 216 || marker === undefined) return false;
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    if (offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (length < 8 || !validDimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))) return false;
      dimensions = true;
    }
    offset += length;
    if (marker === 218) {
      scan = true;
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) { offset++; continue; }
        if (bytes[offset + 1] === 0 || bytes[offset + 1] >= 208 && bytes[offset + 1] <= 215) { offset += 2; continue; }
        break;
      }
    }
  }
  return false;
}

function validGIF(bytes, reviewedTail) {
  if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) || !validDimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8))) return false;
  let offset = 13 + (bytes[10] & 128 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0), image = false;
  const skipBlocks = () => {
    while (offset < bytes.length) {
      const length = bytes[offset++];
      if (!length) return true;
      offset += length;
      if (offset > bytes.length) return false;
    }
    return false;
  };
  while (offset < bytes.length) {
    const tag = bytes[offset++];
    if (tag === 59) return image && (offset === bytes.length || reviewedTail
      && reviewedTail.trailerOffset === offset - 1 && reviewedTail.byteLength === bytes.length);
    if (tag === 33) { offset++; if (!skipBlocks()) return false; continue; }
    if (tag !== 44 || offset + 9 > bytes.length) return false;
    if (!validDimensions(bytes.readUInt16LE(offset + 4), bytes.readUInt16LE(offset + 6))) return false;
    const flags = bytes[offset + 8]; offset += 9;
    if (flags & 128) offset += 3 * (1 << ((flags & 7) + 1));
    if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) return false;
    offset++;
    if (!skipBlocks()) return false;
    image = true;
  }
  return false;
}

function validWEBP(bytes, allowAnimation = true) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) !== bytes.length - 8) return false;
  let offset = 12, image = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
    if (length > bytes.length - offset - 8) return false;
    const start = offset + 8;
    if (type === 'VP8 ') {
      if (length < 10 || !bytes.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42])) || !validDimensions(bytes.readUInt16LE(start + 6) & 16383, bytes.readUInt16LE(start + 8) & 16383)) return false;
      image = true;
    } else if (type === 'VP8L') {
      if (length < 5 || bytes[start] !== 47) return false;
      const bits = bytes.readUInt32LE(start + 1);
      if (!validDimensions((bits & 16383) + 1, (bits >>> 14 & 16383) + 1)) return false;
      image = true;
    } else if (type === 'VP8X') {
      if (length !== 10 || !validDimensions(bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1)) return false;
    } else if (type === 'ANMF') {
      // Animated WebP contains frame bitstreams. Do not pretend an arbitrary
      // RIFF container is an image: inspect each frame's nested chunk stream.
      if (!allowAnimation || length < 24) return false;
      const frame = bytes.subarray(start + 16, start + length);
      const container = Buffer.alloc(12 + frame.length);
      container.write('RIFF'); container.writeUInt32LE(container.length - 8, 4); container.write('WEBP', 8); frame.copy(container, 12);
      if (!validWEBP(container, false)) return false;
      image = true;
    }
    offset += 8 + length + (length & 1);
  }
  return image && offset === bytes.length;
}

function matchesHash(bytes, algorithm, expected) {
  if (!expected) return true;
  return timingSafeEqual(createHash(algorithm).update(bytes).digest(), Buffer.from(expected, 'hex'));
}

/** Validates containers and metadata without decoding/recompressing image pixels. */
export function validateImageBytes(bytes, asset, mime = asset.mime) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > asset.maxBytes) throw new RelayError('image-too-large', 413);
  let reviewedTail;
  if (asset.validation?.gifTrailingData && asset.mime === 'image/gif' && /^[a-f0-9]{64}$/.test(asset.sha256 ?? '')) {
    // A reviewed upstream GIF has a valid terminated animation followed by
    // raster residue. Permit only the exact approved bytes, trailer and length;
    // this never enables generic trailing data or changes the returned bytes.
    if (!matchesHash(bytes, 'sha256', asset.sha256)) throw new RelayError('image-checksum-mismatch', 422);
    reviewedTail = asset.validation.gifTrailingData;
  }
  const validators = { 'image/png': validPNG, 'image/jpeg': validJPEG, 'image/gif': validGIF, 'image/webp': validWEBP };
  const valid = mime === 'image/gif' ? validGIF(bytes, reviewedTail) : validators[mime]?.(bytes);
  if (mime !== asset.mime || !valid) throw new RelayError('invalid-image', 422);
  if (!matchesHash(bytes, 'sha256', asset.sha256) || !matchesHash(bytes, 'md5', asset.md5)) throw new RelayError('image-checksum-mismatch', 422);
  return createHash('sha256').update(bytes).digest('hex');
}
