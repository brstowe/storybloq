/**
 * T-487 step 2, workstreams B and C: the review contract's parser, its
 * projection, and the validate surface. Report-only: nothing here changes a
 * severity, a verdict or a stage transition.
 *
 * EVERY FIXTURE STATES ITS SEVERITY. Clause 18 of `r-gma645xs5ktcxb4v` puts a
 * floor under promotion, so severity is load-bearing for `policyBlock`, and an
 * unstated severity lets a branch return `"baseline"` for a reason the test did
 * not intend. Codex found exactly that in R5 (T17), and it is the same defect
 * this ticket exists to fix: an assertion that passes while establishing
 * nothing.
 *
 * The per-test argument recorded in the plan is "why a WRONG implementation
 * cannot pass this fixture", not "which mutant it kills". The standing count on
 * this item is fourteen tests of mine that passed while the property they named
 * was false, and four of those had a mutant named in their comment: reasoning
 * about the mutant I had in mind is what let them through.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  BLOCKING_CLASSES,
  evaluatePrinciplePolicy,
  loadReviewContract,
  projectDecision,
  projectRoundGate,
  readBlockingPolicy,
  reviewContractWarnings,
  type BaselineDecision,
  type ReviewContract,
} from "../../src/autonomous/review-contract.js";
import { roundBlockerPredicate } from "../../src/autonomous/review-identity.js";
import { decideCeiling, codeReviewHardCeiling } from "../../src/autonomous/stages/code-review-ceiling.js";

const isRoundBlocker = roundBlockerPredicate({ kind: "ok" });

function contractFrom(body: string): ReviewContract {
  const root = mkdtempSync(join(tmpdir(), "t487-contract-"));
  writeFileSync(join(root, "REVIEW.md"), body, "utf-8");
  return loadReviewContract(root);
}

/**
 * Six principles and an Outside line. `security` and `robustness` are the two
 * blocking classes, exactly as the owner's template declares them.
 */
const SIX = `# Review Contract

## Coherence
Says one thing in one place.
Blocking: major

## Uniformity
Equivalent things expressed the same way.
**Blocking:** major

## Maintainability
A later reader can change this safely.
Blocking class: major

## Robustness
Behaves correctly when inputs, dependencies or timing misbehave.
Blocking: blocking

## Security
Untrusted input cannot reach a privileged operation.
Blocking: blocking

## Quality
Carries the tests and the evidence its risk warrants.
Blocking: major

## Outside this contract
performance, accessibility, data-safety
`;

/**
 * The same six with `Robustness` declared MAJOR instead of blocking, and
 * nothing else changed. Two contracts differing in exactly one class word are
 * what make "the class is the only variable" true of the FIXTURE rather than
 * only of its name: varying the finding's principle instead also varies its
 * category and its name, and an implementation that hardcodes "robustness
 * blocks" passes that. Codex found it.
 */
const SIX_ROBUSTNESS_MAJOR = SIX.replace(
  "Behaves correctly when inputs, dependencies or timing misbehave.\nBlocking: blocking",
  "Behaves correctly when inputs, dependencies or timing misbehave.\nBlocking: major",
);

/** The same six, with nothing declared outside. */
const SIX_NO_OUTSIDE = SIX.slice(0, SIX.indexOf("## Outside this contract"));

const baseline = (severity: string, blocking: boolean): BaselineDecision => ({ severity, blocking });

/** A finding with every field the projection reads stated explicitly. */
function finding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "f1",
    severity: "major",
    category: "robustness",
    description: "d",
    principle: "robustness",
    disposition: "open",
    originClass: "new",
    ...over,
  };
}

function project(
  f: unknown,
  contract: ReviewContract,
  b: BaselineDecision,
  cfg: { alwaysBlock?: readonly string[]; neverBlock?: readonly string[] } = {},
) {
  return projectDecision({
    finding: f,
    index: 0,
    baseline: b,
    contract,
    isRoundBlocker,
    ...cfg,
  });
}

// ---------------------------------------------------------------------------
// B1: activation is a PARSE, and a bad declaration invalidates the contract
// ---------------------------------------------------------------------------

