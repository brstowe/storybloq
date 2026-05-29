import { displayIdOf } from "./resolver.js";
import { execFileSync } from "node:child_process";
import type { ProjectState } from "./project-state.js";
import type { LoadWarning } from "./errors.js";
import { isClaimStale } from "./claims.js";
import { compareVersionStrings } from "./team-capabilities.js";

export type DoctorSeverity = "error" | "warning" | "info";

export type DoctorRepair =
  | { command: string[] }
  | { manualSteps: string[] }
  | null;

export interface DoctorFinding {
  severity: DoctorSeverity;
  code: string;
  message: string;
  entity: string | null;
  repair: DoctorRepair;
}

export interface DoctorContext {
  root: string;
  cliVersion: string | null;
  isTeamMode: boolean;
  loadWarnings: readonly LoadWarning[];
}

export type DoctorCheck = (state: ProjectState, ctx: DoctorContext) => DoctorFinding[] | Promise<DoctorFinding[]>;

export const defaultChecks: DoctorCheck[] = [];

export function registerDoctorCheck(check: DoctorCheck): void {
  defaultChecks.push(check);
}

export interface DoctorResult {
  findings: DoctorFinding[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
}

export async function runDoctor(
  state: ProjectState,
  ctx: DoctorContext,
  checks?: DoctorCheck[],
): Promise<DoctorResult> {
  const activeChecks = checks ?? defaultChecks;
  const findings: DoctorFinding[] = [];

  if (!ctx.isTeamMode) {
    findings.push({
      severity: "info",
      code: "not_team_mode",
      message: "Not a team-mode project. Team doctor checks skipped.",
      entity: null,
      repair: null,
    });
    return buildResult(findings);
  }

  for (const check of activeChecks) {
    findings.push(...(await check(state, ctx)));
  }

  return buildResult(findings);
}

function buildResult(findings: DoctorFinding[]): DoctorResult {
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  for (const f of findings) {
    if (f.severity === "error") errorCount++;
    else if (f.severity === "warning") warningCount++;
    else infoCount++;
  }
  return { findings, errorCount, warningCount, infoCount };
}

function checkDuplicateDisplayIds(state: ProjectState): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  const entityGroups: Array<{ type: string; items: readonly { id: string; displayId?: string | null }[] }> = [
    { type: "ticket", items: state.tickets },
    { type: "issue", items: state.issues },
    { type: "note", items: state.notes },
    { type: "lesson", items: state.lessons },
  ];

  for (const { type, items } of entityGroups) {
    const seen = new Map<string, string[]>();
    for (const item of items) {
      const did = displayIdOf(item);
      let ids = seen.get(did);
      if (!ids) {
        ids = [];
        seen.set(did, ids);
      }
      ids.push(item.id);
    }
    for (const [displayId, ids] of seen) {
      if (ids.length > 1) {
        findings.push({
          severity: "error",
          code: "duplicate_display_id",
          message: `Duplicate ${type} displayId '${displayId}': ${ids.join(", ")}`,
          entity: displayId,
          repair: { command: ["storybloq", "reconcile"] },
        });
      }
    }
  }

  return findings;
}

function checkMissingDisplayId(state: ProjectState, ctx: DoctorContext): DoctorFinding[] {
  if (!ctx.isTeamMode) return [];
  const findings: DoctorFinding[] = [];

  const entityGroups: Array<{ type: string; items: readonly { id: string; displayId?: string | null }[] }> = [
    { type: "ticket", items: state.tickets },
    { type: "issue", items: state.issues },
    { type: "note", items: state.notes },
    { type: "lesson", items: state.lessons },
  ];

  for (const { type, items } of entityGroups) {
    for (const item of items) {
      if (!item.displayId) {
        findings.push({
          severity: "warning",
          code: "missing_display_id",
          message: `${type} ${item.id} has no displayId`,
          entity: item.id,
          repair: { manualSteps: [`Add "displayId" field to ${item.id}`] },
        });
      }
    }
  }

  return findings;
}

function checkUnresolvableRefs(state: ProjectState): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  for (const t of state.tickets) {
    for (const ref of t.blockedBy) {
      const resolved = state.resolveTicketRef(ref);
      if (resolved.kind !== "found") {
        findings.push({
          severity: "warning",
          code: "unresolvable_ref",
          message: `Ticket ${displayIdOf(t)} has unresolvable blockedBy ref '${ref}'`,
          entity: t.id,
          repair: { command: ["storybloq", "repair"] },
        });
      }
    }
    if (t.parentTicket) {
      const resolved = state.resolveTicketRef(t.parentTicket);
      if (resolved.kind !== "found") {
        findings.push({
          severity: "warning",
          code: "unresolvable_ref",
          message: `Ticket ${displayIdOf(t)} has unresolvable parentTicket ref '${t.parentTicket}'`,
          entity: t.id,
          repair: { command: ["storybloq", "repair"] },
        });
      }
    }
  }

  for (const i of state.issues) {
    for (const ref of i.relatedTickets) {
      const resolved = state.resolveTicketRef(ref);
      if (resolved.kind !== "found") {
        findings.push({
          severity: "warning",
          code: "unresolvable_ref",
          message: `Issue ${displayIdOf(i)} has unresolvable relatedTickets ref '${ref}'`,
          entity: i.id,
          repair: { command: ["storybloq", "repair"] },
        });
      }
    }
  }

  return findings;
}

