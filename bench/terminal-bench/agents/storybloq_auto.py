"""Arms A1..A4: Claude Code driving `/story auto <ticket>` with storybloq installed from the
manifest's local tarballs. See plan-t500.md for the contract each step honours."""
from __future__ import annotations

import asyncio
import json
import shlex
from pathlib import Path, PurePosixPath
from typing import Any

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from agents.baseline import BENCH_ROOT
from agents.common import (
    InfraError,
    Manifest,
    Shell,
    assert_effective_config,
    bounded_cleanup,
    capture_base_env,
    capture_workdir,
    AUTH_MODE,
    check_env_allowlist,
    validate_codex_auth,
    check_pins,
    ensure_clean_home,
    check_home_after_install,
    install_claude_from_artifacts,
    parse_semver,
    preflight_task_state,
    record_infra_failure,
    record_pre_start_cancellation,
    record_started,
    run_bounded,
    sha256_file,
    write_file_command,
)

# A1-A4's own instruction suffix, distinct from agents/instruction.txt (A0's, byte-identical,
# untouched). ISS-1198: the shared "Do not ask questions; there is no user" framing was found to
# be a plausible cause of the guide never being invoked -- a local repro with a milder suffix,
# otherwise identical conditions (model, skill, MCP, a clean session_guard verdict), DID invoke
# storybloq_autonomous_guide, while the real smoke trials with the shared suffix never did. This
# suffix stays honest (there really is no human) but names the expected workflow explicitly and
# tells the model how to proceed past a would-be question, instead of only telling it to stop
# asking -- adapter-side per the accepted ruling, since A0's needs (just solve it, no workflow)
# and A1-A4's (invoke the guide) have diverged.
AUTO_INSTRUCTION_SUFFIX = (BENCH_ROOT / "agents" / "instruction-auto.txt").read_text(encoding="utf-8").strip()


def render_auto_instruction(instruction: str) -> str:
    """Task text byte for byte, then a blank line and the A1-A4 suffix. Nothing stripped."""
    return f"{instruction}\n\n{AUTO_INSTRUCTION_SUFFIX}\n"

ARM_OVERRIDES = {
    "A1": {"reviewBackends": ["agent"], "maxTicketsPerSession": 1},
    "A2": {"reviewBackends": ["codex"], "maxTicketsPerSession": 1},
    "A3": {"reviewBackends": ["lenses"], "maxTicketsPerSession": 1},
    "A4": {"reviewBackends": ["codex", "lenses"], "maxTicketsPerSession": 1},
}
ARM_ARTIFACTS = {"A1": ("storybloq",), "A2": ("storybloq", "bridge"), "A3": ("storybloq", "lenses"), "A4": ("storybloq", "bridge", "lenses")}
PACKAGE_OF = {"storybloq": "@storybloq/storybloq", "bridge": "codex-claude-bridge", "lenses": "@storybloq/lenses"}
REMOTE = PurePosixPath("/opt/bench")
NODE = "/opt/node/bin/node"
# Per package: a Node one-liner that exercises the native binding, printing "ok" on success.
PREBUILD_PROBES = {
    "better-sqlite3": lambda d: f'const D=require({json.dumps(d)});const db=new D(":memory:");if(db.prepare("SELECT 1 AS one").get().one!==1)throw new Error("bad row");db.close();console.log("ok")',
}
CODEX_HOME_REMOTE = "/opt/bench/codex-home"
  # login file and rollouts live here; only sessions/ is copied out for collection  # the pinned runtime the adapter installs; task images need not ship python
GATE_POLL_SECONDS = 5
GATE_POLL_ROUNDS = 120
BIN = REMOTE / "node_modules" / ".bin"