describe("T-487 B1: declaration detection separated from value validation", () => {
  it("T2: an unrecognised class word invalidates the WHOLE contract, not just its section", () => {
    const c = contractFrom(`# R

## Coherence
Says one thing in one place.
Blocking: nit

## Uniformity
One convention.
Blocking: nitpick

## Maintainability
Later readers.
Blocking: minor

## Robustness
Under load.
Blocking: warn

## Quality
Tested.
Blocking: info

## Security
No leaks.
Blocking: blocking
`);
    expect(c.status).toBe("unparseable");
    expect(c.invalid.map((i) => i.word)).toEqual(["nit", "nitpick", "minor", "warn", "info"]);
    // ... and because it is unparseable, it caps nothing. A finding naming no
    // principle at all keeps its severity.
    const p = project(finding({ principle: undefined, severity: "critical" }), c, baseline("critical", true));
    expect(p.projectedSeverity).toBe("critical");
    expect(p.policyBlock).toBe("baseline");
  });

  it("T3: a valueless declaration invalidates; a section with no blocking line stays prose", () => {
    // BOTH arms carry the same separately valid principle, so the prose arm's
    // contract is `active` rather than principle-less. Without that, both arms
    // are unparseable for want of any principle and a parser that cannot tell a
    // valueless declaration from prose passes for the wrong reason.
    const valueless = contractFrom(`# R

## Security
No leaks.
Blocking: blocking

## Coherence
One place.
Blocking:
`);
    const prose = contractFrom(`# R

## Security
No leaks.
Blocking: blocking

## Coherence
One place. This section declares nothing and is ordinary prose.
`);
    expect(valueless.status).toBe("unparseable");
    expect(valueless.invalid).toEqual([{ section: "Coherence", reason: "valueless" }]);
    expect(prose.status).toBe("active");
    expect(prose.invalid).toEqual([]);
    expect(prose.principles.map((p) => p.name)).toEqual(["Security"]);
  });

  it("T4: five bad classes plus one good activates NOTHING", () => {
    const c = contractFrom(`# R

## A
a
Blocking: nit

## B
b
Blocking: warn

## C
c
Blocking: info

## D
d
Blocking: minor

## E
e
Blocking: trivial

## Security
s
Blocking: blocking
`);
    // The pre-fix parser activated here with exactly one principle. That is the
    // measured behaviour this fixture exists to change.
    expect(c.status).toBe("unparseable");
    expect(c.invalid).toHaveLength(5);
  });

  it("T5: a SECOND declaration in a section is examined, so a good-then-bad section invalidates", () => {
    const c = contractFrom(`# R

## Security
s
Blocking: blocking
Blocking: nit
`);
    // `??=` keeps the first and never looks at the second, so the bad word is
    // never seen and the contract activates. Only a parser that examines every
    // declaration reports this.
    expect(c.status).toBe("unparseable");
    expect(c.invalid).toEqual([{ section: "Security", reason: "unrecognised-class", word: "nit" }]);
  });

  it("BLOCKING_CLASSES is the declared vocabulary and nothing else", () => {
    expect([...BLOCKING_CLASSES]).toEqual(["blocking", "major", "suggestion"]);
  });
});

// ---------------------------------------------------------------------------
// B3/B4: coverage by lens precedence, and the Outside grammar
// ---------------------------------------------------------------------------

