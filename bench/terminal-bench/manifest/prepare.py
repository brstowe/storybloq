"""Preparatory manifest: build artifacts, lock one install project PER ARM, snapshot tasks,
record image digests. Writes prepare-manifest.json. Nothing here is immutable yet; freeze.py is.

  python manifest/prepare.py --out /Volumes/Sharge/cpm-bench/artifacts/<date> \
      --storybloq ~/Developer/CPM/storybloq --bridge ~/Developer/codex-claude-bridge \
      --tasks-repo /path/to/terminal-bench-2 --seed-file seed/pilot-tasks.json \
      --claude-code-version 2.1.267 --codex-version 0.153.4 --node-version 22.23.2 --executor-model claude-sonnet-5 \
      --reviewer-model gpt-6-astra [--pull-images] [--allow-dirty]

`--out` must not exist yet: the snapshot is built fresh so no task from an earlier draw can
linger under tasks/ and be run by harbor's --path without being in the manifest.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path

BENCH_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BENCH_ROOT))
from agents.storybloq_auto import ARM_ARTIFACTS  # noqa: E402
from report.seed import SMOKE_TASKS, dir_hash  # noqa: E402

EXACT_VERSION = re.compile(r"^\d+\.\d+\.\d+$")

# ISS-1200: regex-log's task.toml caps [agent] timeout_sec at 900s (harbor's own
# agent_timeout_multiplier field, applied to that per-task value); a real storybloq-arm smoke
# trial (r17) ran 1027.8s to a clean, completed finish and still tripped harbor's AgentTimeoutError.
# A0 does no guide/review workflow and never approached the cap, so it keeps the harbor default.
# A1-A4 get 2.5x (2250s) = 2x the r17 wall, rounded up, so the cap is not binding for them. Every
# other timeout knob (verifier, agent setup, environment build) stays at the harbor default (1.0)
# for every arm -- this multiplier maps to harbor JobConfig's agent_timeout_multiplier field only.
AGENT_TIMEOUT_MULTIPLIER = {"A0": 1.0, "A1": 2.5, "A2": 2.5, "A3": 2.5, "A4": 2.5}
AGENT_TIMEOUT_MULTIPLIER_NOTE = (
    "Maps to harbor JobConfig's agent_timeout_multiplier field only (the [agent] timeout_sec cap "
    "in each task's task.toml). timeout_multiplier (verifier default), verifier_timeout_multiplier, "
    "agent_setup_timeout_multiplier and environment_build_timeout_multiplier all stay at harbor's "
    "own default (1.0) for every arm. A1-A4 (2.5x = 2250s) = 2x the r17 regex-log smoke wall of "
    "1027.8s, rounded up (ISS-1200); A0 (1.0x = 900s) unchanged."
)


def sh(cmd: list[str], cwd: Path | None = None) -> str:
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"{' '.join(cmd)} failed: {r.stderr[-500:]}")
    return r.stdout.strip()


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def pack(repo: Path, out: Path, name: str, allow_dirty: bool) -> dict:
    commit = sh(["git", "rev-parse", "HEAD"], repo)
    dirty = bool(sh(["git", "status", "--porcelain"], repo))
    if dirty and not allow_dirty:
        raise SystemExit(f"{repo} is dirty; pass --allow-dirty to record it")
    sh(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], repo)
    sh(["npm", "run", "build", "--if-present"], repo)
    tgz_name = sh(["npm", "pack", "--pack-destination", str(out)], repo).splitlines()[-1]
    target = out / f"{name}.tgz"
    shutil.move(out / tgz_name, target)
    files: dict[str, str] = {}
    with tarfile.open(target, "r:gz") as tf:
        for m in tf.getmembers():
            if m.isfile() and m.name.startswith("package/"):
                fh = tf.extractfile(m)
                files[m.name[len("package/"):]] = hashlib.sha256(fh.read()).hexdigest() if fh else ""
    pkg = json.loads((repo / "package.json").read_text())
    entry = {"path": str(target), "sha256": sha256(target), "version": pkg["version"], "package": pkg["name"], "commit": commit, "dirty": dirty, "files": files}
    if name == "storybloq":
        entry["skill_sha256"] = files.get("src/skill/SKILL.md")
    return entry


def fetch_node(out: Path, version: str) -> dict:
    """Checksum-verified Node runtime tarball (linux-x64: the task images are amd64 only)."""
    import urllib.request

    if not EXACT_VERSION.match(version):
        raise SystemExit("--node-version must be an exact x.y.z")
    d = out / "node"
    d.mkdir()
    name = f"node-v{version}-linux-x64.tar.gz"
    base = f"https://nodejs.org/dist/v{version}/"
    urllib.request.urlretrieve(base + name, d / name)
    sums = urllib.request.urlopen(base + "SHASUMS256.txt").read().decode()
    expected = next((line.split()[0] for line in sums.splitlines() if line.split()[-1] == name), None)
    if not expected:
        raise SystemExit(f"{name} not in SHASUMS256.txt")
    got = sha256(d / name)
    if got != expected:
        raise SystemExit(f"node tarball sha {got[:12]} != published {expected[:12]}")
    return {"version": version, "arch": "linux-x64", "path": str(d / name), "sha256": got, "source": base + name}


def lock_claude_project(out: Path, claude_version: str) -> dict:
    """Locked install project for Claude Code itself; npm ci in the container pins every byte."""
    proj = out / "install" / "claude"
    proj.mkdir(parents=True)
    (proj / "package.json").write_text(json.dumps({"name": "storybloq-bench-claude", "private": True, "dependencies": {"@anthropic-ai/claude-code": claude_version}}, indent=2) + "\n")
    sh(["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], proj)
    lock = json.loads((proj / "package-lock.json").read_text())
    got = ((lock.get("packages") or {}).get("node_modules/@anthropic-ai/claude-code") or {}).get("version")
    if got != claude_version:
        raise SystemExit(f"lockfile resolved @anthropic-ai/claude-code {got!r}, expected {claude_version!r}")
    native = lock_native_binary(proj, lock, claude_version)
    return {"dir": str(proj), "package_json_sha256": sha256(proj / "package.json"), "package_lock_sha256": sha256(proj / "package-lock.json"), "native": native}


NATIVE_PACKAGE = "@anthropic-ai/claude-code-linux-x64"  # the task images are linux/amd64, glibc


def lock_native_binary(proj: Path, lock: dict, claude_version: str) -> dict:
    """Claude Code's postinstall only hardlinks the platform package's binary into place; the adapter
    never runs it (npm ci --ignore-scripts). Record that binary's hash so the container can verify
    the installed file and link it directly. The tarball is checked against the lock's integrity."""
    import base64
    import tempfile

    entry = (lock.get("packages") or {}).get(f"node_modules/{NATIVE_PACKAGE}") or {}
    integrity = entry.get("integrity", "")
    if entry.get("version") != claude_version or not integrity.startswith("sha512-"):
        raise SystemExit(f"lockfile lacks {NATIVE_PACKAGE}@{claude_version} with a sha512 integrity")
    with tempfile.TemporaryDirectory(dir=proj) as td:
        tgz_name = sh(["npm", "pack", f"{NATIVE_PACKAGE}@{claude_version}", "--ignore-scripts", "--pack-destination", td], proj).splitlines()[-1]
        tgz = Path(td) / tgz_name
        got = base64.b64encode(hashlib.sha512(tgz.read_bytes()).digest()).decode()
        if got != integrity[len("sha512-"):]:
            raise SystemExit(f"{NATIVE_PACKAGE} tarball integrity differs from the lockfile")
        with tarfile.open(tgz, "r:gz") as tf:
            f = tf.extractfile("package/claude")
            if f is None:
                raise SystemExit(f"{NATIVE_PACKAGE} tarball has no package/claude")
            digest = hashlib.sha256(f.read()).hexdigest()
    return {"package": NATIVE_PACKAGE, "file": "claude", "sha256": digest, "tarball_integrity": integrity}