class StorybloqAuto(ClaudeCode):
    @staticmethod
    def name() -> str:
        return "storybloq-auto"

    def __init__(self, logs_dir: Path, manifest: str | None = None, arm: str = "", gate_cancel_after_start: bool = False, codex_auth: str | None = None, *args: Any, **kwargs: Any):
        super().__init__(logs_dir, *args, **kwargs)
        if arm not in ARM_OVERRIDES:
            raise InfraError("manifest", f"unknown arm {arm!r}")
        self.arm = arm
        self.manifest = Manifest.load(manifest, BENCH_ROOT)
        check_pins(self.manifest, arm=arm, claude_version_kwarg=self._version, model_name=self.model_name)
        self.gate_cancel_after_start = bool(gate_cancel_after_start) and str(gate_cancel_after_start).lower() != "false"
        check_env_allowlist(self.extra_env, arm)
        self.codex_auth: Path | None = validate_codex_auth(codex_auth) if self.uses_codex() else None
        self.workdir: str | None = None
        self.ticket_id: str | None = None
        self.runtime_env: dict[str, str] = {}
        self._versions: dict[str, Any] = {}
        self._created: set[str] = set()  # resources that need cleanup: "story", "copier"
        self._git_version: str | None = None

    # ----- helpers -----------------------------------------------------------------
    def _shell(self, environment: BaseEnvironment) -> Shell:
        return Shell(lambda **kw: self.exec_as_agent(environment, kw["command"], env=kw.get("env"), timeout_sec=kw.get("timeout_sec")))

    def _config_dir(self) -> str:
        return (self.environment_logs_dir / "sessions").as_posix()

    def uses_codex(self) -> bool:
        return self.arm in ("A2", "A4")

    def _artifacts(self) -> tuple[str, ...]:
        return ARM_ARTIFACTS[self.arm]

    async def _resolve_runtime_env(self, sh: Shell) -> dict[str, str]:
        """Real values only: HOME and PATH are read from the container, never `$` references."""
        base = await capture_base_env(sh)
        env = {"CLAUDE_CONFIG_DIR": self._config_dir(), "PATH": f"{BIN}:{base['HOME']}/.local/bin:{base['PATH']}"}
        if self.uses_codex():
            env["RB_CONFIG_PATH"] = (REMOTE / "reviewbridge.json").as_posix()
            env["CODEX_HOME"] = CODEX_HOME_REMOTE  # outside /logs/agent: the login file is never in harbor's collection tree
        return env

    # ----- install -----------------------------------------------------------------
    async def install(self, environment: BaseEnvironment) -> None:
        sh = self._shell(environment)
        try:
            await ensure_clean_home(sh)  # before any install: the image carries no user state
            self._install_versions = await install_claude_from_artifacts(sh, environment, lambda cmd: self.exec_as_root(environment, cmd), self.manifest)
            await super().install(environment)  # finds the pinned claude and skips its bootstrap
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            await run_bounded(record_infra_failure(sh, self.environment_logs_dir, exc), 15)
            raise
        try:
            await self._install_bench(environment, sh)
            self._versions["home_after_install"] = await check_home_after_install(sh, allow_storybloq_settings=True, program="storybloq")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001  any install failure is pre-start; the container is up so the marker lands in /logs/agent
            await run_bounded(record_infra_failure(sh, self.environment_logs_dir, exc), 15)
            raise

    async def _install_bench(self, environment: BaseEnvironment, sh: Shell) -> None:
        inst = self.manifest.install_project(self.arm)
        local_dir = Path(inst["dir"])
        for fname, key in (("package.json", "package_json_sha256"), ("package-lock.json", "package_lock_sha256")):
            if sha256_file(local_dir / fname) != inst.get(key):
                raise InfraError("manifest", f"{self.arm} install/{fname} differs from the frozen manifest")
        await self.exec_as_root(environment, f"mkdir -p {REMOTE} && chmod 0777 {REMOTE}")
        # git is a prerequisite of the A1-A4 environment, not the model's job: the guide's
        # workflow needs a repo to review against, and a task image is not guaranteed to ship
        # one. Installing it here keeps that cost off the trial (ISS-1198 follow-up finding: a
        # real smoke trial paid an extra apt-get round-trip to install git itself before the
        # guide could start, a nondeterministic cost A0 never pays and that a less resourceful
        # model might not think to pay at all, turning an environment gap into a false gate
        # failure). Idempotent: a no-op when the image already has git.
        await self.exec_as_root(environment, "command -v git >/dev/null 2>&1 || (apt-get update && apt-get install -y --no-install-recommends git)")
        r = await self.exec_as_root(environment, "git --version")
        self._git_version = r.stdout.strip()
        uploads: list[tuple[Path, str, str]] = [(local_dir / "package.json", f"{REMOTE}/package.json", inst["package_json_sha256"]),
                                              (local_dir / "package-lock.json", f"{REMOTE}/package-lock.json", inst["package_lock_sha256"])]
        for name in self._artifacts():
            art = self.manifest.artifact(name)
            if name not in (inst.get("tarballs") or {}):
                raise InfraError("manifest", f"{self.arm} install project lacks tarball {name}")
            uploads.append((Path(art["path"]), f"{REMOTE}/{inst['tarballs'][name]}", art["sha256"]))
        for local, remote, digest in uploads:
            if not local.exists() or sha256_file(local) != digest:
                raise InfraError("artifact", f"{local} missing or differs from manifest")
            await environment.upload_file(local, remote)
            r = await sh.must(f"sha256sum {shlex.quote(remote)} | cut -d' ' -f1", "artifact")
            if r.stdout.strip() != digest:
                raise InfraError("artifact", f"uploaded {remote} sha {r.stdout.strip()[:12]} != {digest[:12]}")
        prebuilds = inst.get("prebuilds")
        if prebuilds is None:
            raise InfraError("manifest", f"{self.arm} install project records no prebuilds list (re-run prepare.py)")
        r = await sh.run(f"cd {REMOTE} && npm ci --ignore-scripts --no-audit --no-fund", timeout=900)
        if r.return_code != 0:
            raise InfraError("artifact", f"npm ci rc={r.return_code}: {(r.stderr or r.stdout)[-400:]}")
        # Native addons: install scripts never run, so the manifest-pinned prebuild is placed by hand
        # and the addon must load on the pinned runtime.
        for pb in prebuilds:
            local = local_dir / pb["file"]
            if not local.exists() or sha256_file(local) != pb["sha256"]:
                raise InfraError("artifact", f"prebuild {local} missing or differs from manifest")
            remote = f"{REMOTE}/{Path(pb['file']).name}"
            await environment.upload_file(local, remote)
            r = await sh.must(f"sha256sum {shlex.quote(remote)} | cut -d' ' -f1", "artifact")
            if r.stdout.strip() != pb["sha256"]:
                raise InfraError("artifact", f"uploaded {remote} sha {r.stdout.strip()[:12]} != {pb['sha256'][:12]}")
            rel = pb.get("path") or ""
            parts = rel.split("/")
            if not rel.startswith("node_modules/") or any(seg in ("", ".", "..") for seg in parts) or parts[-1] != pb["package"]:
                raise InfraError("manifest", f"prebuild path {rel!r} is not an in-project node_modules path")
            pkg_dir = f"{REMOTE}/{rel}"
            await sh.must(f"[ -d {shlex.quote(pkg_dir)} ] && tar -xzf {shlex.quote(remote)} -C {shlex.quote(pkg_dir)} {shlex.quote(pb['member'])}", "artifact")
            # The require alone loads only JavaScript; the binding is dlopen'd when a database is
            # opened, so the probe opens one, runs a statement and closes it.
            probe = PREBUILD_PROBES.get(pb["package"])
            if probe is None:
                raise InfraError("manifest", f"no load probe for prebuilt package {pb['package']}")
            r = await sh.run(f"{NODE} -e {shlex.quote(probe(pkg_dir))}")
            if r.return_code != 0 or r.stdout.strip() != "ok":
                raise InfraError("artifact", f"prebuilt {pb['package']} at {rel} does not load on the pinned runtime: {(r.stderr or r.stdout)[-300:]}")
        for name in self._artifacts():
            pkg = PACKAGE_OF[name]
            for rel, digest in (self.manifest.artifact(name).get("files") or {}).items():
                r = await sh.must(f"sha256sum {shlex.quote(f'{REMOTE}/node_modules/{pkg}/{rel}')} | cut -d' ' -f1", "artifact")
                if r.stdout.strip() != digest:
                    raise InfraError("artifact", f"installed {pkg}/{rel} differs from tarball")
        env = await self._resolve_runtime_env(sh)
        self.runtime_env = env
        r = await sh.must(f"{BIN}/storybloq --version", "artifact", env)
        if r.stdout.strip() != self.manifest.artifact("storybloq")["version"]:
            raise InfraError("artifact", f"storybloq --version {r.stdout.strip()} != {self.manifest.artifact('storybloq')['version']}")
        versions: dict[str, Any] = {
            "manifest_sha256": self.manifest.sha256, "arm": self.arm, "auth_mode": AUTH_MODE, "harbor_version": self.manifest.data.get("harbor_version"),
            "storybloq_version": r.stdout.strip(), "storybloq_commit": self.manifest.data.get("storybloq_commit"),
            "executor_model": self.manifest.data.get("executor_model"), "git_version": self._git_version,
        }
        r = await sh.must("claude --version", "artifact", env)
        got = parse_semver(r.stdout)
        if got != self.manifest.require("claude_code_version"):
            raise InfraError("artifact", f"claude --version {r.stdout.strip()!r} != pin {self.manifest.data.get('claude_code_version')}")
        versions["claude_code_version"] = got
        versions.update(getattr(self, "_install_versions", {}))
        if self.uses_codex():
            r = await sh.must(f"{BIN}/codex --version", "artifact", env)
            got = parse_semver(r.stdout)
            if got != self.manifest.require("codex_version"):
                raise InfraError("artifact", f"codex --version {r.stdout.strip()!r} != pin {self.manifest.data.get('codex_version')}")
            versions["codex_version"] = got
            versions["bridge_commit"] = self.manifest.artifact("bridge").get("commit")
            versions["reviewer_model"] = self.manifest.data.get("reviewer_model")
        await environment.upload_file(BENCH_ROOT / "agents" / "mkticket.cjs", f"{REMOTE}/mkticket.cjs")
        await environment.upload_file(BENCH_ROOT / "agents" / "telemetry-copier.cjs", f"{REMOTE}/telemetry-copier.cjs")
        await sh.must(f"chmod +x {REMOTE}/mkticket.cjs {REMOTE}/telemetry-copier.cjs", "artifact")
        self._versions = versions

    # ----- run ---------------------------------------------------------------------
    async def _configure(self, sh: Shell, env: dict[str, str], environment: BaseEnvironment) -> dict[str, Any]:
        cfg = shlex.quote(self._config_dir())
        await sh.must(f"mkdir -p {cfg}", "config", env)
        await sh.must(f"{BIN}/storybloq setup --client claude", "config", env, timeout=300)
        await sh.must(f"mkdir -p {cfg}/skills && cp -R ~/.claude/skills/. {cfg}/skills/ && cp ~/.claude/settings.json {cfg}/settings.json", "config", env)
        await sh.must(f"claude mcp remove storybloq -s user >/dev/null 2>&1; claude mcp add storybloq -s user -- {BIN}/storybloq --mcp", "config", env)
        if self.uses_codex():
            conf = json.dumps({"model": self.manifest.require("reviewer_model"), "codex_path": (BIN / "codex").as_posix(), "reasoning_effort": self.manifest.data.get("reviewer_effort", "medium")})
            await sh.must(write_file_command(env["RB_CONFIG_PATH"], conf) + f" && mkdir -p {shlex.quote(env['CODEX_HOME'])} && chmod 0700 {shlex.quote(env['CODEX_HOME'])}", "config", env)
            # Subscription auth for the reviewer: the ChatGPT login file lands under CODEX_HOME (0600)
            # and is removed again before harbor collects /logs/agent (see _cleanup_steps).
            auth_remote = f"{env['CODEX_HOME']}/auth.json"
            self._created.add("codex_auth")
            await environment.upload_file(self.codex_auth, auth_remote)
            await sh.must(f"chmod 0600 {shlex.quote(auth_remote)}", "config", env)
            await sh.must(
                f"claude mcp add codex-bridge -s user -e RB_CONFIG_PATH={shlex.quote(env['RB_CONFIG_PATH'])} -e CODEX_HOME={shlex.quote(env['CODEX_HOME'])} -- node {REMOTE}/node_modules/codex-claude-bridge/dist/index.js",
                "config", env,
            )
        return await assert_effective_config(sh, self._config_dir(), env, skill_sha256=self.manifest.artifact("storybloq").get("skill_sha256"), expect_bridge=self.uses_codex())

    async def _prepare_task(self, sh: Shell, env: dict[str, str], instruction: str) -> str:
        wd = shlex.quote(self.workdir or ".")
        overrides = json.dumps(ARM_OVERRIDES[self.arm])
        self._created.add("story")
        await sh.must(f"cd {wd} && {BIN}/storybloq init --name bench-task", "config", env)
        await sh.must(f"cd {wd} && {BIN}/storybloq config set-overrides --json {shlex.quote(overrides)}", "config", env)
        await sh.must(write_file_command("/tmp/instruction.md", instruction), "config", env)
        r = await sh.must(f"cd {wd} && {NODE} {REMOTE}/mkticket.cjs /tmp/instruction.md", "config", env)
        lines = r.stdout.strip().splitlines()
        if not lines:
            raise InfraError("config", "mkticket printed no ticket id")
        tid = lines[-1]
        live = (self.environment_logs_dir / "story-live").as_posix()
        self._created.add("copier")
        await sh.must(f"nohup {NODE} {REMOTE}/telemetry-copier.cjs {wd} {shlex.quote(live)} >/dev/null 2>&1 & echo $! > /tmp/copier.pid", "config", env)
        return tid

    def _cleanup_steps(self) -> list[tuple[str, str]]:
        logs = self.environment_logs_dir.as_posix()
        wd = shlex.quote(self.workdir or ".")
        steps: list[tuple[str, str]] = []
        if "codex_auth" in self._created:
            # Only the rollout telemetry is copied into the collection tree; CODEX_HOME itself (with the
            # login file, refreshed or not) stays outside /logs/agent by construction.
            steps.append(("codex-sessions", f"mkdir -p {logs}/codex-home/sessions && if [ -d {CODEX_HOME_REMOTE}/sessions ]; then cp -R {CODEX_HOME_REMOTE}/sessions/. {logs}/codex-home/sessions/; fi"))
        if "copier" in self._created:
            steps.append(("copier", "kill $(cat /tmp/copier.pid) 2>/dev/null; true"))
        if "story" in self._created:
            steps += [
                ("status", f"cd {wd} && {BIN}/storybloq status --format json > {logs}/story-status.json"),
                ("sessions", f"cd {wd} && {BIN}/storybloq session list --format json > {logs}/story-sessions.json"),
                # /logs/agent is harbor's bind mount, so the only place on the same filesystem is inside it:
                # build story.tgz.partial there and publish with a same-directory rename (atomic). A cut can
                # leave only a *.partial file, which the credential scanner rejects as not inspectable, never
                # a partial story.tgz.
                ("tar", f"cd {wd} && tar czf {logs}/story.tgz.partial .story && mv -f {logs}/story.tgz.partial {logs}/story.tgz"),
            ]
        return steps

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        sh = self._shell(environment)
        logs = self.environment_logs_dir
        env = self.runtime_env or await self._resolve_runtime_env(sh)
        try:
            try:
                self.workdir = await capture_workdir(sh)
                preflight = await preflight_task_state(sh, self.workdir)
                measured = await self._configure(sh, env, environment)
                self.ticket_id = await self._prepare_task(sh, env, instruction)
                versions = {**self._versions, **measured, "preflight": preflight, "ticket_id": self.ticket_id, "workdir": self.workdir, "runtime_env": {k: v for k, v in env.items()}}
                await sh.must(write_file_command((logs / "versions.json").as_posix(), json.dumps(versions, sort_keys=True)), "config", env)
                # The parent's run() merges self._resolved_env_vars into the claude process env, so
                # hooks and MCP servers see the same PATH/CODEX_HOME/RB_CONFIG_PATH as the assertions did.
                self._resolved_env_vars.update(env)
                rendered = render_auto_instruction(f"/story auto {self.ticket_id}\n\nThe ticket {self.ticket_id} holds the task.\n" + instruction)
                await record_started(sh, logs, env)  # last pre-start step: a failure here is still pre-start
            except asyncio.CancelledError:
                await record_pre_start_cancellation(sh, logs)  # a pre-start hang cut by the task timeout is pre-start too
                raise
            except Exception as exc:  # noqa: BLE001  anything before claude starts is pre-start
                await run_bounded(record_infra_failure(sh, logs, exc), 15)
                raise
            if self.gate_cancel_after_start:
                await self._run_then_cancel(rendered, environment, context)
            else:
                await super().run(rendered, environment, context)
        finally:
            await bounded_cleanup(sh, self._cleanup_steps(), env, logs)

    async def _run_then_cancel(self, rendered: str, environment: BaseEnvironment, context: AgentContext) -> None:
        """Recovery smoke (a): raise a timeout once claude has started and the first snapshot exists.
        Fails distinctly when readiness never appears or the run ends before it."""
        from harbor.trial.errors import AgentTimeoutError  # type: ignore

        sh = self._shell(environment)
        logs = self.environment_logs_dir.as_posix()
        task = asyncio.ensure_future(super().run(rendered, environment, context))
        ready = False
        try:
            for _ in range(GATE_POLL_ROUNDS):
                await asyncio.sleep(GATE_POLL_SECONDS)
                if task.done():
                    break
                r = await sh.run(f"[ -s {logs}/claude-code.txt ] && [ -f {logs}/story-live/last-snapshot ] && echo READY")
                if "READY" in r.stdout:
                    ready = True
                    break
        finally:
            if not task.done():
                task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:  # noqa: BLE001
                pass
        if not ready:
            raise RuntimeError("gate_cancel_after_start: readiness (claude-code.txt and story-live/last-snapshot) never observed; the gate did not reach its trigger")
        raise AgentTimeoutError("Agent execution timed out (gate_cancel_after_start)")
