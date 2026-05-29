export type ResolveResult<T> =
  | { kind: "found"; item: T; matchedBy: "id" | "displayId" | "previousDisplayId" }
  | { kind: "ambiguous"; matches: T[] }
  | { kind: "missing" };

export function resolveRef<T extends { id: string }>(
  ref: string,
  primaryIndex: Map<string, T>,
  secondaryIndex: Map<string, T[]>,
  items: readonly T[],
  prevDisplayIndex?: ReadonlyMap<string, T[]>,
): ResolveResult<T> {
  const byId = primaryIndex.get(ref);
  if (byId) return { kind: "found", item: byId, matchedBy: "id" };

  const byDisplay = secondaryIndex.get(ref);
  if (byDisplay) {
    if (byDisplay.length === 1) return { kind: "found", item: byDisplay[0]!, matchedBy: "displayId" };
    if (byDisplay.length > 1) return { kind: "ambiguous", matches: byDisplay };
  }

  if (prevDisplayIndex) {
    const prevMatches = prevDisplayIndex.get(ref);
    if (prevMatches) {
      if (prevMatches.length === 1) return { kind: "found", item: prevMatches[0]!, matchedBy: "previousDisplayId" };
      if (prevMatches.length > 1) return { kind: "ambiguous", matches: prevMatches };
    }
  } else {
    const prevMatches: T[] = [];
    for (const item of items) {
      const prev = (item as Record<string, unknown>).previousDisplayIds;
      if (Array.isArray(prev) && prev.includes(ref)) {
        prevMatches.push(item);
      }
    }
    if (prevMatches.length === 1) return { kind: "found", item: prevMatches[0]!, matchedBy: "previousDisplayId" };
    if (prevMatches.length > 1) return { kind: "ambiguous", matches: prevMatches };
  }

  return { kind: "missing" };
}

export function buildPrevDisplayIndex<T>(
  items: readonly T[],
): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const item of items) {
    const prev = (item as Record<string, unknown>).previousDisplayIds;
    if (Array.isArray(prev)) {
      for (const p of prev) {
        if (typeof p === "string") {
          // ISS-699/ISS-708: mirror Swift buildPreviousDisplayIdIndex -- trim each
          // previous displayId and skip blank entries, indexing under the trimmed
          // form. Previously TS keyed verbatim, so a hand-edited "  T-051 " resolved
          // on Mac (trimmed key) but not via the CLI, and "" became a stray key.
          const trimmed = p.trim();
          if (trimmed === "") continue;
          const existing = index.get(trimmed);
          if (existing) { existing.push(item); }
          else { index.set(trimmed, [item]); }
        }
      }
    }
  }
  return index;
}
