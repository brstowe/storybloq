"""Frozen pilot sampling over Terminal-Bench 2.0 task metadata.

The smoke task(s) are removed from the frame before stratification. Stratify by
metadata.difficulty, allocate proportionally with largest remainder (ties by stratum name
ascending), draw within each stratum with random.Random(seed) over the sorted task names,
and write the sorted list with each task's task.toml hash (prepare.py verifies it against the
full checkout and records the whole snapshot directory's hash).
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import sys
from pathlib import Path

import tomli

SMOKE_TASKS = ("regex-log",)


def allocate(counts: dict[str, int], n: int) -> dict[str, int]:
    total = sum(counts.values())
    quotas = {k: n * v / total for k, v in counts.items()}
    floors = {k: int(q) for k, q in quotas.items()}
    remaining = n - sum(floors.values())
    order = sorted(counts, key=lambda k: (-(quotas[k] - floors[k]), k))
    for k in order[:remaining]:
        floors[k] += 1
    return floors


def dir_hash(d: Path) -> str:
    """Path, entry type, executable bit and content (or symlink target) of every entry."""
    h = hashlib.sha256()
    entries = sorted(d.rglob("*"), key=lambda p: str(p.relative_to(d)))
    for p in entries:
        rel = str(p.relative_to(d)).encode()
        st = os.lstat(p)
        if p.is_symlink():
            h.update(b"L\0" + rel + b"\0" + os.readlink(p).encode() + b"\0")
        elif p.is_dir():
            h.update(b"D\0" + rel + b"\0")
        elif p.is_file():
            x = b"x" if st.st_mode & 0o111 else b"-"
            h.update(b"F\0" + rel + b"\0" + x + b"\0" + p.read_bytes() + b"\0")
        else:
            raise ValueError(f"unsupported entry type: {p}")
    return h.hexdigest()


def draw(tasks_root: Path, n: int, seed: int) -> dict:
    tasks = {}
    excluded = []
    for t in sorted(p for p in tasks_root.iterdir() if (p / "task.toml").exists()):
        if t.name in SMOKE_TASKS:
            excluded.append(t.name)
            continue
        meta = tomli.loads((t / "task.toml").read_text())
        tasks[t.name] = str(meta.get("metadata", {}).get("difficulty", "unknown"))
    strata: dict[str, list[str]] = {}
    for name, d in tasks.items():
        strata.setdefault(d, []).append(name)
    counts = {k: len(v) for k, v in strata.items()}
    alloc = allocate(counts, n)
    rng = random.Random(seed)
    chosen = []
    for k in sorted(strata):
        chosen += rng.sample(sorted(strata[k]), alloc[k])
    chosen.sort()
    return {
        "dataset": "terminal-bench@2.0",
        "seed": seed,
        "n": n,
        "rule": "exclude smoke tasks; stratify by metadata.difficulty; largest-remainder proportional allocation, ties by stratum name ascending; random.Random(seed).sample over sorted names per stratum in stratum-name order",
        "excluded": excluded,
        "strata": counts,
        "allocation": alloc,
        "smoke_tasks": list(SMOKE_TASKS),
        "tasks": [{"name": c, "difficulty": tasks[c], "task_toml_sha256": hashlib.sha256((tasks_root / c / "task.toml").read_bytes()).hexdigest()} for c in chosen],
    }


if __name__ == "__main__":
    root = Path(sys.argv[1])
    out = Path(sys.argv[2])
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 10
    seed = int(sys.argv[4]) if len(sys.argv) > 4 else 500
    out.write_text(json.dumps(draw(root, n, seed), indent=2) + "\n")
    print(out)