function checkCliVersion(state: ProjectState, ctx: DoctorContext): DoctorFinding[] {
  const minVersion = state.config.team?.minCliVersion;
  if (!minVersion || !ctx.cliVersion) return [];

  if (compareVersionStrings(ctx.cliVersion, minVersion) < 0) {
    return [{
      severity: "warning",
      code: "cli_version_mismatch",
      message: `CLI version ${ctx.cliVersion} is below required ${minVersion}`,
      entity: null,
      repair: { command: ["npm", "update", "-g", "@storybloq/storybloq"] },
    }];
  }
  return [];
}

function checkDuplicateCanonicalIds(state: ProjectState): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  const entityGroups: Array<{ type: string; items: readonly { id: string }[] }> = [
    { type: "ticket", items: state.tickets },
    { type: "issue", items: state.issues },
    { type: "note", items: state.notes },
    { type: "lesson", items: state.lessons },
  ];

  for (const { type, items } of entityGroups) {
    const counts = new Map<string, number>();
    for (const item of items) {
      counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
    }
    for (const [id, count] of counts) {
      if (count > 1) {
        findings.push({
          severity: "error",
          code: "duplicate_canonical_id",
          message: `Duplicate ${type} canonical ID: ${id} appears ${count} times`,
          entity: id,
          repair: { manualSteps: [`Inspect and resolve duplicate files for ${id}`] },
        });
      }
    }
  }

  return findings;
}

function checkLoadWarnings(_state: ProjectState, ctx: DoctorContext): DoctorFinding[] {
  return ctx.loadWarnings.map((w) => ({
    severity: "warning" as DoctorSeverity,
    code: `load_warning_${w.type}`,
    message: `${w.file}: ${w.message}`,
    entity: w.file,
    repair: null,
  }));
}

/** Lists remote branch names so the stale-claim check can detect deleted branches. */
export type RemoteBranchLister = (root: string) => Set<string>;

/**
 * Parses `git branch -r` output into the set of branch names a claim may match.
 * Every remote-tracking name is kept verbatim (e.g. `origin/feat/x`) so a claim
 * recorded with its remote prefix matches exactly. Additionally, the names of
 * the DEFAULT remote (`origin` if present, otherwise the sole remote) are added
 * with the prefix stripped (`feat/x`), because claims record the local branch
 * name and local work pushes to the default remote. Names are NOT stripped for
 * non-default remotes: with multiple remotes a bare `feat/x` would be ambiguous,
 * so only an exact `<remote>/feat/x` match counts for those. The symbolic HEAD
 * line (`origin/HEAD -> origin/main`) is skipped.
 */
export function parseRemoteBranches(stdout: string): Set<string> {
  const fullNames = new Set<string>();
  const remotes = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line || line.includes("->")) continue;
    fullNames.add(line);
    const slash = line.indexOf("/");
    if (slash !== -1) remotes.add(line.slice(0, slash));
  }

  const defaultRemote = remotes.has("origin")
    ? "origin"
    : remotes.size === 1
      ? [...remotes][0]!
      : null;

  const names = new Set(fullNames);
  if (defaultRemote !== null) {
    const prefix = defaultRemote + "/";
    for (const full of fullNames) {
      if (full.startsWith(prefix)) names.add(full.slice(prefix.length));
    }
  }
  return names;
}

/**
 * Returns the set of remote branch names known to git, per N-059's stale-claim
 * rule that checks branch existence via `git branch -r`. See parseRemoteBranches
 * for the matching semantics. Returns an empty set when git is unavailable, the
 * directory is not a repo, or no remote branches exist; callers skip the
 * branch-gone check in that case because a deleted branch cannot be told apart
 * from one that was never pushed.
 */
export function listRemoteBranchNames(root: string): Set<string> {
  try {
    const stdout = execFileSync("git", ["branch", "-r"], {
      cwd: root,
      encoding: "utf-8",
      timeout: 5000,
    });
    return parseRemoteBranches(stdout);
  } catch {
    return new Set();
  }
}

