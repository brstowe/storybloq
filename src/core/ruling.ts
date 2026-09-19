import type { Ruling, RulingAttribution } from "../models/ruling.js";
import { RULING_CANONICAL_ID_REGEX, type OwnerTaskLike } from "../models/types.js";
import type { RulingScanCompleteness } from "./ruling-loader.js";

/**
 * T-476: owner rulings -- verbatim, attributed decision records with
 * supersedes-links.
 *
 * A ruling is a verbatim quote of something an owner (or, per `attribution`,
 * a manager acting with delegated or owner-veto authority) decided, recorded
 * once and cited by id from wherever that decision matters -- a ticket, an
 * issue, an arrangement's gate text. Citing items never restate a ruling's
 * text; `resolveCitation`/`resolveEntityCitations` resolve it fresh, at read
 * time, off the live `supersedes` chain, which is what makes a restatement
 * going stale (the agentkit-rn T-055/N-012 incident this ticket exists to
 * prevent) structurally impossible for anything built on this module -- see
 * `test/core/ruling-t055-regression.test.ts` for the reproduction and fix.
 *
 * DOCS STATEMENT (this is the one copy; `storybloq ruling create --help`
 * and the rendered caveat's short form both point here): `attribution` is a
 * CLAIM asserted by the person or agent recording the ruling. Storybloq
 * cannot verify who actually said what -- it can only make the claim
 * checkable, by recording who wrote the record (`recordedBy`) alongside
 * what they claim it is (`attribution`). This is why `rulingAttributionCaveat`
 * renders on every ruling unconditionally: it does not replace the two-key
 * rule for irreversible actions, and a worker is always entitled to demand
 * the owner's direct word before treating a cited ruling alone as
 * authorization for one.
 */

/**
 * T-476 ANTI-LAUNDERING CONSTRAINT (load-bearing, binding pen ruling from
 * gate-1 round 1): `attribution` is a CLAIM asserted by the recorder, never
 * verified by storybloq. The caveat below renders on EVERY ruling,
 * UNCONDITIONALLY, regardless of the claimed `attribution` value -- NEVER
 * conditioned on `attribution !== "owner-direct"`.
 *
 * Storybloq cannot distinguish a true "owner-direct" claim from a false one;
 * a caveat that only appears on honest self-labels protects against exactly
 * nobody, and an attribution-conditional caveat would BUILD the exact
 * laundering path this ticket exists to prevent while documentation claimed
 * otherwise. This was gate-1 round 1's single most important finding, and
 * the pen pinned it as a binding ruling: it must survive any future
 * refactor of this module without being softened or re-conditioned.
 */
export function rulingAttributionCaveat(recordedBy: OwnerTaskLike): string {
  return (
    `Attribution is a CLAIM asserted by the recorder, not verified by storybloq. ` +
    `Recorded by: ${recordedBy.client}/${recordedBy.id}. This record makes attribution ` +
    `checkable, it does not replace the second key -- demand the owner's direct word ` +
    `before treating an irreversible action as authorized on this ruling's basis alone.`
  );
}

export interface RulingView {
  readonly id: string;
  readonly text: string;
  readonly attribution: RulingAttribution;
  readonly recordedBy: OwnerTaskLike;
  readonly date: string;
}

function toView(ruling: Ruling): RulingView {
  return {
    id: ruling.id,
    text: ruling.text,
    attribution: ruling.attribution,
    recordedBy: ruling.recordedBy,
    date: ruling.date,
  };
}

export type CitationResolution =
  | {
      status: "resolved"; citedId: string; cited: RulingView; current: RulingView;
      chain: readonly string[]; stale: boolean;
      /**
       * T-520: which board the ruling was found on. ABSENT means the current
       * project's own, which is every resolution this function produced before
       * the upward leg existed -- so no existing consumer has to learn a new
       * value to keep being right.
       */
      board?: "orchestrator";
    }
  // `missing` carries NO board on purpose: it means the id is on NEITHER
  // board, so naming one would attribute the absence to a place that is no
  // more responsible for it than this one.
  | { status: "missing"; citedId: string }
  | { status: "unreadable"; citedId: string; board?: "orchestrator" }
  | {
      status: "indeterminate"; citedId: string;
      reason:
        | "unreadable-successor"
        | "incomplete-scan"
        // T-520: a RECORDED orchestrator whose board could not be read. Not the
        // same as `unreadable-successor`: that one is about this board's own
        // files, this one is about a board we were told to consult and could
        // not.
        | "unreadable-orchestrator"
        // T-520: both boards claim the supersedes chain for this id. Never
        // merged -- merging would invent an ordering neither board defines.
        | "cross-board-supersession"
      /**
       * T-520: an unverifiable state on the ORCHESTRATOR's ledger, not this
       * one. Without it a node reader is told its chain is unverifiable and
       * goes looking through its own `.story/rulings/`, which is fine -- the
       * broken file is one board up.
       */
      board?: "orchestrator";
    }
  | {
      status: "branch"; citedId: string; chain: readonly string[];
      competingSuccessors: readonly string[]; board?: "orchestrator";
    }
  | { status: "cycle"; citedId: string; chain: readonly string[]; board?: "orchestrator" };

