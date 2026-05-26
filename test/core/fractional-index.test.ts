import { describe, it, expect } from "vitest";
import { generateKeyBetween, validateRank, compareByRank, rebalanceRanks, REBALANCE_THRESHOLD } from "../../src/core/fractional-index.js";

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

  it("displayId numeric: T-001 before T-010 (numeric not string)", () => {
    const a = { order: 10, id: "t-abc", displayId: "T-001" };
    const b = { order: 10, id: "t-def", displayId: "T-010" };
    expect(compareByRank(a, b)).toBeLessThan(0);
  });

  it("displayId numeric: T-2 before T-10 (not string order)", () => {
    const a = { order: 10, id: "t-abc", displayId: "T-2" };
    const b = { order: 10, id: "t-def", displayId: "T-10" };
    expect(compareByRank(a, b)).toBeLessThan(0);
  });

  it("missing displayId falls back to id string comparison", () => {
    const a = { order: 10, id: "t-aaa" };
    const b = { order: 10, id: "t-zzz" };
    expect(compareByRank(a, b)).toBeLessThan(0);
  });

  it("mixed prefix ISS-001 vs T-001 uses numeric extraction", () => {
    const a = { order: 10, id: "t-a", displayId: "ISS-001" };
    const b = { order: 10, id: "t-b", displayId: "T-001" };
    const cmp = compareByRank(a, b);
    expect(typeof cmp).toBe("number");
  });
});

describe("rebalanceRanks", () => {
  it("generates correct count of evenly-spaced values", () => {
    const ranks = rebalanceRanks(5);
    expect(ranks).toHaveLength(5);
    for (let i = 0; i < ranks.length - 1; i++) {
      expect(ranks[i]! < ranks[i + 1]!).toBe(true);
    }
  });

  it("output values are all shorter than REBALANCE_THRESHOLD", () => {
    const ranks = rebalanceRanks(20);
    for (const r of ranks) {
      expect(r.length).toBeLessThanOrEqual(REBALANCE_THRESHOLD);
    }
  });
});
