"""Job dirs -> markdown tables. Metrics as defined in plan-t500.md:

  scheduled        = every (task, arm) in the frozen manifest for the arms reported; a scheduled
                     trial without output is an explicit missing row and fails the build
  denominator      = scheduled trials that STARTED (started.json). A pre-start infra failure
                     (infra-failure.json, no started.json) is excluded and may be rerun ONCE;
                     the rerun row is selected, the original stays in the raw listing
  pass rate        = passes / denominator
  cost per task    = mean total cost over the denominator; UNAVAILABLE if any row's cost is unknown
  cost per passed  = total arm spend over the denominator / passes; undefined when passes == 0;
                     UNAVAILABLE when any row's cost is unknown (a labelled lower bound is printed)
  cost | success   = mean cost over passed rows; UNAVAILABLE if any passed row's cost is unknown
Cost is unknown whenever executor coverage is not complete, a model or dimension is unpriced,
or (A2/A4) reviewer usage is neither complete nor verified zero.
Reconciliation: executor cost vs harness total_cost_usd, tolerance max(0.02, 5%); a mismatch
fails the build unless annotated (`task:arm:attempt=explanation`); annotated rows keep the
mismatch visible with both figures and the explanation.
Manifest integrity: every started row must carry the manifest's SHA-256 (file bytes) and the
job's arm; the prices file must hash to the manifest's prices_sha256.
"""
from __future__ import annotations

import hashlib
import json
import statistics
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from report.parse import Row, cost_usd, load_prices, missing_row, parse_trial  # noqa: E402
from report.seed import dir_hash  # noqa: E402

ABS_TOL = 0.02
REL_TOL = 0.05


@dataclass
class Costed:
    row: Row
    executor_cost: float | None
    reviewer_cost: float | None
    unknown: list[str]
    selected: bool = True
    notes: list[str] = field(default_factory=list)

    @property
    def total(self) -> float | None:
        if self.executor_cost is None:
            return None
        if self.row.arm in ("A2", "A4") and self.reviewer_cost is None:
            return None
        return self.executor_cost + (self.reviewer_cost or 0.0)


def cost_rows(rows: list[Row], prices: dict[str, dict[str, float]]) -> list[Costed]:
    out = []
    for r in rows:
        unknown: list[str] = []
        if r.executor_coverage == "complete":
            ec, eu = cost_usd(r.executor, prices, "anthropic")
            unknown += eu
        else:
            ec = None
            unknown.append(f"executor-coverage:{r.executor_coverage}")
        if r.reviewer_coverage in ("n/a", "verified-zero"):
            rc: float | None = 0.0
        elif r.reviewer_coverage == "complete":
            rc, ru = cost_usd(r.reviewer, prices, "openai")
            unknown += ru
        else:
            rc = None
            unknown.append(f"reviewer-coverage:{r.reviewer_coverage}")
        out.append(Costed(r, ec, rc, unknown))
    return out


def reconcile(c: Costed, annotations: dict[str, str]) -> str | None:
    """Applies the tolerance. Returns an error string for an unexplained mismatch; an annotated
    mismatch is recorded on the row (both figures plus the explanation) and returns None."""
    h = c.row.harness_cost_usd
    if h is None or c.executor_cost is None:
        return None
    if abs(h - c.executor_cost) <= max(ABS_TOL, REL_TOL * max(h, c.executor_cost)):
        return None
    detail = f"harness {h:.4f} vs executor {c.executor_cost:.4f}"
    if annotations.get(c.row.key, "").strip():
        c.notes.append(f"cost-mismatch ({detail}): {annotations[c.row.key]}")
        c.row.statuses["telemetry"] = (c.row.statuses["telemetry"] + ";" if c.row.statuses["telemetry"] != "ok" else "") + "cost-mismatch(annotated)"
        return None
    return f"cost-mismatch {c.row.key}: {detail}"


