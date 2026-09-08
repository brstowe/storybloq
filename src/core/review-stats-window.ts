/**
 * T-495: the contract measurement window.
 *
 * WHY A WINDOW EXISTS AT ALL. Without one, every review verdict artifact this
 * repository already holds precedes the feature and becomes an exclusion, so
 * the first live run reports an exclusion rate above ninety percent and is
 * INVALID before it starts. The window says which rounds the week is about.
 *
 * It is IMMUTABLE by construction. `--open-window` refuses to run twice and
 * `--close-window` refuses to re-open, because a population that can be
 * re-based after the fact cannot support a threshold verdict about itself: the
 * verdict would describe whichever start time produced the nicer number.
 *
 * The window lives at the TOP LEVEL of `.story/config.json`, not under
 * `recipeOverrides`. That object is a plain `z.object` and strips undeclared
 * keys on parse, which is the seam `readBlockingPolicy` documents; the top
 * level is `.passthrough()`, and the key is declared besides, so it survives a
 * round trip either way.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite, withProjectLock } from "./project-loader.js";

/**
 * What the three divergence checks saw AT CLOSE.
 *
 * Recorded rather than recomputed, because two of the three are not
 * recoverable afterwards: whether the working tree was dirty at the moment of
 * closing is a fact about that moment, and a re-read after the fact describes
 * a different file. The reader prints these; it does not re-derive them.
 *
 * EVERY FIELD IS NULLABLE AND A NULL IS NOT A CLEAN RESULT. An observation that
 * could not be made is the failure class this whole item exists to refuse: a
 * check that did not run and a check that found nothing produce the same
 * printed line unless the difference is carried in the data.
 */
export interface CloseObservations {
  /** sha256 of REVIEW.md re-read at close. Null when the read failed. */
  readonly reReadHash: string | null;
  /** Commits touching REVIEW.md inside the window. Null when not observed. */
  readonly commitsTouchingReview: number | null;
  /** REVIEW.md dirty in the working tree at close. Null when not observed. */
  readonly reviewDirty: boolean | null;
  /** One entry per check that could not be made, saying which and why. */
  readonly notes: readonly string[];
}

export interface ContractWindow {
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly baselineHash: string;
  readonly roots: readonly string[];
  /**
   * Present exactly when the window is closed. A closed window WITHOUT them
   * does not parse as a window at all (see `readContractWindow`).
   */
  readonly closeObservations: CloseObservations | null;
}

/** Seven calendar days, the ruled minimum a window may run for. */
export const MIN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * The ruled population floor.
 *
 * ONE constant, read by both `--close-window` (which refuses below it) and the
 * reader's POPULATION line. Two copies of the same number drift, and the two
 * consumers would then disagree about the same threshold while each printed a
 * confident answer.
 */
export const MIN_POPULATION = 20;

/**
 * Clock-skew tolerance, shared by every check that compares a recorded instant
 * against a reader's clock.
 *
 * ONE constant for the same physical allowance. The reader uses it to refuse an
 * artifact timestamped ahead of the scan; this module uses it to refuse a
 * `closedAt` in the future. Two copies would drift and the two refusals would
 * then disagree about the same tolerance.
 */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

function configPath(projectRoot: string): string {
  return join(projectRoot, ".story", "config.json");
}

/**
 * Read the window, or null.
 *
 * A MALFORMED window reads as ABSENT, never as a partially usable one. Half a
 * window would let the reader select a population against a start time it
 * invented, and a verdict over an invented population is worse than no verdict:
 * the second says it does not know, the first does not.
 */