/**
 * A claim's branch is "gone" when it is not among the known remote branches.
 * An empty/whitespace branch yields false: with no branch recorded we cannot
 * judge its existence and must not flag a false positive.
 */
export function isClaimBranchGone(
  branch: string | undefined,
  remoteBranches: ReadonlySet<string>,
): boolean {
  const trimmed = (branch ?? "").trim();
  if (trimmed === "") return false;
  return !remoteBranches.has(trimmed);
}

export function checkStaleClaims(
  state: ProjectState,
  ctx: DoctorContext,
  listBranches: RemoteBranchLister = listRemoteBranchNames,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const threshold = state.config.team?.claimStalenessHours ?? 48;
  const now = Date.now();

  // N-059 stale-claim condition 3: the claimed branch no longer exists, checked
  // via `git branch -r`. Gather the remote branch set once. When git is
  // unavailable or no remote branches exist the set is empty and the branch-gone
  // check is skipped -- a deleted branch cannot be distinguished from one never
  // pushed, so claims are not flagged on that basis.
  const remoteBranches = listBranches(ctx.root);

  for (const t of state.tickets) {
    if (!t.claim) continue;
    // Tombstoned tickets are hidden from every suggestion surface; a residual
    // claim on a deleted ticket is handled by reconcile/gc, not flagged here.
    if ((t as Record<string, unknown>).lifecycle === "deleted") continue;

    if (t.status === "complete") {
      findings.push({
        severity: "warning",
        code: "claim_on_complete",
        message: `Ticket ${displayIdOf(t)} is complete but still has claim by ${t.claim.user}`,
        entity: t.id,
        repair: { command: ["storybloq", "ticket", "unclaim", t.id] },
      });
    } else if (isClaimStale(t.claim, threshold, now)) {
      findings.push({
        severity: "warning",
        code: "stale_claim",
        message: `Ticket ${displayIdOf(t)} has stale claim by ${t.claim.user} (since ${t.claim.since})`,
        entity: t.id,
        repair: { command: ["storybloq", "ticket", "unclaim", t.id] },
      });
    } else if (remoteBranches.size > 0 && isClaimBranchGone(t.claim.branch, remoteBranches)) {
      findings.push({
        severity: "warning",
        code: "stale_claim",
        message: `Ticket ${displayIdOf(t)} has claim by ${t.claim.user} on branch '${t.claim.branch}' which no longer exists`,
        entity: t.id,
        repair: { command: ["storybloq", "ticket", "unclaim", t.id] },
      });
    }
  }

  return findings;
}

function checkStaleTombstones(state: ProjectState, _ctx: DoctorContext): DoctorFinding[] {
  const now = Date.now();
  const retentionMs = 30 * 24 * 60 * 60 * 1000;
  let count = 0;
  for (const collection of [state.tickets, state.issues, state.notes, state.lessons]) {
    for (const item of collection) {
      const rec = item as Record<string, unknown>;
      if (rec.lifecycle !== "deleted") continue;
      const deletedAt = rec.deletedAt;
      if (typeof deletedAt !== "string") continue;
      const ts = Date.parse(deletedAt);
      if (Number.isNaN(ts) || ts > now) continue;
      if (now - ts >= retentionMs) count++;
    }
  }
  if (count === 0) return [];
  return [{
    severity: "info",
    code: "stale_tombstones",
    message: `${count} tombstoned item(s) past retention period (run storybloq gc)`,
    entity: null,
    repair: { command: ["storybloq", "gc"] },
  }];
}

function checkConflictsPresent(state: ProjectState, _ctx: DoctorContext): DoctorFinding[] {
  const items: { type: string; id: string; count: number }[] = [];
  for (const { type, collection } of [
    { type: "ticket", collection: state.tickets },
    { type: "issue", collection: state.issues },
    { type: "note", collection: state.notes },
    { type: "lesson", collection: state.lessons },
  ] as const) {
    for (const item of collection) {
      const conflicts = (item as Record<string, unknown>)._conflicts;
      if (Array.isArray(conflicts) && conflicts.length > 0) {
        items.push({ type, id: item.id, count: conflicts.length });
      }
    }
  }
  if (items.length === 0) return [];
  return [{
    severity: "error",
    code: "conflicts_present",
    message: `${items.length} item(s) have unresolved _conflicts: ${items.map((i) => i.id).join(", ")}. All writes are blocked until resolved.`,
    entity: null,
    repair: { command: ["storybloq", "resolve"] },
  }];
}

