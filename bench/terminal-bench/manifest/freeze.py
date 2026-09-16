"""Execution manifest: hash the prepare manifest plus every adapter, protocol and price file
into run-manifest.json. Immutable afterwards; agents refuse to start when any hashed file
differs. The manifest's identity is the SHA-256 of the written file bytes (the same value
Manifest.sha256 computes in the container); no self-hash field is embedded.
Usage: python manifest/freeze.py <prepare-manifest.json> <run-manifest.json>"""
from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

BENCH_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BENCH_ROOT))
from agents.common import ADAPTER_FILES  # noqa: E402
from report.seed import dir_hash  # noqa: E402


def freeze(data: dict, prep_bytes: bytes, bench_root: Path = BENCH_ROOT) -> dict:
    if data.get("kind") != "prepare":
        raise SystemExit("not a prepare manifest")
    for section in ("tasks", "smoke"):
        tasks = data[section]["tasks"]
        missing = [t for t, v in tasks.items() if v.get("image") and not v.get("digest")]
        if missing:
            raise SystemExit(f"{section}: tasks without image digest (run prepare.py --pull-images): {missing}")
        tdir = Path(data[section]["dir"])
        present = sorted(p.name for p in tdir.iterdir() if p.is_dir()) if tdir.exists() else []
        if present != sorted(tasks):
            raise SystemExit(f"{section}: snapshot dir set {present} != manifest {sorted(tasks)}")
        for name, v in tasks.items():
            if dir_hash(tdir / name) != v.get("snapshot_sha256"):
                raise SystemExit(f"{section}: snapshot {name} changed since prepare")
    node = data.get("node") or {}
    if not (node.get("version") and node.get("sha256") and Path(node.get("path", "")).exists() and hashlib.sha256(Path(node["path"]).read_bytes()).hexdigest() == node["sha256"]):
        raise SystemExit("manifest needs a checksum-verified node artifact (prepare.py --node-version)")
    claude = (data.get("install") or {}).get("claude") or {}
    if not (claude.get("package_lock_sha256") and (claude.get("native") or {}).get("sha256")):
        raise SystemExit("manifest needs the locked claude install project with its native binary hash")
    for arm, proj in (data.get("install") or {}).items():
        if arm == "claude":
            continue
        pbs = proj.get("prebuilds")
        if pbs is None:
            raise SystemExit(f"install project {arm} records no prebuilds list (re-run prepare.py)")
        for pb in pbs:
            f = Path(proj["dir"]) / pb["file"]
            if not f.exists() or hashlib.sha256(f.read_bytes()).hexdigest() != pb["sha256"]:
                raise SystemExit(f"install project {arm}: prebuild {pb['file']} missing or changed since prepare")
    adapter = {rel: hashlib.sha256((bench_root / rel).read_bytes()).hexdigest() for rel in ADAPTER_FILES}
    prices_path = bench_root / "report" / "prices.json"
    prices = json.loads(prices_path.read_text())
    if not prices.get("date") or not prices.get("models"):
        raise SystemExit("report/prices.json needs a date and at least one model before freezing")
    for m, p in prices["models"].items():
        if not isinstance(p, dict) or not p.get("source"):
            raise SystemExit(f"prices.json model {m} lacks a source line")
    return {**data, "kind": "run", "frozen_at": datetime.now(timezone.utc).isoformat(),
            "prepare_manifest_sha256": hashlib.sha256(prep_bytes).hexdigest(), "adapter_files": adapter,
            "prices_date": prices["date"], "prices_sha256": adapter["report/prices.json"]}


def main(prep: Path, out: Path) -> None:
    if out.exists():
        raise SystemExit(f"{out} exists; a frozen manifest is never overwritten")
    raw = prep.read_bytes()
    frozen = freeze(json.loads(raw), raw)
    body = json.dumps(frozen, indent=2, sort_keys=True) + "\n"
    out.write_bytes(body.encode())
    print(out, hashlib.sha256(body.encode()).hexdigest())


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