NODE_ABI = {"22": "127", "20": "115", "24": "137"}  # Node major -> module ABI (process.versions.modules)

# Packages whose npm install script builds or downloads a native addon. npm ci runs with
# --ignore-scripts in the container, so the addon is pinned here instead: the published prebuild
# for the exact version, Node ABI and linux-x64 is downloaded at prepare time, hashed into the
# manifest and extracted into the package directory in the container. Any other package with an
# install script is refused.
PREBUILD_RECIPES = {
    "better-sqlite3": lambda version, abi: (f"https://github.com/WiseLibs/better-sqlite3/releases/download/v{version}/better-sqlite3-v{version}-node-v{abi}-linux-x64.tar.gz", "build/Release/better_sqlite3.node"),
}


def pin_prebuilds(proj: Path, lock: dict, node_version: str) -> list[dict]:
    import urllib.request

    major = node_version.split(".")[0]
    abi = NODE_ABI.get(major)
    if not abi:
        raise SystemExit(f"no known module ABI for Node {node_version}; extend NODE_ABI")
    out: list[dict] = []
    for key, entry in (lock.get("packages") or {}).items():
        if not entry.get("hasInstallScript"):
            continue
        pkg = key.rsplit("node_modules/", 1)[-1]
        parts = key.split("/")
        if not key.startswith("node_modules/") or any(seg in ("", ".", "..") for seg in parts) or parts[-1] != pkg or pkg in PREBUILD_RECIPES and parts[-2] != "node_modules":
            raise SystemExit(f"lock key {key!r} is not an in-project node_modules path; refusing")
        recipe = PREBUILD_RECIPES.get(pkg)
        if not recipe:
            raise SystemExit(f"{key}@{entry.get('version')} has an install script and no pinned prebuild recipe; refusing (scripts never run in the container)")
        url, member = recipe(entry["version"], abi)
        d = proj / "prebuilds"
        d.mkdir(exist_ok=True)
        fname = f"{pkg}-v{entry['version']}-node-v{abi}-linux-x64.tar.gz"
        if (d / fname).exists() and any(o["file"] == f"prebuilds/{fname}" for o in out):
            pass  # same version pinned at two lock paths shares one tarball
        else:
            urllib.request.urlretrieve(url, d / fname)
        with tarfile.open(d / fname, "r:gz") as tf:
            names = tf.getnames()
        if member not in names:
            raise SystemExit(f"{fname} lacks {member}: {names}")
        # path: the lockfile key, i.e. where npm ci places this copy relative to the project root;
        # nested copies and several locked versions each get their own binding.
        out.append({"package": pkg, "version": entry["version"], "path": key, "abi": abi, "arch": "linux-x64", "url": url, "file": f"prebuilds/{fname}", "sha256": sha256(d / fname), "member": member})
    return out


