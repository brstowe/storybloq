import { getMergeRules, getCoupledGroups, type EntityType, type MergeRule } from "./field-classification.js";

export interface ConflictEntry {
  fieldPath: string;
  kind: "field" | "coupled" | "delete-edit";
  base: unknown;
  ours: unknown;
  theirs: unknown;
  group?: string;
}

export interface MergeResult {
  merged: Record<string, unknown>;
  conflicts: ConflictEntry[];
  clean: boolean;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
  for (const k of keys) {
    if (!deepEqual(aObj[k], bObj[k])) return false;
  }
  return true;
}

function isDeleted(obj: Record<string, unknown>): boolean {
  return obj.lifecycle === "deleted" || (obj.deletedAt != null && obj.deletedAt !== undefined);
}

function hasNonTombstoneChanges(base: Record<string, unknown>, changed: Record<string, unknown>): boolean {
  const tombstoneFields = new Set(["lifecycle", "deletedAt", "deletedBy"]);
  const allKeys = new Set([...Object.keys(base), ...Object.keys(changed)]);
  for (const k of allKeys) {
    if (tombstoneFields.has(k) || k === "_conflicts") continue;
    if (!deepEqual(base[k], changed[k])) return true;
  }
  return false;
}

function commutativeMerge(base: unknown[], ours: unknown[], theirs: unknown[]): unknown[] {
  const baseSet = new Set(base.map((v) => JSON.stringify(v)));
  const oursSet = new Set(ours.map((v) => JSON.stringify(v)));
  const theirsSet = new Set(theirs.map((v) => JSON.stringify(v)));

  const addedByOurs = new Set([...oursSet].filter((v) => !baseSet.has(v)));
  const addedByTheirs = new Set([...theirsSet].filter((v) => !baseSet.has(v)));
  const deletedByOurs = new Set([...baseSet].filter((v) => !oursSet.has(v)));
  const deletedByTheirs = new Set([...baseSet].filter((v) => !theirsSet.has(v)));

  const result = new Set<string>();
  for (const v of baseSet) {
    if (!deletedByOurs.has(v) && !deletedByTheirs.has(v)) result.add(v);
  }
  for (const v of addedByOurs) result.add(v);
  for (const v of addedByTheirs) result.add(v);

  return [...result].sort().map((v) => JSON.parse(v));
}

