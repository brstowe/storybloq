import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function encodeBase32Crockford(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < 16; i++) {
    const bitOffset = i * 5;
    const byteIndex = bitOffset >>> 3;
    const shift = bitOffset & 7;
    const value =
      ((bytes[byteIndex]! << shift) |
        (shift > 3 && byteIndex + 1 < bytes.length
          ? bytes[byteIndex + 1]! >>> (8 - shift)
          : 0)) &
      0xff;
    result += ALPHABET[(value >>> 3) & 0x1f];
  }
  return result;
}

export type CanonicalPrefix = "t" | "i" | "n" | "l";

export function generateCanonicalId(prefix: CanonicalPrefix): string {
  const bytes = randomBytes(10);
  return `${prefix}-${encodeBase32Crockford(bytes)}`;
}

export const CANONICAL_ID_REGEX = /^[tinl]-[0-9a-hjkmnp-tvwxyz]{16}$/;
