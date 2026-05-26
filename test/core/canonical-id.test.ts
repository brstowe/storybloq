import { describe, it, expect } from "vitest";
import {
  encodeBase32Crockford,
  generateCanonicalId,
  CANONICAL_ID_REGEX,
} from "../../src/core/canonical-id.js";

const TEST_VECTORS: [string, string][] = [
  ["00000000000000000000", "0000000000000000"],
  ["ffffffffffffffffffff", "zzzzzzzzzzzzzzzz"],
  ["00000000000000000001", "0000000000000001"],
  ["00000000000000000020", "0000000000000010"],
  ["48656c6c6f576f726c64", "91jprv3faxqq4v34"],
  ["0123456789abcdef0123", "04hmasw9nf6yy093"],
  ["deadbeefcafebabe1337", "vtpvxvyaztxbw4sq"],
  ["a5a5a5a5a5a5a5a5a5a5", "mpjtb9d5mpjtb9d5"],
  ["80000000000000000000", "g000000000000000"],
  ["7fffffffffffffffffff", "fzzzzzzzzzzzzzzz"],
];

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

describe("encodeBase32Crockford", () => {
  for (const [hex, expected] of TEST_VECTORS) {
    it(`encodes ${hex} -> ${expected}`, () => {
      const bytes = hexToBytes(hex);
      expect(encodeBase32Crockford(bytes)).toBe(expected);
    });
  }

  it("always returns exactly 16 characters for 10 bytes", () => {
    const bytes = hexToBytes("0123456789abcdef0123");
    expect(encodeBase32Crockford(bytes)).toHaveLength(16);
  });

  it("only contains valid Crockford characters", () => {
    const bytes = hexToBytes("deadbeefcafebabe1337");
    const result = encodeBase32Crockford(bytes);
    expect(result).toMatch(/^[0-9a-hjkmnp-tvwxyz]+$/);
  });
});

describe("generateCanonicalId", () => {
  it("produces t- prefix for tickets", () => {
    const id = generateCanonicalId("t");
    expect(id).toMatch(/^t-[0-9a-hjkmnp-tvwxyz]{16}$/);
  });

  it("produces i- prefix for issues", () => {
    const id = generateCanonicalId("i");
    expect(id).toMatch(/^i-[0-9a-hjkmnp-tvwxyz]{16}$/);
  });

  it("produces n- prefix for notes", () => {
    const id = generateCanonicalId("n");
    expect(id).toMatch(/^n-[0-9a-hjkmnp-tvwxyz]{16}$/);
  });

  it("produces l- prefix for lessons", () => {
    const id = generateCanonicalId("l");
    expect(id).toMatch(/^l-[0-9a-hjkmnp-tvwxyz]{16}$/);
  });

  it("generates 1000 unique IDs", () => {
    const ids = new Set<string>();
    for (let j = 0; j < 1000; j++) {
      ids.add(generateCanonicalId("t"));
    }
    expect(ids.size).toBe(1000);
  });
});

describe("CANONICAL_ID_REGEX", () => {
  it("matches valid canonical IDs", () => {
    expect(CANONICAL_ID_REGEX.test("t-k7m2p9x3w4a5b6e8")).toBe(true);
    expect(CANONICAL_ID_REGEX.test("i-0000000000000000")).toBe(true);
    expect(CANONICAL_ID_REGEX.test("n-zzzzzzzzzzzzzzzz")).toBe(true);
    expect(CANONICAL_ID_REGEX.test("l-mpjtb9d5mpjtb9d5")).toBe(true);
  });

  it("rejects legacy IDs", () => {
    expect(CANONICAL_ID_REGEX.test("T-001")).toBe(false);
    expect(CANONICAL_ID_REGEX.test("ISS-001")).toBe(false);
  });

  it("rejects IDs with excluded characters (i, l, o, u)", () => {
    expect(CANONICAL_ID_REGEX.test("t-iiiiiiiiiiiiiiii")).toBe(false);
    expect(CANONICAL_ID_REGEX.test("t-llllllllllllllll")).toBe(false);
    expect(CANONICAL_ID_REGEX.test("t-oooooooooooooooo")).toBe(false);
    expect(CANONICAL_ID_REGEX.test("t-uuuuuuuuuuuuuuuu")).toBe(false);
  });

  it("rejects wrong length", () => {
    expect(CANONICAL_ID_REGEX.test("t-abc")).toBe(false);
    expect(CANONICAL_ID_REGEX.test("t-00000000000000000")).toBe(false);
  });

  it("rejects wrong prefix", () => {
    expect(CANONICAL_ID_REGEX.test("x-0000000000000000")).toBe(false);
    expect(CANONICAL_ID_REGEX.test("0000000000000000")).toBe(false);
  });
});