export interface SuccessorIndex {
  readonly successorsByTarget: ReadonlyMap<string, readonly string[]>;
  readonly branchedTargets: ReadonlySet<string>;
}

/**
 * `successorsByTarget.get(oldId)` lists every LOADED ruling whose own
 * `supersedes` names `oldId`. More than one entry for a target is a branch
 * (two rulings both claiming to supersede the same predecessor) -- a
 * candidate-graph state `ruling supersede` must never write (section 9), and
 * a state `resolveCitation` must report rather than silently pick one from.
 */
export function buildSuccessorIndex(rulings: readonly Ruling[]): SuccessorIndex {
  const successorsByTarget = new Map<string, string[]>();
  for (const r of rulings) {
    if (!r.supersedes) continue;
    const list = successorsByTarget.get(r.supersedes);
    if (list) list.push(r.id);
    else successorsByTarget.set(r.supersedes, [r.id]);
  }
  const branchedTargets = new Set<string>();
  for (const [target, successors] of successorsByTarget) {
    if (successors.length > 1) branchedTargets.add(target);
  }
  return { successorsByTarget, branchedTargets };
}

export interface CitationResolutionContext {
  readonly rulingsById: ReadonlyMap<string, Ruling>;
  readonly unavailableIds: ReadonlySet<string>;
  readonly scanCompleteness: RulingScanCompleteness;
  readonly index: SuccessorIndex;
  /**
   * Codex round-3 finding: a skipped ruling file whose id could not be
   * recovered from its filename either leaves `unavailableIds` unable to
   * name it, but its unread content could still carry any `supersedes` edge.
   * Defaults to `false` for callers that predate this field (existing
   * 3-arg `buildCitationResolutionContext` call sites keep their prior
   * behavior unchanged).
   */
  readonly hasUnrecoverableEntries: boolean;
  /**
   * T-520: the ORCHESTRATOR's board, for a node that records a pointer to one.
   *
   * DATA, not a callback: `resolveCitation` stays pure and synchronous and
   * does no IO, so every caller that builds a context the old way is
   * unchanged, and the one function that reads the other board
   * (`buildCitationInputs`) is the only place the feature touches a disk.
   *
   * Absent on the orchestrator's own context -- the leg is one hop and never
   * recurses.
   */
  readonly upward?: UpwardBoard;
}

export type UpwardBoard =
  | { readonly kind: "board"; readonly root: string; readonly ctx: CitationResolutionContext }
  | {
      readonly kind: "unreadable";
      /**
       * The path we TRIED, which is the orchestrator's root when we got far
       * enough to resolve one and the recorded string when we did not. Never
       * this project's own root: a message naming that would send a reader to
       * the one directory that is definitely not the problem.
       */
      readonly attemptedPath?: string;
      readonly reason: string;
    };

/** True when any id in `ids` has a successor recorded on `index`. */
function supersededOn(index: SuccessorIndex, ids: readonly string[]): boolean {
  return ids.some((id) => (index.successorsByTarget.get(id)?.length ?? 0) > 0);
}

export function buildCitationResolutionContext(
  rulings: readonly Ruling[],
  unavailableIds: ReadonlySet<string>,
  scanCompleteness: RulingScanCompleteness,
  hasUnrecoverableEntries = false,
): CitationResolutionContext {
  return {
    rulingsById: new Map(rulings.map((r) => [r.id, r])),
    unavailableIds,
    scanCompleteness,
    index: buildSuccessorIndex(rulings),
    hasUnrecoverableEntries,
  };
}

/**
 * Resolves a citation to its CURRENT ruling state, derived at read time,
 * never stored. Read-side posture (rulings #3/#7): an unverifiable chain
 * state renders an explicit warning and NEVER claims `current` -- it never
 * silently omits the citation either. This function itself never throws and
 * never blocks; a caller renders whatever status comes back.
 */
