from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from report.build_report import Costed, build, cost_rows, reconcile, select_rows, summarize  # noqa: E402
from report.parse import Row, parse_trial  # noqa: E402
from report.seed import allocate, dir_hash  # noqa: E402

FX = ROOT / "tests" / "fixtures" / "trial-a2"
INSTRUCTION = (FX / "instruction.txt").read_text(encoding="utf-8")
PRICES = {
    "claude-sonnet-5": {"input": 3.0, "cache_read": 0.3, "cache_write_5m": 3.75, "cache_write_1h": 6.0, "output": 15.0},
    "claude-haiku-4-5-20251001": {"input": 1.0, "cache_read": 0.1, "cache_write_5m": 1.25, "cache_write_1h": 2.0, "output": 5.0},
    "gpt-6-astra": {"input": 2.0, "cached_input": 0.5, "output": 8.0},
    "gpt-5.6-sol": {"input": 1.0, "cached_input": 0.25, "output": 4.0},
}


def row(task, arm, *, attempt=1, passed=True, infra="ok", agent="completed", compliance="n/a", harness=None, wall=100.0, rounds=1, diags=()):
    return Row(
        task=task, arm=arm, attempt=attempt,
        statuses={"infra": infra, "agent": agent, "verifier": "ok" if passed is not None else "missing", "telemetry": "ok", "compliance": compliance, "collection": "ok"},
        pass_=passed, reward=(1.0 if passed else 0.0) if passed is not None else None, wall_clock_s=wall,
        executor={}, reviewer={}, executor_coverage="complete", reviewer_coverage="n/a", started=infra == "ok",
        context_at_exit=None, review_rounds=rounds, reviewer_attempts=0, exit_state=None,
        harness_cost_usd=harness, versions={}, diagnostics=list(diags),
    )


def costed(r, exec_cost, rev_cost=0.0):
    return Costed(r, exec_cost, rev_cost, [] if exec_cost is not None else ["model:x"])


def test_denominator_keeps_timeouts_excludes_infra():
    cs = [
        costed(row("a", "A1"), 1.0),
        costed(row("b", "A1", passed=None, agent="timeout"), 2.0),
        costed(row("c", "A1", infra="artifact", passed=None), None),
    ]
    s = summarize("A1", cs)
    assert s.scheduled == 3 and s.infra_excluded == 1 and s.denominator == 2
    assert s.passes == 1 and s.pass_rate == 0.5
    assert s.cost_per_task == 1.5
    assert s.cost_per_passed == 3.0  # total spend incl. the timeout / passes
    assert s.flagged == 1


def test_guide_not_invoked_flagged_counted_and_excluded_from_compliant_only():
    """ISS-1198's report-level contract: a guide-not-invoked row stays in the raw denominator
    (visible, flagged) but is excluded once compliant_only=True, same treatment as no-review and
    isolation-violated -- and the summary carries an explicit counter for it, not just a fold
    into the generic flagged total."""
    cs = [
        costed(row("a", "A1", compliance="ok"), 1.0),
        costed(row("b", "A1", compliance="guide-not-invoked"), 1.0),
    ]
    raw = summarize("A1", cs)
    assert raw.denominator == 2 and raw.flagged == 1 and raw.guide_not_invoked == 1
    compliant = summarize("A1", cs, compliant_only=True)
    assert compliant.denominator == 1 and compliant.guide_not_invoked == 0


def test_timeout_after_completion_not_flagged_real_timeout_still_flagged():
    """ISS-1200: a trial that solved and cleaned up before harbor's own AgentTimeoutError
    finalized it (agent status "timeout-after-completion") must not count toward `flagged` --
    it gets its own counter instead. A row still literally stuck at "timeout" is a real error
    and stays flagged, with its own counter too."""
    cs = [
        costed(row("a", "A1", compliance="ok"), 1.0),
        costed(row("b", "A1", agent="timeout-after-completion", compliance="ok"), 1.0),
        costed(row("c", "A1", passed=None, agent="timeout", compliance="ok"), 1.0),
    ]
    s = summarize("A1", cs)
    assert s.denominator == 3
    assert s.timeout_after_completion == 1 and s.real_timeout == 1
    assert s.flagged == 1  # only the real timeout ("c"); "a" is clean, "b" is reclassified


def test_zero_passes_is_undefined():
    s = summarize("A0", [costed(row("a", "A0", passed=False), 1.0)])
    assert s.passes == 0 and s.cost_per_passed == "undefined" and s.cost_per_task == 1.0


