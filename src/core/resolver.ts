export type ResolveResult<T> =
  | { kind: "found"; item: T; matchedBy: "id" | "displayId" | "previousDisplayId" }
  | { kind: "ambiguous"; matches: T[] }
  | { kind: "missing" };

export function resolveRef<T extends { id: string }>(
  ref: string,
  primaryIndex: Map<string, T>,
  secondaryIndex: Map<string, T[]>,
  items: readonly T[],
): ResolveResult<T> {
  const byId = primaryIndex.get(ref);
  if (byId) return { kind: "found", item: byId, matchedBy: "id" };

  const byDisplay = secondaryIndex.get(ref);
  if (byDisplay) {
    if (byDisplay.length === 1) return { kind: "found", item: byDisplay[0]!, matchedBy: "displayId" };
    if (byDisplay.length > 1) return { kind: "ambiguous", matches: byDisplay };
  }

  const prevMatches: T[] = [];
  for (const item of items) {
    const prev = (item as Record<string, unknown>).previousDisplayIds;
    if (Array.isArray(prev) && prev.includes(ref)) {
      prevMatches.push(item);
    }
  }
  if (prevMatches.length === 1) return { kind: "found", item: prevMatches[0]!, matchedBy: "previousDisplayId" };
  if (prevMatches.length > 1) return { kind: "ambiguous", matches: prevMatches };

  return { kind: "missing" };
}