export function threeWayMerge(
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  entityType: EntityType,
): MergeResult {
  const rules = getMergeRules(entityType);
  const conflicts: ConflictEntry[] = [];
  const merged: Record<string, unknown> = {};

  const existingConflicts: unknown[] = [];
  for (const src of [base, ours, theirs]) {
    if (Array.isArray(src._conflicts)) {
      for (const c of src._conflicts) {
        const key = JSON.stringify({ fp: (c as Record<string, unknown>).fieldPath, k: (c as Record<string, unknown>).kind, g: (c as Record<string, unknown>).group });
        if (!existingConflicts.some((e) => JSON.stringify({ fp: (e as Record<string, unknown>).fieldPath, k: (e as Record<string, unknown>).kind, g: (e as Record<string, unknown>).group }) === key)) {
          existingConflicts.push(c);
        }
      }
    }
  }

  const baseDeleted = !isDeleted(base) && isDeleted(ours);
  const theirsDeleted = !isDeleted(base) && isDeleted(theirs);

  if (baseDeleted && theirsDeleted) {
    Object.assign(merged, ours);
    delete merged._conflicts;
    if (existingConflicts.length > 0) merged._conflicts = existingConflicts;
    return { merged, conflicts, clean: conflicts.length === 0 };
  }

  if (baseDeleted && !theirsDeleted && hasNonTombstoneChanges(base, theirs)) {
    conflicts.push({ fieldPath: "_entity", kind: "delete-edit", base: "active", ours: "deleted", theirs: "edited" });
    Object.assign(merged, base);
    merged._conflicts = [...existingConflicts, ...conflicts];
    return { merged, conflicts, clean: false };
  }

  if (theirsDeleted && !baseDeleted && hasNonTombstoneChanges(base, ours)) {
    conflicts.push({ fieldPath: "_entity", kind: "delete-edit", base: "active", ours: "edited", theirs: "deleted" });
    Object.assign(merged, base);
    merged._conflicts = [...existingConflicts, ...conflicts];
    return { merged, conflicts, clean: false };
  }

  const coupledGroups = getCoupledGroups(entityType);
  const handledByCoupled = new Set<string>();

  for (const group of coupledGroups) {
    const baseSnapshot = Object.fromEntries(group.members.map((m) => [m, base[m]]));
    const oursSnapshot = Object.fromEntries(group.members.map((m) => [m, ours[m]]));
    const theirsSnapshot = Object.fromEntries(group.members.map((m) => [m, theirs[m]]));

    const oursChanged = !deepEqual(baseSnapshot, oursSnapshot);
    const theirsChanged = !deepEqual(baseSnapshot, theirsSnapshot);

    if (!oursChanged && !theirsChanged) {
      for (const m of group.members) { merged[m] = base[m]; handledByCoupled.add(m); }
    } else if (!oursChanged) {
      for (const m of group.members) { merged[m] = theirs[m]; handledByCoupled.add(m); }
    } else if (!theirsChanged) {
      for (const m of group.members) { merged[m] = ours[m]; handledByCoupled.add(m); }
    } else if (deepEqual(oursSnapshot, theirsSnapshot)) {
      for (const m of group.members) { merged[m] = ours[m]; handledByCoupled.add(m); }
    } else {
      for (const m of group.members) {
        merged[m] = base[m];
        handledByCoupled.add(m);
        conflicts.push({
          fieldPath: m,
          kind: "coupled",
          base: base[m],
          ours: ours[m],
          theirs: theirs[m],
          group: group.group,
        });
      }
    }
  }

  const allKeys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
  allKeys.delete("_conflicts");

  for (const key of allKeys) {
    if (handledByCoupled.has(key)) continue;

    const bVal = base[key];
    const oVal = ours[key];
    const tVal = theirs[key];

    if (deepEqual(bVal, oVal) && deepEqual(bVal, tVal)) {
      merged[key] = bVal;
      continue;
    }
    if (deepEqual(oVal, tVal)) {
      merged[key] = oVal;
      continue;
    }
    if (deepEqual(bVal, oVal)) {
      merged[key] = tVal;
      continue;
    }
    if (deepEqual(bVal, tVal)) {
      merged[key] = oVal;
      continue;
    }

    const rule: MergeRule | undefined = rules[key];

    if (!rule || rule.kind === "hard-conflict") {
      merged[key] = bVal;
      conflicts.push({ fieldPath: key, kind: "field", base: bVal, ours: oVal, theirs: tVal });
      continue;
    }

    if (rule.kind === "identity") {
      merged[key] = bVal;
      continue;
    }

    if (rule.kind === "commutative") {
      const bArr = Array.isArray(bVal) ? bVal : [];
      const oArr = Array.isArray(oVal) ? oVal : [];
      const tArr = Array.isArray(tVal) ? tVal : [];
      merged[key] = commutativeMerge(bArr, oArr, tArr);
      continue;
    }

    if (rule.kind === "monotonic") {
      const oNum = typeof oVal === "number" ? oVal : 0;
      const tNum = typeof tVal === "number" ? tVal : 0;
      merged[key] = Math.max(oNum, tNum);
      continue;
    }

    if (rule.kind === "latest-wins") {
      const oObj = (typeof oVal === "object" && oVal !== null) ? oVal as Record<string, unknown> : {};
      const tObj = (typeof tVal === "object" && tVal !== null) ? tVal as Record<string, unknown> : {};
      const oTs = String(oObj[rule.timestampField] ?? "");
      const tTs = String(tObj[rule.timestampField] ?? "");
      if (oTs >= tTs) {
        merged[key] = oVal;
      } else {
        merged[key] = tVal;
      }
      continue;
    }

    merged[key] = bVal;
    conflicts.push({ fieldPath: key, kind: "field", base: bVal, ours: oVal, theirs: tVal });
  }

  if (conflicts.length > 0 || existingConflicts.length > 0) {
    merged._conflicts = [...existingConflicts, ...conflicts];
  }

  return { merged, conflicts, clean: conflicts.length === 0 };
}
