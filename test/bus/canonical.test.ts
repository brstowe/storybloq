import { describe, expect, it } from "vitest";
import { canonicalHash, canonicalJson } from "../../src/bus/canonical.js";

describe("Storybloq Bus canonical JSON", () => {
  it("matches the RFC 8785 serialization example", () => {
    const value = {
      numbers: [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
      string: "€$\u000f\nA'B\"\\\"/",
      literals: [null, true, false],
    };
    expect(canonicalJson(value)).toBe(
      "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\"/\"}",
    );
  });

  it("is independent of object insertion order", () => {
    expect(canonicalHash({ b: 2, a: 1 })).toBe(canonicalHash({ a: 1, b: 2 }));
  });

  it("rejects non-I-JSON values and lone surrogates", () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/Non-finite/);
    expect(() => canonicalJson({ value: "\ud800" })).toThrow(/surrogate/);
  });
});