async function checkMergeDriverConfig(state: ProjectState, ctx: DoctorContext): Promise<DoctorFinding[]> {
  const rawTeam = (state.config as Record<string, unknown>).team;
  const team = rawTeam && typeof rawTeam === "object" && !Array.isArray(rawTeam) ? rawTeam as Record<string, unknown> : undefined;
  if (!team?.mergeDriverVersion) return [];

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { readFile, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const execFileAsync = promisify(execFile);
  const findings: DoctorFinding[] = [];
  const storyDir = join(ctx.root, ".story");

  try {
    const { stdout } = await execFileAsync("git", ["config", "--local", "--get", "merge.storybloq-json.driver"], { cwd: ctx.root, timeout: 5000 });
    const driver = stdout.trim();
    if (driver !== "storybloq merge-driver %O %A %B %P") {
      findings.push({ severity: "warning", code: "merge_driver_mismatch", message: `Merge driver command mismatch: "${driver}"`, entity: null, repair: { command: ["storybloq", "team", "setup"] } });
    }
  } catch {
    findings.push({ severity: "warning", code: "merge_driver_missing", message: "Git merge driver not configured. Run storybloq team setup.", entity: null, repair: { command: ["storybloq", "team", "setup"] } });
  }

  const attrsPath = join(storyDir, ".gitattributes");
  try {
    await stat(attrsPath);
    const content = await readFile(attrsPath, "utf-8");
    if (!content.includes("# storybloq-merge-begin")) {
      findings.push({ severity: "warning", code: "gitattributes_no_block", message: ".story/.gitattributes missing managed merge block.", entity: null, repair: { command: ["storybloq", "team", "setup"] } });
    }
  } catch {
    findings.push({ severity: "warning", code: "gitattributes_missing", message: ".story/.gitattributes not found. Run storybloq team setup.", entity: null, repair: { command: ["storybloq", "team", "setup"] } });
  }

  return findings;
}

async function checkReservationHealth(state: ProjectState, ctx: DoctorContext): Promise<DoctorFinding[]> {
  const rawTeam = (state.config as Record<string, unknown>).team;
  const team = rawTeam && typeof rawTeam === "object" && !Array.isArray(rawTeam) ? rawTeam as Record<string, unknown> : undefined;
  if (team?.idAllocator !== "git-refs") return [];

  const { fetchLocalReservationTags, classifyReservations } = await import("./reservation-check.js");
  const findings: DoctorFinding[] = [];

  const result = fetchLocalReservationTags(ctx.root);
  if (result.fetchError) {
    findings.push({
      severity: "warning",
      code: "reservation_fetch_failed",
      message: `Failed to fetch reservation refs: ${result.fetchError}`,
      entity: null,
      repair: null,
    });
    return findings;
  }

  const health = classifyReservations(result, state);
  for (const [entityType, orphanIds] of health.orphan) {
    for (const displayId of orphanIds) {
      findings.push({
        severity: "info",
        code: "orphan_reservation",
        message: `Orphan reservation ref for ${entityType} ${displayId}: no item has this displayId`,
        entity: displayId,
        repair: null,
      });
    }
  }
  for (const [entityType, displayIds] of health.mismatched) {
    for (const displayId of displayIds) {
      findings.push({
        severity: "warning",
        code: "mismatched_reservation",
        message: `Mismatched reservation ref for ${entityType} ${displayId}: ownerId does not match the item using this displayId`,
        entity: displayId,
        repair: null,
      });
    }
  }

  return findings;
}

const TEAM_HANDOVER_REGEX = /^\d{4}-\d{2}-\d{2}-\d{6}-[0-9a-f]{8}-/;

function checkHandoverFilenamePolicy(state: ProjectState, _ctx: DoctorContext): DoctorFinding[] {
  const rawTeam = (state.config as Record<string, unknown>).team;
  if (!rawTeam || typeof rawTeam !== "object" || Array.isArray(rawTeam)) return [];

  const findings: DoctorFinding[] = [];
  for (const name of state.handoverFilenames) {
    if (!TEAM_HANDOVER_REGEX.test(name)) {
      findings.push({
        severity: "info",
        code: "legacy_handover_filename",
        message: `Handover "${name}" uses legacy sequential filename format`,
        entity: name,
        repair: null,
      });
    }
  }
  return findings;
}

registerDoctorCheck(checkDuplicateCanonicalIds);
registerDoctorCheck(checkDuplicateDisplayIds);
registerDoctorCheck(checkMissingDisplayId);
registerDoctorCheck(checkUnresolvableRefs);
registerDoctorCheck(checkCliVersion);
registerDoctorCheck(checkLoadWarnings);
registerDoctorCheck(checkStaleClaims);
registerDoctorCheck(checkStaleTombstones);
registerDoctorCheck(checkConflictsPresent);
registerDoctorCheck(checkMergeDriverConfig);
registerDoctorCheck(checkReservationHealth);
registerDoctorCheck(checkHandoverFilenamePolicy);
