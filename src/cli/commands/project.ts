import { join, resolve } from "node:path";
import { readFile, rename } from "node:fs/promises";
import {
  withProjectLock,
  writeRoadmapUnlocked,
  runTransactionUnlocked,
  serializeJSON,
} from "../../core/project-loader.js";
import { TicketSchema } from "../../models/ticket.js";
import { IssueSchema } from "../../models/issue.js";
import { RoadmapSchema } from "../../models/roadmap.js";
import type { Roadmap, Project } from "../../models/roadmap.js";
import {
  formatError,
  successEnvelope,
  escapeMarkdownInline,
  ExitCode,
} from "../../core/output-formatter.js";
import { CliValidationError } from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";

// --- Project ID validation (same shape as phase IDs) ---

const PROJECT_ID_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PROJECT_ID_MAX_LENGTH = 40;

function validateProjectId(id: string): void {
  if (id.length > PROJECT_ID_MAX_LENGTH) {
    throw new CliValidationError("invalid_input", `Project ID "${id}" exceeds ${PROJECT_ID_MAX_LENGTH} characters`);
  }
  if (!PROJECT_ID_REGEX.test(id)) {
    throw new CliValidationError("invalid_input", `Project ID "${id}" must be lowercase alphanumeric with hyphens (e.g. "my-project")`);
  }
}

// --- Read Handlers ---

export function handleProjectList(
  ctx: CommandContext,
  phase?: string,
): CommandResult {
  const projects = (ctx.state.roadmap.projects ?? []).filter(
    (p) => phase === undefined || p.phase === phase,
  );

  const data = projects.map((p) => ({
    ...p,
    ticketCount: ctx.state.activeTickets.filter(
      (t) => t.project === p.id && t.phase === p.phase,
    ).length,
    issueCount: ctx.state.activeIssues.filter(
      (i) => i.project === p.id && i.phase === p.phase,
    ).length,
  }));

  if (ctx.format === "json") {
    return { output: JSON.stringify(successEnvelope(data), null, 2) };
  }
  if (data.length === 0) {
    return { output: phase ? `No projects in phase "${phase}".` : "No projects defined." };
  }
  return {
    output: data
      .map((p) =>
        `**${escapeMarkdownInline(p.name)}** (${p.id}) — phase: ${p.phase} — ${p.ticketCount} tickets, ${p.issueCount} issues${p.color ? ` — ${p.color}` : ""}`,
      )
      .join("\n"),
  };
}

// --- Write Handlers ---

export async function handleProjectCreate(
  args: { id: string; name: string; phase: string; color?: string },
  format: string,
  root: string,
): Promise<CommandResult> {
  validateProjectId(args.id);

  let created: Project | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    if (!state.roadmap.phases.some((p) => p.id === args.phase)) {
      throw new CliValidationError("not_found", `Phase "${args.phase}" not found`);
    }
    const projects = state.roadmap.projects ?? [];
    if (projects.some((p) => p.id === args.id)) {
      throw new CliValidationError("conflict", `Project "${args.id}" already exists`);
    }

    const project: Project = {
      id: args.id,
      name: args.name,
      phase: args.phase,
      ...(args.color !== undefined && { color: args.color }),
    };

    const newRoadmap: Roadmap = { ...state.roadmap, projects: [...projects, project] };
    await writeRoadmapUnlocked(newRoadmap, root);
    created = project;
  });

  if (!created) throw new Error("Project not created");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(created), null, 2) };
  }
  return { output: `Created project ${created.id}: ${created.name} (phase: ${created.phase})` };
}

export async function handleProjectUpdate(
  id: string,
  updates: { name?: string; phase?: string; color?: string },
  format: string,
  root: string,
): Promise<CommandResult> {
  let updated: Project | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const projects = state.roadmap.projects ?? [];
    const idx = projects.findIndex((p) => p.id === id);
    if (idx < 0) {
      throw new CliValidationError("not_found", `Project "${id}" not found`);
    }
    if (updates.phase !== undefined && !state.roadmap.phases.some((p) => p.id === updates.phase)) {
      throw new CliValidationError("not_found", `Phase "${updates.phase}" not found`);
    }

    const existing = projects[idx]!;
    const project: Project = {
      ...existing,
      ...(updates.name !== undefined && { name: updates.name }),
      ...(updates.phase !== undefined && { phase: updates.phase }),
      ...(updates.color !== undefined && { color: updates.color }),
    };

    const newProjects = [...projects];
    newProjects[idx] = project;
    const newRoadmap: Roadmap = { ...state.roadmap, projects: newProjects };
    await writeRoadmapUnlocked(newRoadmap, root);
    updated = project;
  });

  if (!updated) throw new Error("Project not updated");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(updated), null, 2) };
  }
  return { output: `Updated project ${updated.id}: ${updated.name} (phase: ${updated.phase})` };
}