export function resolveCitation(citedId: string, ctx: CitationResolutionContext): CitationResolution {
  // Ruling #4: a failed directory enumeration means the whole id-space is
  // unverifiable -- every citation is indeterminate, never "missing" (which
  // would falsely claim "this id never existed").
  if (ctx.scanCompleteness !== "complete") {
    return { status: "indeterminate", citedId, reason: "incomplete-scan" };
  }
  if (ctx.unavailableIds.has(citedId)) {
    return { status: "unreadable", citedId };
  }
  const citedRuling = ctx.rulingsById.get(citedId);
  if (!citedRuling) {
    // T-520: not here. If this project records an orchestrator, the id may
    // live on that board -- which is the whole feature: a node seat citing a
    // root ruling was getting `missing` and, per ISS-1180, minting a local
    // COPY of the ruling to get past the plan-pin gate.
    if (ctx.upward) return resolveUpward(citedId, ctx, ctx.upward);
    return { status: "missing", citedId };
  }

  const chain: string[] = [citedId];
  const visited = new Set<string>([citedId]);
  let current = citedId;
  for (;;) {
    if (ctx.index.branchedTargets.has(current)) {
      return {
        status: "branch",
        citedId,
        chain,
        competingSuccessors: ctx.index.successorsByTarget.get(current) ?? [],
      };
    }
    const successors = ctx.index.successorsByTarget.get(current);
    const next = successors?.[0];
    if (!next) break;
    if (visited.has(next)) {
      return { status: "cycle", citedId, chain: [...chain, next] };
    }
    visited.add(next);
    chain.push(next);
    current = next;
  }

  // Rulings #3/#7: `successorsByTarget` is built only from LOADED rulings'
  // own `supersedes` fields -- an unreadable ruling's pointer is invisible
  // to it, so it can never be ruled out as a HIDDEN successor of `current`.
  // This cannot be narrowed to specific ids (we cannot read what an
  // unreadable file would have said), so ANY unreadable ruling anywhere
  // taints every "nothing supersedes this" conclusion project-wide -- never
  // silently reported as `current` under that uncertainty. `hasUnrecoverableEntries`
  // covers the same taint for a skipped file whose id could not even be
  // recovered from its filename (codex round-3 finding), so `unavailableIds`
  // alone cannot represent it.
  if (ctx.unavailableIds.size > 0 || ctx.hasUnrecoverableEntries) {
    return { status: "indeterminate", citedId, reason: "unreadable-successor" };
  }

  // T-520, and the SAME rule as the paragraph above applied one board over.
  // An orchestrator ruling whose `supersedes` names a local id is a successor
  // of this chain that is visible ONLY on that board, so a board we were told
  // to consult and could not read leaves "nothing supersedes this" exactly as
  // unverifiable as an unreadable local file does. Pen ruling of 2026-09-18,
  // which overrides the ticket's narrower text. Note the entry condition: a
  // project with no pointer never reaches here, so nothing changes for any
  // project that has not opted in by recording one.
  if (ctx.upward?.kind === "unreadable") {
    return { status: "indeterminate", citedId, reason: "unreadable-orchestrator" };
  }
  if (ctx.upward && supersededOn(ctx.upward.ctx.index, [citedId, ...chain])) {
    return { status: "indeterminate", citedId, reason: "cross-board-supersession" };
  }

  const currentRuling = ctx.rulingsById.get(current)!;
  return {
    status: "resolved",
    citedId,
    cited: toView(citedRuling),
    current: toView(currentRuling),
    chain,
    stale: current !== citedId,
  };
}

/**
 * T-520: one hop up, for an id this board does not have.
 *
 * The orchestrator's chain is walked on the ORCHESTRATOR's own context, so a
 * superseded root ruling comes back `stale` with the successor that board
 * records -- the node does not need its own copy of the chain, which is the
 * copying this feature exists to stop.
 *
 * Anything other than a clean resolution is returned AS IT CAME BACK: a
 * `missing` means the id is on neither board, and the other board's own taints
 * are that board's honest answer and are not re-labelled here.
 */
function resolveUpward(
  citedId: string,
  local: CitationResolutionContext,
  upward: UpwardBoard,
): CitationResolution {
  if (upward.kind === "unreadable") {
    return { status: "indeterminate", citedId, reason: "unreadable-orchestrator" };
  }
  const resolved = resolveCitation(citedId, upward.ctx);
  if (resolved.status === "missing") return resolved;
  if (resolved.status !== "resolved") {
    // Everything else is a statement about the ORCHESTRATOR's ledger -- an
    // unreadable file there, a branched or cyclic chain there -- and is
    // labelled with the board it is about. `missing` above is the exception:
    // it is a statement about both boards at once.
    return { ...resolved, board: "orchestrator" };
  }
  // The mirror of the check on the local-hit path: a LOCAL ruling claiming to
  // supersede something that lives on the root board. Unconstructible through
  // `ruling supersede`, which refuses a target absent from the local ledger,
  // but `.story/` is hand-editable by design.
  if (supersededOn(local.index, [citedId, ...resolved.chain])) {
    return { status: "indeterminate", citedId, reason: "cross-board-supersession" };
  }
  return { ...resolved, board: "orchestrator" };
}


