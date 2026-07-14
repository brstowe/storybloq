import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { BusError } from "./errors.js";

function assertIJson(value: unknown, path = "$"): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new BusError("invalid_input", `Non-finite number at ${path}`);
  }
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          throw new BusError("invalid_input", `Lone UTF-16 surrogate at ${path}`);
        }
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new BusError("invalid_input", `Lone UTF-16 surrogate at ${path}`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertIJson(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) {
        throw new BusError("invalid_input", `Undefined value at ${path}.${key}`);
      }
      assertIJson(key, `${path}.<key>`);
      assertIJson(entry, `${path}.${key}`);
    }
  }
}

export function canonicalJson(value: unknown): string {
  assertIJson(value);
  const output = canonicalize(value);
  if (typeof output !== "string") {
    throw new BusError("invalid_input", "Value cannot be represented as canonical JSON");
  }
  return output;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalHash(value: unknown): string {
  return sha256(Buffer.from(canonicalJson(value), "utf-8"));
}

export function hashWithoutKey<T extends Record<string, unknown>>(value: T, key: keyof T): string {
  const copy = { ...value };
  delete copy[key];
  return canonicalHash(copy);
}
