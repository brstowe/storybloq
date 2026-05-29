import { displayIdOf } from "./resolver.js";
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length; // 62
const MID = DIGITS[Math.floor(BASE / 2)]!; // "V"

function charIndex(c: string): number {
  const i = DIGITS.indexOf(c);
  if (i === -1) throw new Error(`Invalid rank character: ${c}`);
  return i;
}

export function generateKeyBetween(a: string | null, b: string | null): string {
  if (a === null && b === null) return MID;

  if (a === null) {
    const firstChar = charIndex(b![0]!);
    if (firstChar > 0) {
      return DIGITS[Math.floor(firstChar / 2)]!;
    }
    if (b!.length <= 1) {
      throw new Error(`Cannot generate key before minimum rank "${b}"`);
    }
    const rest = b!.slice(1);
    if (rest.split("").every((c) => charIndex(c) === 0)) {
      return b!.slice(0, -1);
    }
    return b![0]! + generateKeyBetween(null, rest);
  }

  if (b === null) {
    const lastChar = charIndex(a[a.length - 1]!);
    if (lastChar < BASE - 1) {
      return a.slice(0, -1) + DIGITS[Math.ceil((lastChar + BASE - 1) / 2)]!;
    }
    return a + MID;
  }

  return midpoint(a, b);
}

function midpoint(a: string, b: string): string {
  if (a >= b) throw new Error(`midpoint requires a < b, got a="${a}", b="${b}"`);
  const maxLen = Math.max(a.length, b.length);

  for (let i = 0; i < maxLen; i++) {
    const aChar = i < a.length ? charIndex(a[i]!) : 0;
    const bChar = i < b.length ? charIndex(b[i]!) : BASE;

    if (aChar < bChar - 1) {
      const mid = Math.floor((aChar + bChar) / 2);
      return a.slice(0, i) + DIGITS[mid]!;
    }

    if (aChar === bChar - 1) {
      const suffix = a.slice(0, i) + a[i]!;
      const aRest = a.slice(i + 1);
      const bRest = "";
      return suffix + midpointSuffix(aRest, bRest);
    }
  }

  throw new Error(`Cannot generate key between "${a}" and "${b}"`);
}

function midpointSuffix(a: string, _b: string): string {
  if (a.length === 0) return MID;

  const lastChar = charIndex(a[a.length - 1]!);
  if (lastChar < BASE - 1) {
    return a.slice(0, -1) + DIGITS[Math.ceil((lastChar + BASE - 1) / 2)]!;
  }
  return a + MID;
}

export function validateRank(rank: string): boolean {
  if (rank.length === 0) return false;
  for (const c of rank) {
    if (DIGITS.indexOf(c) === -1) return false;
  }
  return true;
}

export const REBALANCE_THRESHOLD = 10;

function extractNumericSuffix(s: string): number | null {
  const m = /(\d+)$/.exec(s);
  return m ? parseInt(m[1]!, 10) : null;
}

export function compareByRank(
  a: { rank?: string; order?: number; id: string; displayId?: string | null },
  b: { rank?: string; order?: number; id: string; displayId?: string | null },
): number {
  const aHasRank = a.rank != null;
  const bHasRank = b.rank != null;

  if (aHasRank && bHasRank) {
    const cmp = a.rank! < b.rank! ? -1 : a.rank! > b.rank! ? 1 : 0;
    if (cmp !== 0) return cmp;
  }

  if (aHasRank && !bHasRank) return -1;
  if (!aHasRank && bHasRank) return 1;

  const aOrder = a.order ?? 0;
  const bOrder = b.order ?? 0;
  if (aOrder !== bOrder) return aOrder - bOrder;

  const aNum = extractNumericSuffix(displayIdOf(a));
  const bNum = extractNumericSuffix(displayIdOf(b));
  if (aNum !== null && bNum !== null && aNum !== bNum) return aNum - bNum;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function rebalanceRanks(count: number): string[] {
  if (count === 0) return [];
  const ranks: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < count; i++) {
    const key = generateKeyBetween(prev, null);
    ranks.push(key);
    prev = key;
  }
  return ranks;
}