export async function handleProjectDelete(
  id: string,
  clearAssignments: boolean,
  format: string,
  root: string,
): Promise<CommandResult> {
  let clearedCount = 0;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const projects = state.roadmap.projects ?? [];
    if (!projects.some((p) => p.id === id)) {
      throw new CliValidationError("not_found", `Project "${id}" not found`);
    }

    const assignedTickets = state.activeTickets.filter((t) => t.project === id);
    const assignedIssues = state.activeIssues.filter((i) => i.project === id);
    const assignedCount = assignedTickets.length + assignedIssues.length;

    if (assignedCount > 0 && !clearAssignments) {
      throw new CliValidationError(
        "conflict",
        `Cannot delete project "${id}": ${assignedCount} item(s) are assigned to it. Use --clear-assignments to unassign them.`,
      );
    }

    const newProjects = projects.filter((p) => p.id !== id);
    const newRoadmap: Roadmap = { ...state.roadmap, projects: newProjects };

    if (assignedCount === 0) {
      await writeRoadmapUnlocked(newRoadmap, root);
      return;
    }

    // Unassign items + drop the project definition in one transaction
    const wrapDir = resolve(root, ".story");
    const operations: Array<{ op: "write"; target: string; content: string }> = [];

    for (const ticket of assignedTickets) {
      const parsed = TicketSchema.parse({ ...ticket, project: null });
      operations.push({
        op: "write",
        target: join(wrapDir, "tickets", `${parsed.id}.json`),
        content: serializeJSON(parsed),
      });
    }
    for (const issue of assignedIssues) {
      const parsed = IssueSchema.parse({ ...issue, project: null });
      operations.push({
        op: "write",
        target: join(wrapDir, "issues", `${parsed.id}.json`),
        content: serializeJSON(parsed),
      });
    }
    operations.push({
      op: "write",
      target: join(wrapDir, "roadmap.json"),
      content: serializeJSON(RoadmapSchema.parse(newRoadmap)),
    });

    await runTransactionUnlocked(root, operations);
    clearedCount = assignedCount;
  });

  if (format === "json") {
    return { output: JSON.stringify(successEnvelope({ id, deleted: true, clearedAssignments: clearedCount }), null, 2) };
  }
  const suffix = clearedCount > 0 ? ` (${clearedCount} assignment(s) cleared)` : "";
  return { output: `Deleted project ${id}.${suffix}` };
}

// --- Sidecar migration ---

/**
 * Imports a legacy dashboard sidecar (.story/projects.json: {projects[],
 * assignments{}}) into native storage: definitions into roadmap.projects,
 * assignments onto each item's `project` field (only where the item's phase
 * matches the project's phase — stale assignments are skipped and reported).
 * The sidecar is renamed to projects.json.migrated.bak afterwards.
 */