export function resolveCitedRulings(
  citedIds: readonly string[],
  ctx: CitationResolutionContext,
): readonly CitationResolution[] {
  return citedIds.map((id) => resolveCitation(id, ctx));
}

/** Convenience for a single citing entity (ticket/issue/arrangement). */
export function resolveEntityCitations(
  entity: { readonly citesRulings?: readonly string[] },
  ctx: CitationResolutionContext,
): readonly CitationResolution[] {
  return entity.citesRulings && entity.citesRulings.length > 0
    ? resolveCitedRulings(entity.citesRulings, ctx)
    : [];
}

/**
 * Builds the per-entity map every list formatter's JSON branch expects
 * (`citedRulingsByTicketId` etc.), resolving each entity's citations against
 * ONE shared `CitationResolutionContext` -- the caller loads rulings once
 * per command call, not once per list item.
 */
export function citationMapFor(
  entities: readonly { readonly id: string; readonly citesRulings?: readonly string[] }[],
  ctx: CitationResolutionContext,
): ReadonlyMap<string, readonly CitationResolution[]> {
  const map = new Map<string, readonly CitationResolution[]>();
  for (const entity of entities) {
    const resolved = resolveEntityCitations(entity, ctx);
    if (resolved.length > 0) map.set(entity.id, resolved);
  }
  return map;
}

/** Human-readable, read-side "do not trust this" line for a non-resolved citation. */
export function citationWarningText(resolution: CitationResolution): string {
  switch (resolution.status) {
    case "missing":
      return `ruling ${resolution.citedId} not found`;
    case "unreadable":
      return `ruling ${resolution.citedId} is unreadable`;
    case "indeterminate":
      return resolution.reason === "incomplete-scan"
        ? `chain state unverifiable: ruling scan is incomplete -- do not treat any shown ruling as current`
        : `chain state unverifiable: one or more ruling files are unreadable and may hide a successor -- do not treat any shown ruling as current`;
    case "branch":
      return `ruling ${resolution.citedId} has competing successors (${resolution.competingSuccessors.join(", ")}) -- chain is ambiguous`;
    case "cycle":
      return `ruling ${resolution.citedId} is part of a supersedes cycle -- chain is invalid`;
    case "resolved":
      return resolution.stale
        ? `ruling ${resolution.citedId} has been superseded by ${resolution.current.id}`
        : "";
  }
}

/**
 * A citation resolution, flattened into a single JSON-safe object for
 * embedding into a render surface -- the shape every WIRE site in section 12
 * embeds under a `citedRulings` key. `current` (when present) carries the
 * anti-laundering caveat inline, so a render site cannot forget to attach it.
 */
export interface RenderedCitation {
  readonly citedId: string;
  readonly status: CitationResolution["status"];
  readonly current?: RulingView & { readonly caveat: string };
  readonly stale?: boolean;
  readonly warning?: string;
}

export function renderCitation(resolution: CitationResolution): RenderedCitation {
  if (resolution.status === "resolved") {
    const rendered: RenderedCitation = {
      citedId: resolution.citedId,
      status: "resolved",
      current: { ...resolution.current, caveat: rulingAttributionCaveat(resolution.current.recordedBy) },
      stale: resolution.stale,
    };
    return resolution.stale ? { ...rendered, warning: citationWarningText(resolution) } : rendered;
  }
  return { citedId: resolution.citedId, status: resolution.status, warning: citationWarningText(resolution) };
}

// --- Write-path (ruling supersede) candidate-graph validation ---

export type SupersedeRefusalCode = "self_link" | "dangling_target" | "branch" | "cycle" | "unverifiable_graph";

export interface SupersedeRefusal {
  readonly code: SupersedeRefusalCode;
  readonly detail: string;
}

