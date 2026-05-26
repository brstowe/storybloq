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
    return midpoint("", b!);
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

  return a.slice(0, maxLen) + MID;
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

export function compareByRank(
  a: { rank?: string; order?: number; id: string },
  b: { rank?: string; order?: number; id: string },
): number {
  const aHasRank = a.rank != null;
  const bHasRank = b.rank != null;

  if (aHasRank && bHasRank) {
    const cmp = a.rank! < b.rank! ? -1 : a.rank! > b.rank! ? 1 : 0;
    if (cmp !== 0) return cmp;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  if (aHasRank && !bHasRank) return -1;
  if (!aHasRank && bHasRank) return 1;

  const aOrder = a.order ?? 0;
  const bOrder = b.order ?? 0;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