export async function handleProjectMigrateSidecar(
  format: string,
  root: string,
): Promise<CommandResult> {
  const sidecarPath = join(resolve(root, ".story"), "projects.json");

  let raw: string;
  try {
    raw = await readFile(sidecarPath, "utf-8");
  } catch {
    return {
      output: formatError("not_found", `No legacy sidecar found at ${sidecarPath}`, format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }

  let sidecar: { projects?: unknown; assignments?: unknown };
  try {
    sidecar = JSON.parse(raw) as { projects?: unknown; assignments?: unknown };
  } catch {
    throw new CliValidationError("invalid_input", `Sidecar ${sidecarPath} is not valid JSON`);
  }

  const summary = {
    projectsImported: 0,
    assignmentsApplied: 0,
    assignmentsSkipped: [] as string[],
  };

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const existing = state.roadmap.projects ?? [];
    const existingIds = new Set(existing.map((p) => p.id));
    const phaseIds = new Set(state.roadmap.phases.map((p) => p.id));

    const imported: Project[] = [];
    const rawProjects = Array.isArray(sidecar.projects) ? sidecar.projects : [];
    for (const p of rawProjects) {
      if (!p || typeof p !== "object") continue;
      const rec = p as Record<string, unknown>;
      if (typeof rec.id !== "string" || typeof rec.name !== "string" || typeof rec.phase !== "string") continue;
      if (existingIds.has(rec.id)) continue; // already migrated
      if (!phaseIds.has(rec.phase)) {
        summary.assignmentsSkipped.push(`project ${rec.id}: unknown phase "${rec.phase}"`);
        continue;
      }
      imported.push({
        id: rec.id,
        name: rec.name,
        phase: rec.phase,
        ...(typeof rec.color === "string" && { color: rec.color }),
      });
    }

    const allProjects = [...existing, ...imported];
    const projectById = new Map(allProjects.map((p) => [p.id, p]));

    const wrapDir = resolve(root, ".story");
    const operations: Array<{ op: "write"; target: string; content: string }> = [];

    const rawAssignments =
      sidecar.assignments && typeof sidecar.assignments === "object"
        ? (sidecar.assignments as Record<string, unknown>)
        : {};
    for (const [ref, projectId] of Object.entries(rawAssignments)) {
      if (typeof projectId !== "string") continue;
      const project = projectById.get(projectId);
      if (!project) {
        summary.assignmentsSkipped.push(`${ref}: unknown project "${projectId}"`);
        continue;
      }

      const ticketResolved = state.resolveTicketRef(ref);
      const issueResolved = ticketResolved.kind === "found" ? null : state.resolveIssueRef(ref);

      if (ticketResolved.kind === "found") {
        const t = ticketResolved.item;
        if (t.phase !== project.phase) {
          summary.assignmentsSkipped.push(`${ref}: phase "${t.phase ?? "none"}" != project phase "${project.phase}"`);
          continue;
        }
        if (t.project === projectId) continue; // already applied
        const parsed = TicketSchema.parse({ ...t, project: projectId });
        operations.push({
          op: "write",
          target: join(wrapDir, "tickets", `${parsed.id}.json`),
          content: serializeJSON(parsed),
        });
        summary.assignmentsApplied++;
      } else if (issueResolved && issueResolved.kind === "found") {
        const i = issueResolved.item;
        if (i.phase !== project.phase) {
          summary.assignmentsSkipped.push(`${ref}: phase "${i.phase ?? "none"}" != project phase "${project.phase}"`);
          continue;
        }
        if (i.project === projectId) continue;
        const parsed = IssueSchema.parse({ ...i, project: projectId });
        operations.push({
          op: "write",
          target: join(wrapDir, "issues", `${parsed.id}.json`),
          content: serializeJSON(parsed),
        });
        summary.assignmentsApplied++;
      } else {
        summary.assignmentsSkipped.push(`${ref}: no matching ticket or issue`);
      }
    }

    if (imported.length > 0) {
      const newRoadmap: Roadmap = { ...state.roadmap, projects: allProjects };
      operations.push({
        op: "write",
        target: join(wrapDir, "roadmap.json"),
        content: serializeJSON(RoadmapSchema.parse(newRoadmap)),
      });
    }

    if (operations.length > 0) {
      await runTransactionUnlocked(root, operations);
    }
    summary.projectsImported = imported.length;

    // Park the sidecar so the migration never re-runs against stale data
    await rename(sidecarPath, `${sidecarPath}.migrated.bak`);
  });

  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(summary), null, 2) };
  }
  const lines = [
    `Imported ${summary.projectsImported} project(s), applied ${summary.assignmentsApplied} assignment(s).`,
    `Sidecar renamed to projects.json.migrated.bak.`,
  ];
  if (summary.assignmentsSkipped.length > 0) {
    lines.push("", "Skipped:");
    for (const s of summary.assignmentsSkipped) lines.push(`- ${s}`);
  }
  return { output: lines.join("\n") };
}
