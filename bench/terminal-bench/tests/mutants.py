"""Executable mutant runner for report/parse.py.

Baseline first: the named tests must PASS on the original source. For each mutant: apply the
textual patch, run the named test, require a collected test FAILURE (pytest summary "N failed";
a collection error or an internal error is reported as INFRA, not as a kill), revert, and
check the file hash is byte-identical to the original. Exit non-zero if any mutant survives,
any run is infra, or the file is not restored. Usage: python tests/mutants.py [mutant ...]
"""
from __future__ import annotations

import hashlib
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "report" / "parse.py"

MUTANTS: dict[str, tuple[str, list[tuple[str, str]]]] = {
    # name: (test node id, [(old, new), ...])
    "m1_sum_input_only": (
        "tests/test_parse.py::test_claude_per_model_sums_last_usage_per_unit",
        [('        for k in self.FIELDS:\n            setattr', '        for k in ("input",):\n            setattr')],
    ),
    "m2a_first_usage_per_unit": (
        "tests/test_parse.py::test_claude_per_model_sums_last_usage_per_unit",
        [("            last_by_unit[(rel, mid)] = (model, usage)", "            last_by_unit.setdefault((rel, mid), (model, usage))")],
    ),
    "m2b_first_main_usage_as_context": (
        "tests/test_parse.py::test_claude_context_is_last_main_usage",
        [("                last_main_usage = usage", "                last_main_usage = last_main_usage or usage")],
    ),
    "m3_collapse_models": (
        "tests/test_parse.py::test_claude_subagent_model_is_separate_and_recursive",
        [('            model = msg.get("model") if isinstance(msg.get("model"), str) else None', '            model = "all"')],
    ),
    "m4_non_recursive_glob": (
        "tests/test_parse.py::test_claude_subagent_model_is_separate_and_recursive",
        [('projects.rglob("*.jsonl")', 'projects.glob("*/*.jsonl")')],
    ),
    "m5_count_repeated_response": (
        "tests/test_parse.py::test_codex_per_response_units_join_turn_model",
        [("                if (tid, rid) in seen:", "                if False:")],
    ),
    "m6_bill_cached_input_again": (
        "tests/test_parse.py::test_cost_openai_subtracts_cached_input",
        [('(u["input"] - u["cached_input"]) * p["input"]', 'u["input"] * p["input"]')],
    ),
    "m7_second_model_turn_to_first": (
        "tests/test_parse.py::test_codex_per_response_units_join_turn_model",
        [("                model = turn_model.get(tid)", "                model = next(iter(turn_model.values()), None)")],
    ),
    "m8_cumulative_token_count_as_usage": (
        "tests/test_parse.py::test_codex_per_response_units_join_turn_model",
        [('            p = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}',
          '            p = rec.get("payload") if isinstance(rec.get("payload"), dict) else {"turn_id": "t1", "response_id": "tc", "usage": (rec.get("info") or {}).get("total_token_usage")}'),
         ('            elif t == "token_usage_record":', '            elif t in ("token_usage_record", "token_count"):')],
    ),
    "m9_duplicate_conflict_summed": (
        "tests/test_parse.py::test_claude_duplicate_id_copy_counts_once_conflict_is_incomplete",
        [('                out.diagnostics.append(f"duplicate-id-conflict:{mid}:{files_s}")\n                out.coverage = "incomplete"',
          '                out.diagnostics.append(f"duplicate-id-conflict:{mid}:{files_s}")')],
    ),
    "m10_infra_from_exception_text": (
        "tests/test_parse.py::test_trial_row_infra_only_from_pre_start_marker",
        [("    if isinstance(infra, dict) and not started:", '    if (isinstance(infra, dict) and not started) or (exc and "infra:" in str(exc.get("exception_message"))):\n        infra = infra if isinstance(infra, dict) else {"reason": "artifact"}')],
    ),
}


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def pytest_outcome(test: str) -> tuple[str, str]:
    r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", test], cwd=ROOT, capture_output=True, text=True)
    tail = r.stdout[-1500:] + r.stderr[-500:]
    summary = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ""
    if r.returncode == 0 and re.search(r"\d+ passed", summary):
        return "passed", tail
    if r.returncode == 1 and re.search(r"\d+ failed", summary) and "error" not in summary:
        return "failed", tail
    return "infra", tail


def run(names: list[str]) -> int:
    original = TARGET.read_bytes()
    base = sha(TARGET)
    failures = 0
    for test in sorted({MUTANTS[n][0] for n in names}):
        outcome, tail = pytest_outcome(test)
        if outcome != "passed":
            print(f"BASELINE {test}: {outcome}\n{tail}")
            return 2
    for name in names:
        test, patches = MUTANTS[name]
        text = original.decode()
        for old, new in patches:
            if text.count(old) != 1:
                print(f"{name}: patch anchor not unique/found ({text.count(old)}): {old[:70]!r}")
                return 2
            text = text.replace(old, new)
        TARGET.write_bytes(text.encode())
        try:
            outcome, tail = pytest_outcome(test)
        finally:
            TARGET.write_bytes(original)
        restored = sha(TARGET) == base
        label = {"failed": "KILLED", "passed": "SURVIVED", "infra": "INFRA"}[outcome]
        print(f"{name}: {label}; restored={restored}")
        if outcome != "failed" or not restored:
            failures += 1
            print(tail)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:] or list(MUTANTS)))