/**
 * Section 9 (rulings #1, #2, #3): validates the PROPOSED `newId.supersedes =
 * oldId` edge's own implications (self-link, dangling target, branch, cycle
 * reachable from the new edge) against the candidate graph (existing rulings
 * + the proposed edge) BEFORE any write -- same one-transaction discipline as
 * the earmark CAS (T-475) and T-474's atomic state writes. Returns a refusal
 * reason or null (the proposed edge is safe to write). Never mutates
 * anything.
 *
 * Scope: this checks only what the new edge would introduce. It does not
 * audit the rest of the graph for pre-existing corruption unrelated to the
 * new edge -- that is `storybloq validate`'s job (`validateRulings` in
 * `src/core/validation.ts`).
 *
 * Fail-closed precondition (ruling #3): the caller must check
 * `unavailableIds`/`scanCompleteness` itself and refuse before ever calling
 * this -- a chain edit against an unverifiable graph must never reach
 * candidate-graph validation at all, since the graph itself cannot be
 * trusted to be complete.
 */
export function validateSupersedeCandidate(
  rulings: readonly Ruling[],
  newId: string,
  oldId: string,
): SupersedeRefusal | null {
  if (newId === oldId) {
    return { code: "self_link", detail: `${newId} cannot supersede itself` };
  }
  const byId = new Map(rulings.map((r) => [r.id, r]));
  if (!byId.has(oldId)) {
    return { code: "dangling_target", detail: `${oldId} does not exist` };
  }

  // Build the candidate graph: every existing supersedes edge, plus the
  // proposed new one (overriding newId's own edge if it already had one --
  // ruling #1's null-case write replaces newId's supersedes wholesale).
  const candidateEdges = new Map<string, string>(); // id -> supersedes
  for (const r of rulings) {
    if (r.supersedes) candidateEdges.set(r.id, r.supersedes);
  }
  candidateEdges.set(newId, oldId);

  // Branch: would oldId end up with more than one successor?
  const successorsOfOld = [...candidateEdges.entries()].filter(([, target]) => target === oldId).map(([id]) => id);
  if (successorsOfOld.length > 1) {
    return {
      code: "branch",
      detail: `${oldId} would have competing successors: ${successorsOfOld.join(", ")}`,
    };
  }

  // Cycle: walk forward from newId's target chain; if we ever return to newId, it's a cycle.
  let current: string | undefined = oldId;
  const seen = new Set<string>([newId]);
  while (current !== undefined) {
    if (seen.has(current)) {
      return { code: "cycle", detail: `supersedes chain from ${newId} cycles back through ${current}` };
    }
    seen.add(current);
    current = candidateEdges.get(current);
  }

  return null;
}

export type CitesRulingsInputResolution =
  | { ok: true; citesRulings: string[] | undefined }
  | { ok: false; message: string };

/**
 * Section 10: the ONE resolution of `--cites-ruling`/`--clear-cites-rulings`
 * (and their MCP equivalents `citesRuling`/`clearCitesRulings`), called by
 * both the ticket and issue create/update handlers so CLI and MCP cannot
 * diverge on this field's semantics.
 *
 * `citesRuling` on update fully REPLACES `citesRulings` (same convention as
 * `blockedBy`/`relatedTickets`), deduplicated preserving first-seen order.
 * Existence of the cited ruling is deliberately NOT checked here: a forward
 * reference to a not-yet-created ruling is a valid transient state, exactly
 * like `resolveCitation`'s "missing" status already handles at read time.
 * Only the id's structural shape is validated.
 *
 * Mutual exclusion is on PRESENCE, not length: `citesRuling` counts as
 * "given" the moment it is not `undefined`, including an explicit `[]` --
 * an MCP caller sending `{ clearCitesRulings: true, citesRuling: [] }` must
 * be refused exactly like `--clear-cites-rulings --cites-ruling ""` would be
 * on the CLI (`requireValue` there already rejects a bare/empty flag before
 * this function is ever reached), and a bare `citesRuling: []` alone is
 * refused too so an MCP caller cannot achieve "clear" through a path the CLI
 * has no equivalent for.
 */
export function resolveCitesRulingsInput(
  citesRuling: readonly string[] | undefined,
  clearCitesRulings: boolean | undefined,
): CitesRulingsInputResolution {
  if (clearCitesRulings && citesRuling !== undefined) {
    return { ok: false, message: "--clear-cites-rulings and --cites-ruling are mutually exclusive" };
  }
  if (clearCitesRulings) {
    return { ok: true, citesRulings: [] };
  }
  if (citesRuling === undefined) {
    return { ok: true, citesRulings: undefined };
  }
  if (citesRuling.length === 0) {
    return { ok: false, message: "citesRuling cannot be empty; use --clear-cites-rulings to clear" };
  }
  const invalid = citesRuling.filter((id) => !RULING_CANONICAL_ID_REGEX.test(id));
  if (invalid.length > 0) {
    return { ok: false, message: `Invalid ruling ID(s): ${invalid.join(", ")} (expected r-[canonical])` };
  }
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const id of citesRuling) {
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }
  return { ok: true, citesRulings: deduped };
}