def test_unknown_cost_makes_arm_cost_unavailable_with_lower_bound():
    cs = [costed(row("a", "A1"), 1.0), costed(row("b", "A1"), None)]  # b PASSED but unpriced
    s = summarize("A1", cs)
    assert s.unknown_cost_rows == 1
    assert s.cost_per_task is None and s.cost_per_passed is None
    assert s.cost_given_success is None  # a passed row with unknown cost: no silent subset mean
    assert s.lower_bound_per_passed == 0.5  # known spend 1.0 over 2 passes
    assert s.pass_rate == 1.0


def test_unselected_rows_stay_out_of_summaries():
    cs = [costed(row("a", "A1", attempt=1, infra="config", passed=None), None), costed(row("a", "A1", attempt=2), 2.0)]
    cs[0].selected = False
    s = summarize("A1", cs)
    assert s.scheduled == 1 and s.denominator == 1 and s.cost_per_task == 2.0


def test_reviewer_cost_through_cost_rows_missing_vs_verified_zero(tmp_path):
    t = tmp_path / "trial"
    shutil.copytree(FX, t)
    shutil.rmtree(t / "agent" / "codex-home")  # started A2 trial, rollouts lost
    r = parse_trial(t, "A2", INSTRUCTION)
    c = cost_rows([r], PRICES)[0]
    assert c.executor_cost is not None and c.reviewer_cost is None and c.total is None
    assert "reviewer-coverage:missing" in c.unknown
    full = summarize("A2", [c])
    assert full.cost_per_task is None and full.cost_per_passed is None
    st = t / "agent" / "story-live" / ".story" / "sessions" / "s1" / "state.json"
    s = json.loads(st.read_text())
    s["reviews"] = {"plan": [], "code": []}
    st.write_text(json.dumps(s))
    r = parse_trial(t, "A2", INSTRUCTION)
    c = cost_rows([r], PRICES)[0]
    assert c.reviewer_cost == 0.0 and c.total == pytest.approx(c.executor_cost)
    comp = summarize("A2", [c], compliant_only=True)
    assert comp.denominator == 0  # no-review trial leaves the compliant table
    r2 = parse_trial(FX, "A2", INSTRUCTION)
    c2 = cost_rows([r2], PRICES)[0]
    assert c2.reviewer_cost == pytest.approx(((3300 - 1900) * 2.0 + 1900 * 0.5 + 330 * 8.0 + 50 + 20) / 1e6)


def test_incomplete_executor_coverage_is_unknown_cost():
    r = row("a", "A1")
    r.executor_coverage = "incomplete"
    c = cost_rows([r], PRICES)[0]
    assert c.executor_cost is None and c.unknown == ["executor-coverage:incomplete"]


def test_reconcile_tolerance_and_annotation():
    ok = costed(row("a", "A1", harness=1.00), 1.04)
    assert reconcile(ok, {}) is None
    bad = costed(row("a", "A1", harness=1.00), 1.30)
    assert reconcile(bad, {}) is not None
    assert reconcile(bad, {"a:A1:1": ""}) is not None  # an empty explanation explains nothing
    assert reconcile(bad, {"a:A1:1": "harness counted a retried request"}) is None
    assert bad.notes and "harness counted a retried request" in bad.notes[0] and "1.0000" in bad.notes[0]
    assert "cost-mismatch(annotated)" in bad.row.statuses["telemetry"]
    absolute = costed(row("a", "A1", harness=0.001), 0.015)  # within 0.02 absolute
    assert reconcile(absolute, {}) is None


def test_select_rows_one_rerun_policy():
    rows = [row("a", "A1", attempt=1, infra="config", passed=None), row("a", "A1", attempt=2, passed=True)]
    sel, errs = select_rows(rows)
    assert sel == {"a:A1:1": False, "a:A1:2": True} and errs == []
    rows = [row("a", "A1", attempt=1, passed=False), row("a", "A1", attempt=2, passed=True)]
    sel, errs = select_rows(rows)
    assert sel["a:A1:1"] and not sel["a:A1:2"] and any("already started" in e for e in errs)
    rows = [row("a", "A1", attempt=1, infra="config", passed=None), row("a", "A1", attempt=2, infra="config", passed=None), row("a", "A1", attempt=3)]
    sel, errs = select_rows(rows)
    assert sel["a:A1:2"] and not sel["a:A1:3"] and any("more than one rerun" in e for e in errs)
    sel, errs = select_rows([row("a", "A1", diags=["start-unknown"])])
    assert any("start status cannot be established" in e for e in errs)