def select_rows(rows: list[Row]) -> tuple[dict[str, bool], list[str]]:
    """Which row per (task, arm) enters the summaries, enforcing the one-rerun policy.
    Returns ({row.key: selected}, errors). Every row stays in the raw listing."""
    sel: dict[str, bool] = {r.key: False for r in rows}
    errors: list[str] = []
    groups: dict[tuple[str, str], list[Row]] = {}
    for r in rows:
        groups.setdefault((r.task, r.arm), []).append(r)
    for (task, arm), rs in groups.items():
        rs.sort(key=lambda r: r.attempt)
        if [r.attempt for r in rs] != list(range(1, len(rs) + 1)):
            errors.append(f"{task}:{arm}: attempts are not 1..n: {[r.attempt for r in rs]}")
        for r in rs:
            if "start-unknown" in r.diagnostics:
                errors.append(f"{r.key}: start status cannot be established (no started.json and no infra-failure.json)")
        first = rs[0]
        if first.statuses["infra"] == "ok":
            sel[first.key] = True
            for extra in rs[1:]:
                errors.append(f"{extra.key}: rerun of a trial that already started ({first.key}); only a pre-start infra failure may be rerun")
        else:
            if len(rs) == 1:
                sel[first.key] = True  # the infra failure stands, excluded from the denominator
            else:
                sel[rs[1].key] = True
                for extra in rs[2:]:
                    errors.append(f"{extra.key}: more than one rerun for {task}:{arm}")
    return sel, errors


@dataclass
class ArmSummary:
    arm: str
    scheduled: int
    infra_excluded: int
    denominator: int
    passes: int
    pass_rate: float | None
    cost_per_task: float | None
    cost_per_passed: float | str | None  # float, "undefined", or None (unavailable)
    lower_bound_per_passed: float | None
    cost_given_success: float | None
    unknown_cost_rows: int
    mean_wall_clock: float | None
    mean_rounds: float | None
    no_review: int
    guide_not_invoked: int
    flagged: int
    rate_limited: int = 0
    timeout_after_completion: int = 0
    real_timeout: int = 0


def summarize(arm: str, costed: list[Costed], compliant_only: bool = False) -> ArmSummary:
    rows = [c for c in costed if c.row.arm == arm and c.selected]
    scheduled = len(rows)
    valid = [c for c in rows if c.row.statuses["infra"] == "ok"]
    if compliant_only:
        valid = [c for c in valid if c.row.statuses.get("compliance") in ("reviewed", "n/a", "ok")]
    n = len(valid)
    passes = sum(1 for c in valid if c.row.pass_ is True)
    unknown = sum(1 for c in valid if c.total is None)
    known_spend = sum(c.total for c in valid if c.total is not None)
    if n == 0:
        cpt, cpp, lb = None, None, None
    elif unknown:
        cpt, cpp, lb = None, None, ((known_spend / passes) if passes else None)
    else:
        cpt, cpp, lb = known_spend / n, ((known_spend / passes) if passes else "undefined"), None
    succ = [c.total for c in valid if c.row.pass_ is True]
    cgs = statistics.mean(succ) if succ and all(s is not None for s in succ) else None
    wc = [c.row.wall_clock_s for c in valid if c.row.wall_clock_s is not None]
    rounds = [c.row.review_rounds for c in valid]
    # ISS-1200: a trial that solved and cleaned up before harbor's own AgentTimeoutError
    # finalized it (agent status "timeout-after-completion") is not a compliance flag; a real
    # timeout (agent status still "timeout") is reported in its own column, not folded in here.
    flagged = sum(1 for c in valid if c.row.statuses["agent"] not in ("completed", "timeout-after-completion") or any(c.row.statuses[k] != "ok" for k in ("verifier", "telemetry", "collection")) or c.row.statuses.get("compliance") in ("no-review", "isolation-violated", "guide-not-invoked"))
    return ArmSummary(
        arm=arm, scheduled=scheduled, infra_excluded=scheduled - len([c for c in rows if c.row.statuses["infra"] == "ok"]),
        denominator=n, passes=passes, pass_rate=(passes / n) if n else None,
        cost_per_task=cpt, cost_per_passed=cpp, lower_bound_per_passed=lb,
        cost_given_success=cgs, unknown_cost_rows=unknown,
        mean_wall_clock=(statistics.mean(wc) if wc else None), mean_rounds=(statistics.mean(rounds) if rounds else None),
        no_review=sum(1 for c in valid if c.row.statuses.get("compliance") == "no-review"),
        guide_not_invoked=sum(1 for c in valid if c.row.statuses.get("compliance") == "guide-not-invoked"), flagged=flagged,
        rate_limited=sum(1 for c in valid if c.row.statuses.get("rate_limit") == "rate-limited"),
        timeout_after_completion=sum(1 for c in valid if c.row.statuses["agent"] == "timeout-after-completion"),
        real_timeout=sum(1 for c in valid if c.row.statuses["agent"] == "timeout"),
    )