def lock_install_projects(out: Path, artifacts: dict, codex_version: str | None, arms: list[str], node_version: str = "") -> dict:
    """One locked project per TREATMENT arm holding exactly that arm's dependencies and tarballs.
    A0 is scheduled but installs nothing (harbor's own Claude Code agent only)."""
    projects = {}
    for arm in arms:
        if arm == "A0":
            continue
        if arm not in ARM_ARTIFACTS:
            raise SystemExit(f"unknown arm {arm}")
        needed = ARM_ARTIFACTS[arm]
        missing = [n for n in needed if n not in artifacts]
        if missing:
            raise SystemExit(f"arm {arm} needs artifacts {missing}; pass --bridge/--lenses")
        deps = {artifacts[n]["package"]: f"file:./{n}.tgz" for n in needed}
        if "bridge" in needed:
            if not codex_version or not EXACT_VERSION.match(codex_version):
                raise SystemExit("--codex-version must be an exact x.y.z when bridge artifacts are requested (no tags, no ranges, never latest)")
            deps["@openai/codex"] = codex_version
        proj = out / "install" / arm
        proj.mkdir(parents=True)
        (proj / "package.json").write_text(json.dumps({"name": f"storybloq-bench-install-{arm.lower()}", "private": True, "dependencies": deps}, indent=2) + "\n")
        for n in needed:
            shutil.copy(artifacts[n]["path"], proj / f"{n}.tgz")
        sh(["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], proj)
        lock = json.loads((proj / "package-lock.json").read_text())
        if "bridge" in needed:
            got = ((lock.get("packages") or {}).get("node_modules/@openai/codex") or {}).get("version")
            if got != codex_version:
                raise SystemExit(f"lockfile resolved @openai/codex {got!r}, expected {codex_version!r}")
        projects[arm] = {
            "dir": str(proj), "package_json_sha256": sha256(proj / "package.json"), "package_lock_sha256": sha256(proj / "package-lock.json"),
            "tarballs": {n: f"{n}.tgz" for n in needed}, "prebuilds": pin_prebuilds(proj, lock, node_version),
        }
    return projects


def _snapshot_one(tasks_repo: Path, commit: str, name: str, dest: Path, pull: bool) -> dict:
    """Materialise the task from the recorded COMMIT (git archive), never from the working tree."""
    if subprocess.run(["git", "cat-file", "-e", f"{commit}:{name}/task.toml"], cwd=tasks_repo, capture_output=True).returncode != 0:
        raise SystemExit(f"task {name} not in {tasks_repo} at {commit[:12]}")
    d = dest / name
    d.mkdir()
    ar = subprocess.run(["git", "archive", "--format=tar", commit, name], cwd=tasks_repo, capture_output=True)
    if ar.returncode != 0:
        raise SystemExit(f"git archive {name} failed: {ar.stderr[-300:]!r}")
    with tarfile.open(fileobj=__import__("io").BytesIO(ar.stdout), mode="r:") as tf:
        for m in tf.getmembers():
            m.name = m.name[len(name) + 1:] if m.name.startswith(name + "/") else ""
            if m.name:
                tf.extract(m, d, filter="data")  # refuses absolute paths, parent escapes and symlinks that leave the task dir
    toml = d / "task.toml"
    text = toml.read_text()
    image = None
    for line in text.splitlines():
        if line.strip().startswith("docker_image"):
            image = line.split("=", 1)[1].strip().strip('"')
    digest = None
    if image and pull:
        sh(["docker", "pull", image])
        digest = sh(["docker", "inspect", "--format", "{{index .RepoDigests 0}}", image])
        toml.write_text(text.replace(f'"{image}"', f'"{digest}"'))
    return {"image": image, "digest": digest, "task_toml_sha256": sha256(toml), "snapshot_sha256": dir_hash(d)}


def snapshot_smoke(tasks_repo: Path, out: Path, pull: bool) -> dict:
    """The smoke task(s) get the same digest pinning in their own directory; never part of the pilot frame."""
    commit = sh(["git", "rev-parse", "HEAD"], tasks_repo)
    dest = out / "tasks-smoke"
    dest.mkdir()
    return {"repo_commit": commit, "tasks": {name: _snapshot_one(tasks_repo, commit, name, dest, pull) for name in SMOKE_TASKS}, "dir": str(dest)}


def snapshot_tasks(tasks_repo: Path, seed_file: Path, out: Path, pull: bool) -> dict:
    seed = json.loads(seed_file.read_text())
    if sh(["git", "status", "--porcelain", "--untracked-files=all"], tasks_repo):
        raise SystemExit(f"{tasks_repo} has uncommitted or untracked content; the snapshot must come from a clean commit")
    commit = sh(["git", "rev-parse", "HEAD"], tasks_repo)
    dest = out / "tasks"
    dest.mkdir()
    recorded = {}
    for t in seed["tasks"]:
        if t["name"] in SMOKE_TASKS:
            raise SystemExit(f"smoke task {t['name']} in the pilot seed")
        blob = subprocess.run(["git", "show", f"{commit}:{t['name']}/task.toml"], cwd=tasks_repo, capture_output=True)
        if blob.returncode != 0:
            raise SystemExit(f"task {t['name']} not in {tasks_repo} at {commit[:12]}")
        h = hashlib.sha256(blob.stdout).hexdigest()
        if h != t["task_toml_sha256"]:
            raise SystemExit(f"task {t['name']} task.toml hash {h[:12]} != seed {t['task_toml_sha256'][:12]}")
        recorded[t["name"]] = _snapshot_one(tasks_repo, commit, t["name"], dest, pull)
    present = sorted(p.name for p in dest.iterdir() if p.is_dir())
    if present != sorted(recorded):
        raise SystemExit(f"snapshot dir set {present} != recorded {sorted(recorded)}")
    return {"repo_commit": commit, "seed_file_sha256": sha256(seed_file), "tasks": recorded, "dir": str(dest)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--storybloq", required=True)
    ap.add_argument("--bridge")
    ap.add_argument("--lenses")
    ap.add_argument("--tasks-repo", required=True)
    ap.add_argument("--seed-file", default=str(BENCH_ROOT / "seed" / "pilot-tasks.json"))
    ap.add_argument("--arms", default="A0,A1,A2", help="arms in the frozen schedule (A0 installs nothing)")
    ap.add_argument("--claude-code-version", required=True)
    ap.add_argument("--codex-version")
    ap.add_argument("--node-version", required=True, help="exact Node runtime version installed in every container (linux-x64 tarball, checksum-verified)")
    ap.add_argument("--executor-model", required=True)
    ap.add_argument("--reviewer-model")
    ap.add_argument("--reviewer-effort", default="medium")
    ap.add_argument("--pull-images", action="store_true")
    ap.add_argument("--allow-dirty", action="store_true")
    a = ap.parse_args()
    if not EXACT_VERSION.match(a.claude_code_version):
        raise SystemExit("--claude-code-version must be an exact x.y.z")
    if a.bridge and not a.codex_version:
        raise SystemExit("--bridge requires --codex-version (exact x.y.z)")
    out = Path(a.out).expanduser().resolve()
    if out.exists():
        raise SystemExit(f"{out} exists; prepare into a fresh directory")
    out.mkdir(parents=True)
    arms = [s.strip() for s in a.arms.split(",") if s.strip()]
    unknown = [arm for arm in arms if arm not in AGENT_TIMEOUT_MULTIPLIER]
    if unknown:
        raise SystemExit(f"no agent_timeout_multiplier recorded for arm(s) {unknown}")
    artifacts = {"storybloq": pack(Path(a.storybloq).expanduser(), out, "storybloq", a.allow_dirty)}
    if a.bridge:
        artifacts["bridge"] = pack(Path(a.bridge).expanduser(), out, "bridge", a.allow_dirty)
    if a.lenses:
        artifacts["lenses"] = pack(Path(a.lenses).expanduser(), out, "lenses", a.allow_dirty)
    install = lock_install_projects(out, artifacts, a.codex_version, arms, a.node_version)
    install["claude"] = lock_claude_project(out, a.claude_code_version)
    node = fetch_node(out, a.node_version)
    tasks = snapshot_tasks(Path(a.tasks_repo).expanduser(), Path(a.seed_file), out, a.pull_images)
    smoke = snapshot_smoke(Path(a.tasks_repo).expanduser(), out, a.pull_images)
    harbor_version = sh([sys.executable, "-c", "import importlib.metadata as m; print(m.version('harbor'))"])
    manifest = {
        "kind": "prepare", "date": datetime.now(timezone.utc).isoformat(), "harbor_version": harbor_version,
        "storybloq_commit": artifacts["storybloq"]["commit"], "storybloq_dirty": artifacts["storybloq"]["dirty"],
        "skill_sha256": artifacts["storybloq"]["skill_sha256"], "artifacts": artifacts, "install": install, "node": node, "arms": arms,
        "dataset": "terminal-bench@2.0", "task_repo_commit": tasks["repo_commit"], "tasks": tasks, "smoke": smoke,
        "claude_code_version": a.claude_code_version, "codex_version": a.codex_version,
        "executor_model": a.executor_model, "reviewer_model": a.reviewer_model, "reviewer_effort": a.reviewer_effort,
        "protocol": {
            "max_turns": None, "max_budget_usd": None,
            "agent_timeout_multiplier": {arm: AGENT_TIMEOUT_MULTIPLIER[arm] for arm in arms},
            "agent_timeout_multiplier_harbor_field": "agent_timeout_multiplier",
            "agent_timeout_multiplier_note": AGENT_TIMEOUT_MULTIPLIER_NOTE,
            "attempts": 1, "retries": 0, "n_concurrent": 1, "reruns": "one rerun of a pre-start infra failure only",
        },
        "storage": {"ssd_root": str(out.parent)},
    }
    (out / "prepare-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(out / "prepare-manifest.json")


if __name__ == "__main__":
    main()