def make_run(tmp_path: Path, tasks=("extract-elf", "path-tracing"), arms=("A0", "A2"), instruction=INSTRUCTION, smoke=("regex-log",)) -> tuple[Path, Path]:
    """A run manifest shaped like freeze.py's output: pilot tasks under tasks/, the smoke task under tasks-smoke/,
    each with its instruction.md and recorded snapshot_sha256."""
    prices = tmp_path / "prices.json"
    prices.write_text(json.dumps({"date": "2026-09-09", "models": {m: {**p, "source": "test"} for m, p in PRICES.items()}}))

    def section(dirname, names):
        d = tmp_path / dirname
        rec = {}
        for t in names:
            (d / t).mkdir(parents=True, exist_ok=True)
            (d / t / "instruction.md").write_text(instruction, encoding="utf-8")
            rec[t] = {"image": "x", "digest": "sha256:y", "snapshot_sha256": dir_hash(d / t)}
        return {"dir": str(d), "tasks": rec}

    man = tmp_path / "run-manifest.json"
    man.write_text(json.dumps({
        "kind": "run", "dataset": "terminal-bench@2.0", "executor_model": "claude-sonnet-5", "arms": list(arms),
        "prices_sha256": hashlib.sha256(prices.read_bytes()).hexdigest(),
        "tasks": section("tasks", tasks), "smoke": section("tasks-smoke", smoke),
    }))
    return man, prices


def place_trial(job: Path, task: str, arm: str, manifest_sha: str, *, started=True, infra=None, name=None) -> Path:
    t = job / (name or f"{task}__abcd1234")
    shutil.copytree(FX, t)
    res = json.loads((t / "result.json").read_text())
    res["task_name"] = task
    (t / "result.json").write_text(json.dumps(res))
    v = json.loads((t / "agent" / "versions.json").read_text())
    v.update({"manifest_sha256": manifest_sha, "arm": arm})
    (t / "agent" / "versions.json").write_text(json.dumps(v))
    if not started:
        (t / "agent" / "started.json").unlink()
    if infra:
        (t / "agent" / "infra-failure.json").write_text(json.dumps({"reason": infra}))
    return t


def test_build_from_job_dirs_missing_output_and_manifest_checks(tmp_path):
    man, prices = make_run(tmp_path, arms=("A2",))
    msha = hashlib.sha256(man.read_bytes()).hexdigest()
    job = tmp_path / "A2"
    job.mkdir()
    place_trial(job, "extract-elf", "A2", msha)
    md, errs = build([(job, "A2", 1)], prices, man, {})
    assert any("path-tracing:A2:1: scheduled trial has no output" in e for e in errs)
    assert not any("instruction" in e for e in errs)
    assert "| path-tracing | A2 | 1 | y | None | unknown | missing |" in md
    assert "## BUILD ERRORS" in md
    place_trial(job, "path-tracing", "A2", "0000")  # wrong manifest hash
    md, errs = build([(job, "A2", 1)], prices, man, {})
    assert any("versions.json manifest 0000" in e for e in errs) and not any("has no output" in e for e in errs)
    place_trial(job, "unknown-task", "A2", msha)
    _, errs = build([(job, "A2", 1)], prices, man, {})
    assert any("unknown-task:A2:1: task not in the frozen manifest" in e for e in errs)
    prices.write_text(prices.read_text() + " ")
    _, errs = build([(job, "A2", 1)], prices, man, {})
    assert any("prices file" in e and "!= manifest prices_sha256" in e for e in errs)