def _f(v, fmt="{:.4f}"):
    if v is None:
        return "unavailable"
    if isinstance(v, str):
        return v
    return fmt.format(v)


def render(header: dict[str, str], summaries: list[ArmSummary], compliant: list[ArmSummary], costed: list[Costed], errors: list[str]) -> str:
    lines = ["# Terminal-Bench 2.0 pilot report", ""]
    for k, v in header.items():
        lines.append(f"- {k}: {v}")
    if errors:
        lines += ["", "## BUILD ERRORS (tables below are not valid until these are resolved)", ""] + [f"- {e}" for e in errors]
    lines += ["", "## Per arm (denominator = selected trials that started)", "",
              "| Arm | n | passes | pass rate | cost/task USD | wall clock s | rounds | flagged | no-review | guide-not-invoked | infra excluded | rate-limited | timeout-after-completion | real-timeout |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for s in summaries:
        lines.append(f"| {s.arm} | {s.denominator} | {s.passes} | {_f(s.pass_rate, '{:.2f}')} | {_f(s.cost_per_task)} | {_f(s.mean_wall_clock, '{:.0f}')} | {_f(s.mean_rounds, '{:.1f}')} | {s.flagged} | {s.no_review} | {s.guide_not_invoked} | {s.infra_excluded} | {s.rate_limited} | {s.timeout_after_completion} | {s.real_timeout} |")
    lines += ["", "## Cost per PASSED task (total arm spend incl. failures / passes)", "",
              "| Arm | cost/passed USD | lower bound (known spend only) | cost given success | unknown-cost rows |", "|---|---|---|---|---|"]
    for s in summaries:
        lines.append(f"| {s.arm} | {_f(s.cost_per_passed)} | {_f(s.lower_bound_per_passed)} | {_f(s.cost_given_success)} | {s.unknown_cost_rows} |")
    lines += ["", "## Protocol-compliant trials only (A2/A4: guide invoked and reviewed; A1/A3: guide invoked; A0: isolation kept)", "",
              "| Arm | n | passes | pass rate | cost/passed USD |", "|---|---|---|---|---|"]
    for s in compliant:
        lines.append(f"| {s.arm} | {s.denominator} | {s.passes} | {_f(s.pass_rate, '{:.2f}')} | {_f(s.cost_per_passed)} |")
    lines += ["", "## Trials (every attempt; `sel` marks the row the summaries use)", "",
              "| Task | Arm | attempt | sel | pass | infra | agent | verifier | telemetry | compliance | collection | executor USD | reviewer USD | total USD | harness USD | wall s | rounds | exit | notes |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for c in sorted(costed, key=lambda c: (c.row.task, c.row.arm, c.row.attempt)):
        r = c.row
        st = r.statuses
        notes = "; ".join(c.notes + c.unknown)
        lines.append(f"| {r.task} | {r.arm} | {r.attempt} | {'y' if c.selected else 'n'} | {r.pass_} | {st['infra']} | {st['agent']} | {st['verifier']} | {st['telemetry']} | {st.get('compliance')} | {st['collection']} | {_f(c.executor_cost)} | {_f(c.reviewer_cost)} | {_f(c.total)} | {_f(r.harness_cost_usd)} | {_f(r.wall_clock_s, '{:.0f}')} | {r.review_rounds} | {r.exit_state} | {notes} |")
    return "\n".join(lines) + "\n"


def _trial_dirs(job_dir: Path) -> list[Path]:
    return sorted(p for p in job_dir.iterdir() if p.is_dir() and p.name != "logs")


def build(jobs: list[tuple[Path, str, int]], prices_path: Path, manifest_path: Path, annotations: dict[str, str], instructions: dict[str, str] | None = None, section: str = "tasks") -> tuple[str, list[str]]:
    """jobs: (job dir, arm, attempt). `section` selects the manifest task set: "tasks" (the pilot
    frame) or "smoke" (the separately snapshotted smoke task). Returns (markdown, errors);
    errors make the build fail."""
    errors: list[str] = []
    manifest = json.loads(manifest_path.read_text())
    if section not in ("tasks", "smoke"):
        errors.append(f"unknown section {section!r}")
        section = "tasks"
    manifest_sha = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    if manifest.get("kind") != "run":
        errors.append(f"{manifest_path} is not a frozen run manifest")
    prices_sha = hashlib.sha256(prices_path.read_bytes()).hexdigest()
    if manifest.get("prices_sha256") != prices_sha:
        errors.append(f"prices file {prices_path.name} sha {prices_sha[:12]} != manifest prices_sha256 {str(manifest.get('prices_sha256'))[:12]}")
    prices = load_prices(prices_path)
    task_section = manifest.get(section) or {}
    scheduled_tasks = sorted(task_section.get("tasks") or {})
    scheduled_arms = list(manifest.get("arms") or [])
    if not jobs:
        errors.append("no job directories given; the manifest schedules " + ", ".join(scheduled_arms or ["no arms"]))
    for _d, arm, _a in jobs:
        if scheduled_arms and arm not in scheduled_arms:
            errors.append(f"arm {arm} is not in the frozen schedule {scheduled_arms}")
    if section == "tasks":  # the pilot report covers the whole schedule; smoke gates are run and reported per arm
        for arm in scheduled_arms:
            if not any(a == arm and att == 1 for _d, a, att in jobs):
                errors.append(f"scheduled arm {arm} has no --job directory")
    if instructions is None:
        instructions = {}
        tdir = Path(task_section.get("dir") or "")
        for task in scheduled_tasks:
            expected = (task_section.get("tasks") or {}).get(task, {}).get("snapshot_sha256")
            if not (tdir / task).is_dir() or not expected:
                errors.append(f"{task}: snapshot directory or its recorded snapshot_sha256 is missing; ticket text cannot be verified")
                continue
            got = dir_hash(tdir / task)
            if got != expected:
                errors.append(f"{task}: snapshot {tdir / task} hashes to {got[:12]}, manifest records {expected[:12]}; refusing to read its instruction.md")
                continue
            f = tdir / task / "instruction.md"
            if f.exists():
                instructions[task] = f.read_text(encoding="utf-8")
            else:
                errors.append(f"{task}: instruction.md not found in the frozen snapshot {tdir}; ticket text cannot be verified")
    seen_paths: dict[Path, tuple[str, int]] = {}
    rows: list[Row] = []
    found: dict[tuple[str, str], set[int]] = {}
    for job_dir, arm, attempt in jobs:
        rp = job_dir.resolve()
        if rp in seen_paths and seen_paths[rp] != (arm, attempt):
            errors.append(f"{job_dir} given twice with different arm/attempt")
            continue
        seen_paths[rp] = (arm, attempt)
        if not rp.is_dir():
            errors.append(f"job dir missing: {job_dir}")
            continue
        for trial in _trial_dirs(rp):
            task = trial.name.split("__")[0]
            row = parse_trial(trial, arm, (instructions or {}).get(task), attempt)
            if task not in scheduled_tasks:
                errors.append(f"{row.key}: task not in the frozen manifest")
            if row.started and any(d.startswith(("no-result", "result-unreadable")) for d in row.diagnostics):
                errors.append(f"{row.key}: started trial has no readable result.json")
            if row.started:
                v = row.versions
                if v.get("manifest_sha256") != manifest_sha:
                    errors.append(f"{row.key}: versions.json manifest {str(v.get('manifest_sha256'))[:12]} != report manifest {manifest_sha[:12]}")
                if v.get("arm") != arm:
                    errors.append(f"{row.key}: versions.json arm {v.get('arm')!r} != job arm {arm!r}")
                if v.get("executor_model") not in (None, manifest.get("executor_model")):
                    errors.append(f"{row.key}: executor model {v.get('executor_model')!r} != manifest {manifest.get('executor_model')!r}")
            rows.append(row)
            found.setdefault((task, arm), set()).add(attempt)
    for _job_dir, arm, attempt in jobs:
        if attempt != 1:
            continue
        for task in scheduled_tasks:
            if 1 not in found.get((task, arm), set()):
                rows.append(missing_row(task, arm, 1))
                errors.append(f"{task}:{arm}:1: scheduled trial has no output (result.json missing or directory absent)")
    sel, sel_errors = select_rows(rows)
    errors += sel_errors
    costed = cost_rows(rows, prices)
    for c in costed:
        c.selected = sel[c.row.key]
    errors += [m for c in costed if c.selected and (m := reconcile(c, annotations))]
    arm_names = sorted({arm for _d, arm, _a in jobs})
    summaries = [summarize(a, costed) for a in arm_names]
    compliant = [summarize(a, costed, compliant_only=True) for a in arm_names]
    header = {k: str(manifest.get(k)) for k in ("dataset", "task_repo_commit", "harbor_version", "storybloq_commit", "skill_sha256", "claude_code_version", "codex_version", "executor_model", "reviewer_model", "frozen_at")}
    header["manifest_sha256"] = manifest_sha
    header["auth"] = "subscription (CLAUDE_CODE_OAUTH_TOKEN, ChatGPT login file); cost is ESTIMATED AT API LIST PRICE from transcript token counts, never reconciled against a bill"
    header["section"] = f"{section} ({len(scheduled_tasks)} task{'s' if len(scheduled_tasks) != 1 else ''}: {', '.join(scheduled_tasks)})"
    header["prices"] = f"{prices_path.name} dated {json.loads(prices_path.read_text()).get('date', 'UNDATED')} (sha {prices_sha[:12]})"
    return render(header, summaries, compliant, costed, errors), errors


def _parse_job(spec: str, attempt: int) -> tuple[Path, str, int]:
    arm, path = spec.split("=", 1)
    return Path(path), arm, attempt


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--job", action="append", default=[], help="<arm>=<job dir> (attempt 1)")
    ap.add_argument("--rerun", action="append", default=[], help="<arm>=<job dir> holding the single authorised reruns (attempt 2)")
    ap.add_argument("--prices", required=True)
    ap.add_argument("--manifest", required=True, help="run-manifest.json")
    ap.add_argument("--annotate", action="append", default=[], help="task:arm:attempt=explanation for an explained cost mismatch")
    ap.add_argument("--out", required=True)
    ap.add_argument("--smoke", action="store_true", help="report the manifest's smoke section instead of the pilot frame")
    a = ap.parse_args()
    jobs = [_parse_job(j, 1) for j in a.job] + [_parse_job(j, 2) for j in a.rerun]
    ann = {}
    for s in a.annotate:
        if "=" not in s:
            raise SystemExit(f"--annotate needs task:arm:attempt=explanation, got {s!r}")
        k, v = s.split("=", 1)
        if not v.strip():
            raise SystemExit(f"--annotate {k} has an empty explanation")
        ann[k] = v
    md, errs = build(jobs, Path(a.prices), Path(a.manifest), ann, section="smoke" if a.smoke else "tasks")
    Path(a.out).write_text(md)
    for e in errs:
        print(e, file=sys.stderr)
    sys.exit(1 if errs else 0)
