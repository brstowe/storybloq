import { describe, it, expect } from "vitest";
import { generateKeyBetween, validateRank, compareByRank } from "../../src/core/fractional-index.js";

describe("generateKeyBetween", () => {
  it("returns a starting key when both null", () => {
    const key = generateKeyBetween(null, null);
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
    expect(validateRank(key)).toBe(true);
  });

  it("returns key > a when b is null", () => {
    const key = generateKeyBetween("V", null);
    expect(key > "V").toBe(true);
    expect(validateRank(key)).toBe(true);
  });

  it("returns key < a when a is null", () => {
    const key = generateKeyBetween(null, "V");
    expect(key < "V").toBe(true);
    expect(validateRank(key)).toBe(true);
  });

  it("returns key between a and b", () => {
    const key = generateKeyBetween("B", "D");
    expect(key > "B").toBe(true);
    expect(key < "D").toBe(true);
    expect(validateRank(key)).toBe(true);
  });

  it("extends key length with adjacent chars", () => {
    const key = generateKeyBetween("a", "b");
    expect(key > "a").toBe(true);
    expect(key < "b").toBe(true);
    expect(key.length).toBeGreaterThan(1);
  });

  it("maintains sort order across 20 sequential insertions", () => {
    const keys: string[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 20; i++) {
      const key = generateKeyBetween(prev, null);
      expect(validateRank(key)).toBe(true);
      if (prev !== null) {
        expect(key > prev).toBe(true);
      }
      keys.push(key);
      prev = key;
    }
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });
});

describe("validateRank", () => {
  it("accepts valid rank strings", () => {
    expect(validateRank("V")).toBe(true);
    expect(validateRank("abc")).toBe(true);
    expect(validateRank("0123456789")).toBe(true);
    expect(validateRank("AZaz09")).toBe(true);
  });

  it("rejects invalid characters", () => {
    expect(validateRank("")).toBe(false);
    expect(validateRank("a b")).toBe(false);
    expect(validateRank("a!b")).toBe(false);
    expect(validateRank("a_b")).toBe(false);
  });
});

describe("compareByRank", () => {
  it("sorts ranked before unranked", () => {
    const a = { rank: "V", id: "T-002" };
    const b = { order: 10, id: "T-001" };
    expect(compareByRank(a, b)).toBeLessThan(0);
  });

  it("uses id tie-breaker on duplicate ranks", () => {
    const a = { rank: "V", id: "T-001" };
    const b = { rank: "V", id: "T-002" };
    expect(compareByRank(a, b)).toBeLessThan(0);
  });
});