def test_build_schedule_and_instruction_checks(tmp_path):
    man, prices = make_run(tmp_path, tasks=("extract-elf",), arms=("A0", "A2"))
    msha = hashlib.sha256(man.read_bytes()).hexdigest()
    _, errs = build([], prices, man, {})
    assert any("no job directories" in e for e in errs)
    j2 = tmp_path / "A2"
    j2.mkdir()
    place_trial(j2, "extract-elf", "A2", msha)
    _, errs = build([(j2, "A2", 1)], prices, man, {})
    assert any("scheduled arm A0 has no --job directory" in e for e in errs)  # A0 is part of the frozen schedule
    j0 = tmp_path / "A0"
    j0.mkdir()
    place_trial(j0, "extract-elf", "A0", msha)
    md, errs = build([(j0, "A0", 1), (j2, "A2", 1)], prices, man, {})
    assert errs == [], errs
    assert "| A0 | 1 | 1 |" in md
    j1 = tmp_path / "A1"
    j1.mkdir()
    place_trial(j1, "extract-elf", "A1", msha)
    _, errs = build([(j0, "A0", 1), (j2, "A2", 1), (j1, "A1", 1)], prices, man, {})
    assert any("arm A1 is not in the frozen schedule" in e for e in errs)
    # instruction text comes from the frozen snapshot, re-verified against snapshot_sha256 first:
    # an edited snapshot is refused, never silently read
    (tmp_path / "tasks" / "extract-elf" / "instruction.md").write_text(INSTRUCTION + "changed")
    md, errs = build([(j0, "A0", 1), (j2, "A2", 1)], prices, man, {})
    assert any("extract-elf: snapshot" in e and "refusing to read its instruction.md" in e for e in errs)
    # a genuinely different ticket text (snapshot intact) is flagged on the row with no CLI flag needed
    (tmp_path / "tasks" / "extract-elf" / "instruction.md").write_text(INSTRUCTION)
    md, errs = build([(j0, "A0", 1), (j2, "A2", 1)], prices, man, {})
    assert errs == [], errs
    tk = j2 / "extract-elf__abcd1234" / "agent" / "story-live" / ".story" / "tickets" / "t-abc.json"
    tj = json.loads(tk.read_text())
    tj["description"] = tj["description"] + "changed"
    tk.write_text(json.dumps(tj))
    md, errs = build([(j0, "A0", 1), (j2, "A2", 1)], prices, man, {})
    assert "ticket-description-mismatch" in md
    # a started trial whose result.json is missing or corrupt is a build error, not a silent row
    (j2 / "extract-elf__abcd1234" / "result.json").write_text("{corrupt")
    _, errs = build([(j0, "A0", 1), (j2, "A2", 1)], prices, man, {})
    assert any("extract-elf:A2:1: started trial has no readable result.json" in e for e in errs)
    (j2 / "extract-elf__abcd1234" / "result.json").unlink()
    _, errs = build([(j0, "A0", 1), (j2, "A2", 1)], prices, man, {})
    assert any("extract-elf:A2:1: started trial has no readable result.json" in e for e in errs)


def test_build_smoke_section(tmp_path):
    man, prices = make_run(tmp_path, tasks=("extract-elf",), arms=("A0", "A1", "A2"))  # A2 is scheduled but its smoke gate has not run yet
    msha = hashlib.sha256(man.read_bytes()).hexdigest()
    j0 = tmp_path / "smoke-A0"
    j1 = tmp_path / "smoke-A1"
    j0.mkdir()
    j1.mkdir()
    place_trial(j0, "regex-log", "A0", msha)
    place_trial(j1, "regex-log", "A1", msha)
    md, errs = build([(j0, "A0", 1), (j1, "A1", 1)], prices, man, {}, section="smoke")
    assert errs == [], errs
    assert "- section: smoke (1 task: regex-log)" in md and "| regex-log | A1 | 1 | y |" in md
    j9 = tmp_path / "smoke-A9"
    j9.mkdir()
    place_trial(j9, "regex-log", "A9", msha)
    _, errs = build([(j0, "A0", 1), (j9, "A9", 1)], prices, man, {}, section="smoke")
    assert any("arm A9 is not in the frozen schedule" in e for e in errs)  # outside-schedule arms are still refused
    # the same jobs against the pilot section are refused: regex-log is not in the frame, extract-elf has no output
    _, errs = build([(j0, "A0", 1), (j1, "A1", 1)], prices, man, {})
    assert any("regex-log:A0:1: task not in the frozen manifest" in e for e in errs) and any("extract-elf:A0:1: scheduled trial has no output" in e for e in errs)


def test_build_same_basename_under_different_parents(tmp_path):
    man, prices = make_run(tmp_path, tasks=("extract-elf",))
    msha = hashlib.sha256(man.read_bytes()).hexdigest()
    j0 = tmp_path / "runs" / "A0" / "job"
    j2 = tmp_path / "runs" / "A2" / "job"
    j0.mkdir(parents=True)
    j2.mkdir(parents=True)
    place_trial(j0, "extract-elf", "A0", msha)
    place_trial(j2, "extract-elf", "A2", msha)
    md, errs = build([(j0, "A0", 1), (j2, "A2", 1)], prices, man, {})
    assert errs == [], errs
    assert "| extract-elf | A0 | 1 | y |" in md and "| extract-elf | A2 | 1 | y |" in md
    _, errs = build([(j0, "A0", 1), (j0, "A2", 1)], prices, man, {})
    assert any("given twice" in e for e in errs)