export function readContractWindow(
  projectRoot: string,
  /**
   * The reader's clock. Injectable so the future-close refusal below is
   * testable without moving the system clock.
   */
  nowMs: number = Date.now(),
): ContractWindow | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath(projectRoot), "utf-8"));
  } catch {
    return null;
  }
  const cm = (raw as { contractMeasurement?: unknown } | null)?.contractMeasurement;
  if (cm === null || typeof cm !== "object") return null;
  const w = cm as Record<string, unknown>;
  if (typeof w.openedAt !== "string" || w.openedAt === "") return null;
  if (typeof w.baselineHash !== "string" || w.baselineHash === "") return null;
  if (!(w.closedAt === null || typeof w.closedAt === "string")) return null;
  if (!Array.isArray(w.roots) || !w.roots.every((r) => typeof r === "string")) return null;
  const closedAt = w.closedAt === undefined ? null : (w.closedAt as string | null);
  // BOTH TIMESTAMPS MUST BE READABLE INSTANTS, and a closed window must have
  // run its full term. A `closedAt` of "not-a-date" passed the shape check
  // before, and the reader then treated the window as closed while SKIPPING
  // its upper-bound filter, because `Date.parse` returned NaN: rounds after the
  // close entered the population and the week still reported no blocking
  // condition. The same hole let a hand-edited early close, or one dated before
  // its own opening, parse as a usable window and bypass the seven-day minimum
  // that `closeContractWindow` refuses at. Validated HERE so there is one
  // boundary rather than a check in every consumer. Codex found it.
  const openedMs = Date.parse(w.openedAt);
  if (Number.isNaN(openedMs)) return null;
  if (closedAt !== null) {
    const closedMs = Date.parse(closedAt);
    if (Number.isNaN(closedMs)) return null;
    if (closedMs - openedMs < MIN_WINDOW_MS) return null;
    // A CLOSE CANNOT BE IN THE FUTURE. A hand-edited window opened eight days
    // ago and closed TOMORROW satisfies every check above, and the reader then
    // treats it as closed while its population keeps growing as the clock
    // advances toward that timestamp: a supposedly fixed week that is still
    // taking new members, reporting no blocking condition the whole time. The
    // same skew allowance the reader gives an artifact is given here, and no
    // more. Codex found it in round 2.
    if (closedMs > nowMs + CLOCK_SKEW_MS) return null;
  }
  // A CLOSED WINDOW WITHOUT ITS OBSERVATIONS IS NOT A CLOSED WINDOW.
  //
  // The three divergence checks are what a VOID verdict is decided on, and two
  // of them cannot be reconstructed later. Accepting a closed window that
  // carries none of them would let the reader print "matches baseline" and
  // "working tree clean" for checks that never ran, which is the exact shape
  // of false evidence this item exists to remove. It reads as an unreadable
  // window instead, and the reader's `no-window` rung names this cause.
  const observations = closedAt === null ? null : parseCloseObservations(w.closeObservations);
  if (closedAt !== null && observations === null) return null;
  return {
    openedAt: w.openedAt,
    closedAt,
    baselineHash: w.baselineHash,
    roots: w.roots as readonly string[],
    closeObservations: observations,
  };
}

function parseCloseObservations(v: unknown): CloseObservations | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const nStr = (x: unknown): boolean => x === null || typeof x === "string";
  const nBool = (x: unknown): boolean => x === null || typeof x === "boolean";
  // A COUNT IS A NONNEGATIVE INTEGER. `-1` passed the finite-number check and
  // the verdict only asks whether the count is ABOVE zero, so an impossible
  // observation read as positive evidence that no commit touched the contract.
  // An unreadable observation must be null, which the verdict treats as
  // unobserved; it must never be a number that answers the question wrongly.
  if (!nStr(o.reReadHash) || !nBool(o.reviewDirty)) return null;
  if (!(o.commitsTouchingReview === null
    || (typeof o.commitsTouchingReview === "number"
      && Number.isSafeInteger(o.commitsTouchingReview)
      && o.commitsTouchingReview >= 0))) {
    return null;
  }
  if (!Array.isArray(o.notes) || !o.notes.every((n) => typeof n === "string")) return null;
  return {
    reReadHash: (o.reReadHash ?? null) as string | null,
    commitsTouchingReview: (o.commitsTouchingReview ?? null) as number | null,
    reviewDirty: (o.reviewDirty ?? null) as boolean | null,
    notes: o.notes as readonly string[],
  };
}

export type OpenWindowResult =
  | { readonly ok: true; readonly window: ContractWindow }
  | { readonly ok: false; readonly reason: string };