describe("T-487 B3: coverage, lens precedence", () => {
  const c = contractFrom(SIX);

  it("T6: a NON-LENS finding whose category is on the Outside line is OUTSIDE, and is not capped", () => {
    const f = finding({
      severity: "major",
      category: "performance",
      principle: undefined,
      contributingLenses: undefined,
    });
    const p = project(f, c, baseline("major", true));
    expect(p.coverage).toBe("outside");
    expect(p.projectedSeverity).toBe("major");
  });

  it("T7: a merge spanning covered and uncovered lenses is INSIDE, in both input orders", () => {
    const spanning = (lenses: readonly string[]) =>
      project(
        finding({ severity: "major", category: "performance", principle: undefined, contributingLenses: lenses }),
        c,
        baseline("major", true),
      );
    // `performance` is on the Outside line; `security` is not. Lens ids decide,
    // and a single covered member keeps the merge inside.
    expect(spanning(["performance", "security"]).coverage).toBe("inside");
    expect(spanning(["security", "performance"]).coverage).toBe("inside");
    // Positive control, so "always inside" cannot pass: all members outside.
    expect(spanning(["performance", "accessibility"]).coverage).toBe("outside");
  });

  it("T8: a lens finding whose CATEGORY is outside but whose lenses are covered is INSIDE", () => {
    // The recorded cost of lens precedence, pinned deliberately: a category
    // entry on the Outside line is INERT for lens-path findings (ISS-1141).
    const p = project(
      finding({ severity: "major", category: "performance", principle: undefined, contributingLenses: ["security"] }),
      c,
      baseline("major", true),
    );
    expect(p.coverage).toBe("inside");
    expect(p.projectedSeverity).toBe("suggestion");
  });

  it("T6b: matching normalizes BOTH sides, so whitespace and punctuation do not smuggle a finding inside", () => {
    // The Outside entries were trimmed, lowercased and depunctuated while the
    // values matched against them were only lowercased, so a category a human
    // typed as " Performance; " missed its own entry and was capped.
    const nonLens = project(
      finding({ severity: "major", category: " Performance; ", principle: undefined, contributingLenses: undefined }),
      c,
      baseline("major", true),
    );
    expect(nonLens.coverage).toBe("outside");
    expect(nonLens.projectedSeverity).toBe("major");
    const lensPath = project(
      finding({ severity: "major", category: "x", principle: undefined, contributingLenses: [" Accessibility ", "data-safety."] }),
      c,
      baseline("major", true),
    );
    expect(lensPath.coverage).toBe("outside");
  });

  it("T9: a codex finding with an unrecognised category is INSIDE", () => {
    // The laundering guard. Defaulting an unrecognised category to outside
    // would let any finding exempt itself by inventing a category.
    const p = project(
      finding({ severity: "major", category: "n-plus-one", principle: undefined, contributingLenses: undefined }),
      c,
      baseline("major", true),
    );
    expect(p.coverage).toBe("inside");
    expect(p.projectedSeverity).toBe("suggestion");
  });
});

describe("T-487 B4: the Outside section grammar", () => {
  it("T19: an empty Outside section warns, naming the consequence", () => {
    const empty = contractFrom(`${SIX_NO_OUTSIDE}## Outside this contract

`);
    expect(empty.status).toBe("active");
    expect(empty.outside).toEqual([]);
    const w = reviewContractWarnings(empty, { effectiveBackends: ["codex", "agent"] });
    const kinds = w.map((x) => x.kind);
    expect(kinds).toContain("review-contract-empty-outside");
    // An empty outside set is the QUIETEST configuration, so silence and
    // correctness are indistinguishable from the outcome. The message has to
    // say what it means, not merely that it happened.
    expect(w.find((x) => x.kind === "review-contract-empty-outside")!.message)
      .toMatch(/every finding|full coverage/i);
  });

  it("T19b: duplicate Outside sections union and warn", () => {
    const dup = contractFrom(`${SIX_NO_OUTSIDE}## Outside this contract
performance

## Outside this contract
accessibility, data-safety
`);
    expect([...dup.outside].sort()).toEqual(["accessibility", "data-safety", "performance"]);
    expect(reviewContractWarnings(dup, { effectiveBackends: ["codex"] }).map((x) => x.kind))
      .toContain("review-contract-duplicate-outside");
  });

  it("entries are split on commas and newlines, trimmed, lowercased and depunctuated", () => {
    const c = contractFrom(`${SIX_NO_OUTSIDE}## Outside this contract
Performance, Accessibility.
data-safety;
`);
    expect([...c.outside].sort()).toEqual(["accessibility", "data-safety", "performance"]);
  });
});

// ---------------------------------------------------------------------------
// B2: the projection, its precedence, and clause 18's floor
// ---------------------------------------------------------------------------