def test_build_infra_rerun_keeps_original_row_visible(tmp_path):
    man, prices = make_run(tmp_path, tasks=("extract-elf",), arms=("A1",))
    msha = hashlib.sha256(man.read_bytes()).hexdigest()
    job = tmp_path / "A1"
    rerun = tmp_path / "A1-rerun"
    job.mkdir()
    rerun.mkdir()
    t = place_trial(job, "extract-elf", "A1", msha, started=False, infra="artifact")
    shutil.rmtree(t / "agent" / "sessions")
    place_trial(rerun, "extract-elf", "A1", msha)
    md, errs = build([(job, "A1", 1), (rerun, "A1", 2)], prices, man, {})
    assert errs == [], errs
    assert "| extract-elf | A1 | 1 | n | None | artifact | not-started |" in md
    assert "| extract-elf | A1 | 2 | y | True | ok | completed |" in md
    assert "| A1 | 1 | 1 | 1.00 |" in md  # denominator 1, passes 1


def test_build_cli_exit_code(tmp_path):
    man, prices = make_run(tmp_path, tasks=("extract-elf",), arms=("A2",))
    msha = hashlib.sha256(man.read_bytes()).hexdigest()
    job = tmp_path / "A2"
    job.mkdir()
    place_trial(job, "extract-elf", "A2", msha)
    out = tmp_path / "report.md"
    r = subprocess.run([sys.executable, str(ROOT / "report" / "build_report.py"), "--job", f"A2={job}", "--prices", str(prices), "--manifest", str(man), "--out", str(out)], capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 0, r.stderr
    assert "cost/passed" in out.read_text()
    r = subprocess.run([sys.executable, str(ROOT / "report" / "build_report.py"), "--job", f"A1={job}", "--prices", str(prices), "--manifest", str(man), "--out", str(out)], capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 1 and "versions.json arm 'A2' != job arm 'A1'" in r.stderr
    r = subprocess.run([sys.executable, str(ROOT / "report" / "build_report.py"), "--job", f"A2={job}", "--prices", str(prices), "--manifest", str(man), "--out", str(out), "--annotate", "extract-elf:A2:1= "], capture_output=True, text=True, cwd=ROOT)
    assert r.returncode != 0 and "empty explanation" in r.stderr


def test_allocation_largest_remainder():
    assert allocate({"easy": 4, "medium": 55, "hard": 30}, 10) == {"easy": 1, "medium": 6, "hard": 3}
    assert allocate({"a": 1, "b": 1}, 1) == {"a": 1, "b": 0}  # tie -> stratum name ascending


def test_dir_hash_sees_mode_and_symlinks(tmp_path):
    d = tmp_path / "t"
    d.mkdir()
    f = d / "run.sh"
    f.write_text("echo hi\n")
    h0 = dir_hash(d)
    f.chmod(0o755)
    h1 = dir_hash(d)
    assert h0 != h1
    (d / "link").symlink_to("run.sh")
    h2 = dir_hash(d)
    assert h2 != h1
    (d / "link").unlink()
    (d / "link").write_text("echo hi\n")  # regular file with the same content as the symlink target
    assert dir_hash(d) != h2


def test_credential_leak_scan_refuses_collected_tokens(tmp_path):
    from report.parse import CredentialLeak, scan_credential_leak, rate_limited

    agent = tmp_path / "agent"
    (agent / "codex-home" / "sessions").mkdir(parents=True)
    (agent / "claude-code.txt").write_text('{"type":"result","total_cost_usd":0.1}\n')
    scan_credential_leak(agent)  # clean
    (agent / "codex-home" / "auth.json").write_text("{}")
    with pytest.raises(CredentialLeak, match="codex-home/auth.json"):
        scan_credential_leak(agent)
    (agent / "codex-home" / "auth.json").unlink()
    (agent / "codex-home" / "auth.json.bak").write_text("{}")
    with pytest.raises(CredentialLeak, match="auth.json.bak"):
        scan_credential_leak(agent)
    (agent / "codex-home" / "auth.json.bak").unlink()
    for needle in ("sk-ant-oat01-abc", "CLAUDE_CODE_OAUTH_TOKEN=x", '"refresh_token": "r"', '"access_token": "a"'):
        (agent / "sessions.log").write_text("noise " + needle + " noise")
        with pytest.raises(CredentialLeak, match="sessions.log"):
            scan_credential_leak(agent)
    (agent / "sessions.log").unlink()
    scan_credential_leak(tmp_path / "absent")  # nothing collected: nothing to refuse
    # archives are inspected member by member: a token inside story.tgz is a leak; a login file inside it too
    import io
    import tarfile as _tar

    def tgz(dst, members):
        with _tar.open(dst, "w:gz") as tf:
            for name, payload in members.items():
                info = _tar.TarInfo(name)
                info.size = len(payload)
                tf.addfile(info, io.BytesIO(payload))

    tgz(agent / "story.tgz", {".story/sessions/s1/state.json": b'{"v":1}'})
    scan_credential_leak(agent)
    tgz(agent / "story.tgz", {".story/sessions/s1/state.json": b'{"note":"sk-ant-oat01-inside"}'})
    with pytest.raises(CredentialLeak, match=r"story\.tgz:\.story/sessions/s1/state\.json"):
        scan_credential_leak(agent)
    tgz(agent / "story.tgz", {".story/codex/auth.json": b"{}"})
    with pytest.raises(CredentialLeak, match=r"story\.tgz:\.story/codex/auth\.json"):
        scan_credential_leak(agent)
    (agent / "story.tgz").write_bytes(b"not a tar at all")  # an archive that cannot be inspected fails closed
    with pytest.raises(CredentialLeak, match="archive not completely inspectable"):
        scan_credential_leak(agent)
    tgz(agent / "story.tgz", {".story/a.json": b"1" * 20000})
    whole = (agent / "story.tgz").read_bytes()
    (agent / "story.tgz").write_bytes(whole[: len(whole) // 2])  # truncated mid-stream: always closed, a live directory is no evidence
    (agent / "story-live").mkdir()
    with pytest.raises(CredentialLeak, match="archive not completely inspectable"):
        scan_credential_leak(agent)
    (agent / "story.tgz").unlink()
    (agent / "story.tgz.partial").write_bytes(b"\x1f\x8b\x08\x00cut")  # a cut archive build is never inspectable
    with pytest.raises(CredentialLeak, match="partial archive, not inspectable"):
        scan_credential_leak(agent)
    (agent / "story.tgz.partial").unlink()
    # whole-file scanning: a token far beyond the chunk size, and one straddling a chunk boundary, are both found
    from report.parse import SCAN_CHUNK

    (agent / "big.log").write_bytes(b"a" * (SCAN_CHUNK + 4096) + b"sk-ant-oat01-late")
    with pytest.raises(CredentialLeak, match="big.log"):
        scan_credential_leak(agent)
    (agent / "big.log").write_bytes(b"b" * (SCAN_CHUNK - 5) + b"sk-ant-oat01-straddle" + b"b" * 100)
    with pytest.raises(CredentialLeak, match="big.log"):
        scan_credential_leak(agent)
    tgz(agent / "story.tgz", {".story/big.json": b"c" * (SCAN_CHUNK - 3) + b'"refresh_token"' + b"c" * 10})
    (agent / "big.log").unlink()
    with pytest.raises(CredentialLeak, match=r"story\.tgz:\.story/big\.json"):
        scan_credential_leak(agent)
    (agent / "story.tgz").unlink()
    # an unreadable file fails closed too
    (agent / "locked.txt").write_text("x")
    (agent / "locked.txt").chmod(0)
    try:
        if os.geteuid() != 0:
            with pytest.raises(CredentialLeak, match="locked.txt \\(unreadable"):
                scan_credential_leak(agent)
    finally:
        (agent / "locked.txt").chmod(0o644)
    # rate-limit detection on the stream result event
    assert rate_limited({"is_error": True, "api_error_status": 429, "result": "x"})
    assert rate_limited({"is_error": True, "result": "You have hit your usage limit", "api_error_status": 400})
    assert rate_limited({"is_error": True, "terminal_reason": "rate_limit"})
    assert not rate_limited({"is_error": False, "result": "429 mentioned in prose"})
    assert not rate_limited({"is_error": True, "api_error_status": 401, "result": "Invalid API key"})
    assert not rate_limited(None)