/**
 * Open the window. Refuses when one is already recorded.
 *
 * The refusal is total: nothing is rewritten, not even `openedAt`. A refusal
 * that still moved the start time would re-base the population it was refusing
 * to re-base.
 *
 * UNDER THE PROJECT LOCK, and the whole read-modify-write is inside it. An
 * earlier draft did the check and the write unlocked and merely DISCLOSED the
 * race; Codex was right that a disclosure preserves neither the window's
 * immutability nor the rest of the file. Two openers could both see no window
 * and the second win, and worse, a concurrent config write by anything else
 * would be silently discarded by this one's read-modify-write.
 *
 * The write is ATOMIC (temp file, then rename) for the same reason: a direct
 * `writeFileSync` truncates config.json first, so a crash or a full disk
 * between truncate and write destroys the project's configuration while this
 * function reports only that opening failed.
 */
export type BaselineResult =
  | { readonly ok: true; readonly hash: string }
  | { readonly ok: false; readonly reason: string };

export async function openContractWindow(
  projectRoot: string,
  opts: {
    readonly roots: readonly string[];
    /**
     * Reads and validates the contract. EVALUATED INSIDE THE LOCK, and that is
     * the whole reason it is a callback rather than a value.
     *
     * A hash captured before the lock is acquired describes REVIEW.md as it was
     * BEFORE the wait. If the file changes while this command queues, the
     * window opens immutably against the old bytes with a later `openedAt`, and
     * every delivery of the contract that is actually in force then fails
     * baseline verification for the entire week. Codex found it in round 2,
     * after the lock itself had been added in response to round 1: taking a
     * lock does not help if the value it protects was read outside it.
     */
    readonly baseline: () => BaselineResult;
  },
): Promise<OpenWindowResult> {
  let outcome: OpenWindowResult = {
    ok: false,
    reason: "The project lock could not be taken, so no window was opened.",
  };
  try {
    await withProjectLock(projectRoot, { strict: false }, async () => {
      // READ INSIDE THE LOCK. Reading before taking it would reintroduce the
      // race the lock exists to close.
      const existing = readContractWindow(projectRoot);
      if (existing !== null) {
        outcome = {
          ok: false,
          reason:
            `A measurement window is already open (opened ${existing.openedAt}). Re-opening would `
            + "re-base the population after the fact, which is what makes a threshold verdict "
            + "about it meaningless.",
        };
        return;
      }

      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(
          readFileSync(configPath(projectRoot), "utf-8"),
        ) as Record<string, unknown>;
      } catch (err) {
        outcome = { ok: false, reason: `Could not read .story/config.json: ${String(err)}` };
        return;
      }
      // A `contractMeasurement` key that is present but unreadable is NOT an
      // absent window: overwriting it would discard a window whose shape this
      // build does not understand, which is the one destructive thing this
      // command can do.
      if (raw.contractMeasurement !== undefined) {
        outcome = {
          ok: false,
          reason:
            "`contractMeasurement` is already present in .story/config.json but could not be read "
            + "as a window. It is left untouched: overwriting it would discard a record this "
            + "build does not understand.",
        };
        return;
      }

      // Read and validated HERE, under the lock, so the recorded baseline is
      // the contract in force at the moment the window is created.
      const baseline = opts.baseline();
      if (!baseline.ok) {
        outcome = { ok: false, reason: baseline.reason };
        return;
      }

      const window: ContractWindow = {
        openedAt: new Date().toISOString(),
        closedAt: null,
        baselineHash: baseline.hash,
        roots: opts.roots,
        closeObservations: null,
      };
      try {
        await atomicWrite(
          configPath(projectRoot),
          `${JSON.stringify({ ...raw, contractMeasurement: window }, null, 2)}\n`,
        );
      } catch (err) {
        outcome = { ok: false, reason: `Could not write .story/config.json: ${String(err)}` };
        return;
      }
      outcome = { ok: true, window };
    });
  } catch (err) {
    return { ok: false, reason: `Could not take the project lock: ${String(err)}` };
  }
  return outcome;
}

export type CloseWindowResult =
  | { readonly ok: true; readonly window: ContractWindow }
  | { readonly ok: false; readonly reason: string };

