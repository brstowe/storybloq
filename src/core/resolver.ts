export type ResolveResult<T> =
  | { kind: "found"; item: T; matchedBy: "id" | "displayId" | "previousDisplayId" }
  | { kind: "ambiguous"; matches: T[] }
  | { kind: "missing" };

export function resolveRef<T extends { id: string }>(
  ref: string,
  primaryIndex: Map<string, T>,
  secondaryIndex: Map<string, T[]>,
  items: T[],
): ResolveResult<T> {
  const byId = primaryIndex.get(ref);
  if (byId) return { kind: "found", item: byId, matchedBy: "id" };

  const byDisplay = secondaryIndex.get(ref);
  if (byDisplay) {
    if (byDisplay.length === 1) return { kind: "found", item: byDisplay[0]!, matchedBy: "displayId" };
    if (byDisplay.length > 1) return { kind: "ambiguous", matches: byDisplay };
  }

  for (const item of items) {
    const prev = (item as Record<string, unknown>).previousDisplayIds;
    if (Array.isArray(prev) && prev.includes(ref)) {
      return { kind: "found", item, matchedBy: "previousDisplayId" };
    }
  }

  return { kind: "missing" };
}
