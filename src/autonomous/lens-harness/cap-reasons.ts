/**
 * ISS-950: reading `ReviewVerdict.capReasons`.
 *
 * The 0.6.0 merger names every cap that fired, one string per cap. Two shapes
 * come from lens coverage and are answered by running a lens again:
 *
 *   core lens 'concurrency' uncovered (skipped, self-reported)
 *   core lens 'concurrency' relabeled
 *
 * The others (`retry pending`, `review incomplete`) are not, and the
 * difference decides where a capped round goes. A cap that would route a
 * coverage gap to IMPLEMENT is the ISS-950 defect in a new costume: the
 * implementer is handed a round with nothing to implement, and the cheapest
 * way out of it is for the lens to relabel its skip.
 *
 * ONE parser, shared by the judge (which classifies the verdict) and the
 * CODE_REVIEW stage (which routes it), because two readings of the same
 * strings would eventually disagree about which lenses to re-run.
 */

/** `core lens '<id>' uncovered (<detail>)` or `core lens '<id>' relabeled`. */
const CORE_LENS_CAP = /^core lens '([^']+)' (?:uncovered \((.+)\)|(relabeled))$/;

/**
 * The detail a self-reported skip carries. This is the shape the coverage cap
 * exists to stop rewarding: the lens ran, declared nothing in its domain, and
 * the server judged the change applicable.
 */
const SELF_REPORTED_SKIP = "skipped, self-reported";

export interface CapReasonAnalysis {
  /**
   * Every cap that fired names a core lens's coverage. A caller that also
   * knows the round carried no findings can route it to a lens re-run.
   *
   * False for an empty list: no cap fired, so there is nothing to route.
   */
  readonly allCoverage: boolean;
  /** Core lenses named by a coverage cap, deduped, in the order they appear. */
  readonly uncoveredCoreLenses: readonly string[];
  /**
   * The subset whose cap reads `skipped, self-reported`: a lens that ran and
   * declared nothing on a change the server judged applicable. These are the
   * re-run candidates the server itself would re-dispatch within one session.
   */
  readonly selfReportedSkips: readonly string[];
}

export function analyzeCapReasons(
  capReasons: readonly string[],
): CapReasonAnalysis {
  const uncovered: string[] = [];
  const selfReported: string[] = [];
  let allCoverage = capReasons.length > 0;
  for (const reason of capReasons) {
    const match = CORE_LENS_CAP.exec(reason);
    if (!match) {
      allCoverage = false;
      continue;
    }
    const lensId = match[1] as string;
    if (!uncovered.includes(lensId)) uncovered.push(lensId);
    if (match[2] === SELF_REPORTED_SKIP && !selfReported.includes(lensId)) {
      selfReported.push(lensId);
    }
  }
  return { allCoverage, uncoveredCoreLenses: uncovered, selfReportedSkips: selfReported };
}