/**
 * Close the window, recording the three divergence observations.
 *
 * Refuses on three grounds, each of which would let the week describe a
 * population chosen after the fact:
 *
 *  - Before `openedAt` plus seven days. A week is seven days; closing on day
 *    three and reading the rate is choosing the stopping point by the number.
 *  - A window already closed. Re-closing re-stamps `closedAt` and moves the
 *    upper bound of the population.
 *  - Fewer than the ruled floor of in-window accepted rounds. D0 puts it
 *    exactly this way: the window STAYS OPEN until twenty exist, so closing
 *    below the floor is refused here rather than merely reported by the reader.
 *
 * The observations and `closedAt` are written in ONE atomic replace under the
 * project lock, so a closed window always carries the evidence its verdict is
 * decided on. `readContractWindow` refuses the other combination.
 */
export async function closeContractWindow(
  projectRoot: string,
  opts: {
    /** Observes the three divergence checks. EVALUATED INSIDE THE LOCK. */
    readonly observe: (window: ContractWindow) => Promise<CloseObservations>;
    /** In-window accepted rounds, counted INSIDE the lock against this window. */
    readonly population: (window: ContractWindow) => Promise<number>;
    readonly nowMs: number;
  },
): Promise<CloseWindowResult> {
  let outcome: CloseWindowResult = {
    ok: false,
    reason: "The project lock could not be taken, so the window was not closed.",
  };
  try {
    await withProjectLock(projectRoot, { strict: false }, async () => {
      const existing = readContractWindow(projectRoot);
      if (existing === null) {
        outcome = {
          ok: false,
          reason:
            "No readable measurement window in .story/config.json. Open one with "
            + "`storybloq review-stats --open-window`. A `contractMeasurement` that IS present "
            + "reads as absent here when it cannot be parsed, which includes a closed window "
            + "carrying no close-time divergence observations.",
        };
        return;
      }
      if (existing.closedAt !== null) {
        outcome = {
          ok: false,
          reason:
            `The window is already closed (closed ${existing.closedAt}). Re-closing would move `
            + "the upper bound of the population after the fact.",
        };
        return;
      }
      const openedMs = Date.parse(existing.openedAt);
      if (Number.isNaN(openedMs)) {
        outcome = {
          ok: false,
          reason: `The recorded openedAt (${existing.openedAt}) is not a readable instant, so the `
            + "seven-day minimum cannot be checked.",
        };
        return;
      }
      const elapsed = opts.nowMs - openedMs;
      if (elapsed < MIN_WINDOW_MS) {
        const remaining = MIN_WINDOW_MS - elapsed;
        outcome = {
          ok: false,
          reason:
            `The window opened ${existing.openedAt} and seven days have not elapsed `
            + `(${Math.ceil(remaining / (60 * 60 * 1000))} hours remain). Closing early chooses `
            + "the stopping point by the number it produces.",
        };
        return;
      }

      const population = await opts.population(existing);
      if (population < MIN_POPULATION) {
        outcome = {
          ok: false,
          reason:
            `Only ${population} in-window accepted round(s); the floor is ${MIN_POPULATION}. `
            + "The window stays open until the floor is met. Closing below it fixes a population "
            + "too small to support any threshold verdict about itself.",
        };
        return;
      }

      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(readFileSync(configPath(projectRoot), "utf-8")) as Record<string, unknown>;
      } catch (err) {
        outcome = { ok: false, reason: `Could not read .story/config.json: ${String(err)}` };
        return;
      }

      // OBSERVED INSIDE THE LOCK, for the same reason the baseline is read
      // inside it at open: a dirty-tree check made before the wait describes
      // the tree as it was before the wait, and the record would then carry an
      // observation of a different moment than the one it stamps.
      const observations = await opts.observe(existing);
      const closed: ContractWindow = {
        ...existing,
        closedAt: new Date(opts.nowMs).toISOString(),
        closeObservations: observations,
      };
      try {
        await atomicWrite(
          configPath(projectRoot),
          `${JSON.stringify({ ...raw, contractMeasurement: closed }, null, 2)}\n`,
        );
      } catch (err) {
        outcome = { ok: false, reason: `Could not write .story/config.json: ${String(err)}` };
        return;
      }
      outcome = { ok: true, window: closed };
    });
  } catch (err) {
    return { ok: false, reason: `Could not take the project lock: ${String(err)}` };
  }
  return outcome;
}