describe("T-487 B2: the projected decision", () => {
  const c = contractFrom(SIX);

  it("T10: the class changes the PROJECTED landing and nothing else, severities identical", () => {
    // THE SAME FINDING, byte for byte, against two contracts that differ in one
    // class word. Nothing about the finding varies, so an implementation that
    // decides by principle name or category rather than by the declared class
    // answers the same in both arms and fails here.
    const f = finding({ severity: "major", category: "robustness", principle: "robustness" });
    const blockingArm = project(f, c, baseline("major", true));
    const majorArm = project(f, contractFrom(SIX_ROBUSTNESS_MAJOR), baseline("major", true));

    expect(blockingArm.policyBlock).toBe("block");
    expect(majorArm.policyBlock).toBe("baseline");
    expect(blockingArm.projectedSeverity).toBe("major");
    expect(majorArm.projectedSeverity).toBe("major");
    expect(blockingArm.actualSeverity).toBe(majorArm.actualSeverity);

    const gate = (pr: typeof blockingArm) =>
      projectRoundGate({
        projections: [pr],
        baselineHasCriticalOrMajor: true,
        baselineHasUnresolvedCritical: false,
      });
    // `forcedLanding` is guarded on CRITICALS only, so an implementation that
    // widens the predicate and not the guard leaves both arms landing.
    expect(gate(blockingArm).forcedLandingAllowed).toBe(false);
    expect(gate(majorArm).forcedLandingAllowed).toBe(true);
  });

  it("T10b: a CRITICAL naming a major-class principle keeps critical and is not ceiling-eligible", () => {
    const p = project(
      finding({ severity: "critical", category: "coherence", principle: "coherence" }),
      c,
      baseline("critical", true),
    );
    expect(p.projectedSeverity).toBe("critical");
    const gate = projectRoundGate({
      projections: [p],
      baselineHasCriticalOrMajor: true,
      baselineHasUnresolvedCritical: true,
    });
    expect(gate.hasUnresolvedCritical).toBe(true);
    expect(gate.forcedLandingAllowed).toBe(false);
  });

  it("T10d: at the hard ceiling the projected gate composes into a PARK, not a landing", () => {
    // SCOPE, stated so this is not read as more than it is: this covers the
    // composition of the projected gate with the REAL `decideCeiling`. It does
    // NOT prove production integration, because production's `forcedLanding`
    // does not consult the projected gate yet; that wiring and its test are
    // workstream G. Codex asked for the distinction to be explicit.
    const stages = { CODE_REVIEW: { maxReviewRounds: 2 } } as never;
    const state = {
      ticket: { id: "T-1" },
      resolvedReviewEffort: { explicitKnobs: { codeReviewMaxRounds: true } },
      codeReviewRoundCounter: { workItemId: "T-1", kind: "ticket", completedRounds: 4 },
    } as never;
    expect(codeReviewHardCeiling(state, stages, "low")).toBe(5);

    const f = finding({ severity: "major", category: "robustness", principle: "robustness" });
    const arm = (contract: ReviewContract) =>
      projectRoundGate({
        projections: [project(f, contract, baseline("major", true))],
        baselineHasCriticalOrMajor: true,
        baselineHasUnresolvedCritical: false,
      });
    const projectedAction = (allowed: boolean) => (allowed ? "FINALIZE" : "IMPLEMENT");

    const blocking = arm(c);
    const major = arm(contractFrom(SIX_ROBUSTNESS_MAJOR));
    expect(blocking.forcedLandingAllowed).toBe(false);
    expect(major.forcedLandingAllowed).toBe(true);

    expect(decideCeiling({
      state, stages, risk: "low", nextAction: projectedAction(blocking.forcedLandingAllowed),
    }).shouldPark).toBe(true);
    expect(decideCeiling({
      state, stages, risk: "low", nextAction: projectedAction(major.forcedLandingAllowed),
    }).shouldPark).toBe(false);
  });

  it("T10c: a MINOR naming a blocking-class principle projects the BASELINE (clause 18 floor)", () => {
    const p = project(
      finding({ severity: "minor", category: "robustness", principle: "robustness" }),
      c,
      baseline("minor", false),
    );
    expect(p.policyBlock).toBe("baseline");
    expect(p.floorSuppressed).toBe(true);
    const gate = projectRoundGate({
      projections: [p],
      baselineHasCriticalOrMajor: false,
      baselineHasUnresolvedCritical: false,
    });
    // Identical to the no-contract baseline: the minor changes nothing.
    expect(gate.hasCriticalOrMajor).toBe(false);
    expect(gate.forcedLandingAllowed).toBe(true);
  });

  it("T10e: the week counts exactly the qualifying MINORS, not every below-floor severity", () => {
    const findings = [
      // Two that qualify: minor, inside, declared blocking-class principle, no exemption.
      finding({ id: "q1", severity: "minor", category: "robustness", principle: "robustness" }),
      finding({ id: "q2", severity: "minor", category: "security", principle: "security" }),
      // Four minors that must NOT count, for four DIFFERENT reasons.
      finding({ id: "n1", severity: "minor", category: "robustness", principle: "made-up" }),
      finding({ id: "n2", severity: "minor", category: "coherence", principle: "coherence" }),
      finding({ id: "n3", severity: "minor", category: "n-plus-one", principle: "robustness", contributingLenses: ["performance"] }),
      finding({ id: "n4", severity: "minor", category: "injection", principle: "robustness" }),
      // Three that WOULD also be refused by the floor but are not minors, so
      // clause 18's measurement excludes them. Without these the fixture cannot
      // tell "count qualifying minors" from "count every below-floor
      // promotion", and the implementation was doing the second. Codex found it.
      finding({ id: "s1", severity: "suggestion", category: "robustness", principle: "robustness" }),
      finding({ id: "s2", severity: "nitpick", category: "robustness", principle: "robustness" }),
      finding({ id: "s3", severity: "wat", category: "robustness", principle: "robustness" }),
    ];
    const ev = evaluatePrinciplePolicy({
      contract: c,
      findings,
      baselines: findings.map((f) => baseline(String(f.severity), false)),
      isRoundBlocker,
      alwaysBlock: ["injection"],
    });
    expect(ev.floorSuppressedMinorCount).toBe(2);
    // The wider count is reported too, and is deliberately a different number.
    expect(ev.floorSuppressedTotal).toBe(5);

    const noMinors = findings.slice(2);
    const none = evaluatePrinciplePolicy({
      contract: c,
      findings: noMinors,
      baselines: noMinors.map((f) => baseline(String(f.severity), false)),
      isRoundBlocker,
      alwaysBlock: ["injection"],
    });
    expect(none.floorSuppressedMinorCount).toBe(0);
  });

  it("T10f: a missing baseline is a caller error, not a non-blocking finding", () => {
    // Defaulting to `blocking: false` invented a backend decision that was
    // never made, in the quiet direction, and hid the integration bug that
    // produced it.
    expect(() => evaluatePrinciplePolicy({
      contract: c,
      findings: [finding({ severity: "critical" }), finding({ severity: "major" })],
      baselines: [baseline("critical", true)],
      isRoundBlocker,
    })).toThrow(/baselines/i);
  });

  it("T7b: capping actually QUIETS the projected gate, and clears only what it capped", () => {
    // The central behaviour of the contract, and the projection could not
    // measure it: capping moved `projectedSeverity` while the blocker kept
    // reading the backend's PRE-CAP decision, so every capping case reported
    // "nothing would change". Codex found it.
    const capped = finding({ id: "capped", severity: "critical", category: "quality", principle: undefined });
    const untouched = finding({ id: "other", severity: "critical", category: "robustness", principle: "robustness" });

    const one = evaluatePrinciplePolicy({
      contract: c,
      findings: [capped],
      baselines: [baseline("critical", true)],
      isRoundBlocker,
    });
    expect(one.projections[0]!.projectedSeverity).toBe("suggestion");
    expect(one.projections[0]!.projectedRoundBlocker).toBe(false);
    const quieted = projectRoundGate({
      projections: one.projections,
      baselineHasCriticalOrMajor: true,
      baselineHasUnresolvedCritical: true,
    });
    expect(quieted.hasUnresolvedCritical).toBe(false);
    expect(quieted.hasCriticalOrMajor).toBe(false);
    expect(quieted.baselineHasUnresolvedCritical).toBe(true);

    // CONTROL: a second, uncapped critical must keep the gate closed, so the
    // clearing above cannot be an implementation that clears unconditionally.
    const two = evaluatePrinciplePolicy({
      contract: c,
      findings: [capped, untouched],
      baselines: [baseline("critical", true), baseline("critical", true)],
      isRoundBlocker,
    });
    const stillBlocked = projectRoundGate({
      projections: two.projections,
      baselineHasCriticalOrMajor: true,
      baselineHasUnresolvedCritical: true,
    });
    expect(stillBlocked.hasUnresolvedCritical).toBe(true);
    expect(stillBlocked.forcedLandingAllowed).toBe(false);
  });

  it("T11: `correctness` on an explicitly OUTSIDE finding, at major, still blocks", () => {
    const p = project(
      finding({ severity: "major", category: "performance", principle: "correctness", contributingLenses: ["performance"] }),
      c,
      baseline("major", true),
    );
    expect(p.coverage).toBe("outside");
    expect(p.policyBlock).toBe("block");
  });

  it("T12: an explicit `neverBlock` entry beats `correctness`, and validate warns naming it", () => {
    const f = finding({ severity: "major", category: "correctness", principle: "correctness" });
    const p = project(f, c, baseline("major", false), { neverBlock: ["correctness"] });
    expect(p.policyBlock).toBe("baseline");
    // The backend's own decision is preserved, not reconstructed...
    expect(p.projectedRoundBlocker).toBe(false);
    // ...AND it survives aggregation. Asserting only the per-finding decision
    // let the round gate reconstruct blocking from severity and reverse it one
    // level up, which is where the same defect came back. Codex found it twice.
    const gate = projectRoundGate({
      projections: [p],
      baselineHasCriticalOrMajor: false,
      baselineHasUnresolvedCritical: false,
    });
    expect(gate.hasCriticalOrMajor).toBe(false);
    expect(gate.forcedLandingAllowed).toBe(true);
    const w = reviewContractWarnings(c, {
      effectiveBackends: ["codex", "agent"],
      neverBlock: ["correctness"],
    });
    const silencing = w.find((x) => x.kind === "review-contract-config-silences-implicit");
    expect(silencing).toBeDefined();
    expect(silencing!.message).toContain("correctness");
  });

  it("T13: an INVALID contract returns the baseline unchanged, including for a major `correctness` finding", () => {
    const invalid = contractFrom(`# R

## Security
s
Blocking: nit
`);
    expect(invalid.status).toBe("unparseable");
    const p = project(
      finding({ severity: "major", category: "correctness", principle: "correctness" }),
      invalid,
      baseline("major", true),
    );
    // Clause 7: an inactive contract applies NOTHING. Running the implicit
    // check above the activation check would produce "block" from a contract
    // that is not in force.
    expect(p.policyBlock).toBe("baseline");
    expect(p.projectedSeverity).toBe("major");
  });

  it("T14: a config-touched finding keeps the BACKEND's decision, not a re-derived one", () => {
    // Fixture (a): an `alwaysBlock` category the lens policy RETAINED at major
    // because it was below the confidence floor and below quorum. A
    // reconstruction that reads `alwaysBlock` as "force critical" gets this
    // wrong in the loud direction.
    const belowQuorum = project(
      finding({ severity: "major", category: "injection", principle: undefined }),
      c,
      baseline("major", true),
      { alwaysBlock: ["injection"] },
    );
    expect(belowQuorum.projectedSeverity).toBe("major");
    expect(belowQuorum.projectedRoundBlocker).toBe(true);

    // Fixture (b): a MIXED-lens `neverBlock` finding whose CATEGORY matches no
    // lens id. lenses keys `neverBlock` on LENS IDS, so a category-only
    // exemption misses this finding entirely and the contract would overwrite a
    // decision clause 13 says to preserve. Codex found it: the previous fixture
    // set the category equal to the lens id, so it passed either way.
    const mixed = project(
      finding({
        severity: "major",
        category: "permission-check",
        principle: undefined,
        contributingLenses: ["clean-code", "security"],
      }),
      c,
      baseline("major", true),
      { neverBlock: ["clean-code"] },
    );
    expect(mixed.projectedSeverity).toBe("major");
    expect(mixed.projectedRoundBlocker).toBe(true);
    expect(mixed.reason).toContain("clean-code");

    // ...and the same shape where the finding names an IMPLICIT principle, the
    // one case where a missed exemption would promote rather than merely fail
    // to preserve.
    const implicitButMuted = project(
      finding({
        severity: "major",
        category: "permission-check",
        principle: "security",
        contributingLenses: ["security"],
      }),
      c,
      baseline("major", false),
      { neverBlock: ["security"] },
    );
    expect(implicitButMuted.policyBlock).toBe("baseline");
    expect(implicitButMuted.projectedRoundBlocker).toBe(false);

    // A config-exempt CRITICAL the backend decided does NOT block. The
    // criticals-only consumer has to honour that too, and deriving it from
    // severity alone would report an unresolved critical the backend had
    // already dismissed.
    const exemptCritical = project(
      finding({ severity: "critical", category: "auth-bypass", principle: undefined }),
      c,
      baseline("critical", false),
      { neverBlock: ["auth-bypass"] },
    );
    expect(exemptCritical.projectedRoundBlocker).toBe(false);
    expect(exemptCritical.projectedUnresolvedCritical).toBe(false);
    expect(projectRoundGate({
      projections: [exemptCritical],
      baselineHasCriticalOrMajor: false,
      baselineHasUnresolvedCritical: false,
    }).hasUnresolvedCritical).toBe(false);

    // END TO END: the preserved decision has to survive the aggregate too.
    const exemptOnly = projectRoundGate({
      projections: [implicitButMuted],
      baselineHasCriticalOrMajor: false,
      baselineHasUnresolvedCritical: false,
    });
    expect(exemptOnly.hasCriticalOrMajor).toBe(false);
    expect(exemptOnly.hasUnresolvedCritical).toBe(false);
    expect(exemptOnly.forcedLandingAllowed).toBe(true);

    // CONTROL: a genuinely blocking finding alongside it still closes the gate,
    // so the clearing above is preservation and not an aggregate that never
    // reports anything.
    const withBlocker = projectRoundGate({
      projections: [
        implicitButMuted,
        project(
          finding({ severity: "critical", category: "robustness", principle: "robustness" }),
          c,
          baseline("critical", true),
        ),
      ],
      baselineHasCriticalOrMajor: true,
      baselineHasUnresolvedCritical: true,
    });
    expect(withBlocker.hasCriticalOrMajor).toBe(true);
    expect(withBlocker.hasUnresolvedCritical).toBe(true);
    expect(withBlocker.forcedLandingAllowed).toBe(false);
  });

  it("T15: the origin guard outranks the cap", () => {
    const p = project(
      finding({ severity: "critical", category: "robustness", principle: undefined, originClass: "reintroduced" }),
      c,
      baseline("critical", true),
    );
    // Without the early return this is capped to suggestion, laundering a
    // confirmed re-raise through the principle axis.
    expect(p.projectedSeverity).toBe("critical");
    expect(p.policyBlock).toBe("baseline");
    expect(p.projectedRoundBlocker).toBe(true);
  });

  it("T16: dispositions are enumerated against the production predicate, not assumed", () => {
    const at = (disposition: string) =>
      project(
        finding({ severity: "major", category: "robustness", principle: "robustness", disposition }),
        c,
        baseline("major", true),
      );
    // `addressed` and `deferred` are settled; `open` and `contested` are not.
    expect(at("addressed").unresolved).toBe(false);
    expect(at("deferred").unresolved).toBe(false);
    expect(at("open").unresolved).toBe(true);
    expect(at("contested").unresolved).toBe(true);
  });

  it("T17: the gate is a CONJUNCTION, so a settled finding does not block even at policyBlock block", () => {
    const settled = project(
      finding({ severity: "major", category: "security", principle: "security", disposition: "addressed" }),
      c,
      baseline("major", true),
    );
    // FIRST: prove the fixture reached the state it claims to test. Without
    // this the test cannot tell "the conjunction rejected a blocking finding"
    // from "there was never a blocking finding to reject".
    expect(settled.policyBlock).toBe("block");
    expect(settled.unresolved).toBe(false);
    expect(settled.projectedRoundBlocker).toBe(false);

    // Positive control: identical but open.
    const open = project(
      finding({ severity: "major", category: "security", principle: "security", disposition: "open" }),
      c,
      baseline("major", true),
    );
    expect(open.policyBlock).toBe("block");
    expect(open.projectedRoundBlocker).toBe(true);
  });

  it("T21: nothing is applied", () => {
    const findings = [
      Object.freeze(finding({ id: "a", severity: "critical", category: "robustness", principle: undefined })),
      Object.freeze(finding({ id: "b", severity: "major", category: "security", principle: "security" })),
      Object.freeze(finding({ id: "c", severity: "minor", category: "coherence", principle: "coherence" })),
    ];
    const before = JSON.parse(JSON.stringify(findings));
    const ev = evaluatePrinciplePolicy({
      contract: c,
      findings,
      baselines: findings.map((f) => baseline(String(f.severity), true)),
      isRoundBlocker,
    });
    expect(ev.active).toBe(true);
    // The same array, not a copy that was capped and returned.
    expect(ev.findings).toBe(findings);
    // EVERY finding, not index 0: a capping mutant that writes to a fresh
    // allocation survives a frozen-input check, and only a full comparison
    // against the pre-run snapshot catches it.
    expect(JSON.parse(JSON.stringify(findings))).toEqual(before);
    expect(ev.projections).toHaveLength(3);
    // The projection SAYS the first finding would be capped, and the finding
    // itself is untouched. That pair is the report-only contract.
    expect(ev.projections[0]!.projectedSeverity).toBe("suggestion");
    expect(findings[0]!.severity).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// C: `storybloq validate`
// ---------------------------------------------------------------------------

describe("T-487 C: validate warnings", () => {
  it("T18: EFFECTIVE backends drive the warning, not the raw override array", () => {
    const absent = loadReviewContract(mkdtempSync(join(tmpdir(), "t487-empty-")));
    expect(absent.status).toBe("absent");
    // A project with NO reviewBackends override: the raw array is absent and
    // the effective list defaults to codex + agent. Reading the raw array
    // leaves this project silent, which is the recorded defect.
    const w = reviewContractWarnings(absent, { effectiveBackends: ["codex", "agent"] });
    expect(w.map((x) => x.kind)).toContain("review-contract-absent");
    // Clause 20: the message names the setup step that creates the file.
    expect(w[0]!.message).toMatch(/setup/i);
  });

  it("T18b: no effective backends means nothing reviews, so nothing is missing", () => {
    const absent = loadReviewContract(mkdtempSync(join(tmpdir(), "t487-empty2-")));
    expect(reviewContractWarnings(absent, { effectiveBackends: [] })).toEqual([]);
  });

  it("C2: an unrecognised class word is an ERROR naming the section and the word", () => {
    const c = contractFrom(`# R

## Security
s
Blocking: nit
`);
    const w = reviewContractWarnings(c, { effectiveBackends: ["codex"] });
    const err = w.find((x) => x.kind === "review-contract-invalid-class");
    expect(err).toBeDefined();
    expect(err!.level).toBe("error");
    expect(err!.message).toContain("Security");
    expect(err!.message).toContain("nit");
  });

  it("C4: neverBlock is read from the RAW config, because the parsed schema strips it", () => {
    const root = mkdtempSync(join(tmpdir(), "t487-cfg-"));
    mkdirSync(join(root, ".story"));
    writeFileSync(
      join(root, ".story", "config.json"),
      JSON.stringify({ recipeOverrides: { blockingPolicy: { neverBlock: ["correctness"] } } }),
      "utf-8",
    );
    // `blockingPolicy` is NOT declared in ConfigSchema.recipeOverrides, and that
    // object is a plain z.object, so `parse` STRIPS it. A reader keyed on the
    // parsed config returns undefined for every project, configured or not, and
    // the warning below can never fire. That is the same defect as the raw-array
    // gate this workstream exists to fix, arriving from the other side.
    expect(readBlockingPolicy(root).neverBlock).toEqual(["correctness"]);
    // The defaults are the lens harness's own, not empty.
    expect(readBlockingPolicy(mkdtempSync(join(tmpdir(), "t487-nocfg-"))).alwaysBlock)
      .toEqual(["injection", "auth-bypass", "hardcoded-secrets"]);
  });

  it("C5: a punctuated neverBlock entry both exempts the finding AND is named in the warning", () => {
    const c = contractFrom(SIX);
    const p = project(
      finding({ severity: "major", category: "security", principle: "security" }),
      c,
      baseline("major", false),
      { neverBlock: [" Security; "] },
    );
    expect(p.policyBlock).toBe("baseline");
    const w = reviewContractWarnings(c, {
      effectiveBackends: ["codex"],
      neverBlock: [" Security; "],
    });
    // The exemption took effect through `coverageKey`; a warning that only
    // lowercases stays silent, so the override that DID happen is the one
    // nobody is told about.
    expect(w.map((x) => x.kind)).toContain("review-contract-config-silences-implicit");
  });

  it("C2b: an active contract with a full Outside line warns about nothing", () => {
    const c = contractFrom(SIX);
    expect(c.status).toBe("active");
    expect(reviewContractWarnings(c, { effectiveBackends: ["codex", "agent"] })).toEqual([]);
  });
});
