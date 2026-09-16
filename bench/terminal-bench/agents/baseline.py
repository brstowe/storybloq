"""Arm A0: harbor's own Claude Code agent plus isolation checks and the fixed no-user sentence.
No storybloq anywhere in the container."""
from __future__ import annotations

import asyncio
import json
import shlex
from pathlib import Path
from typing import Any

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from agents.common import (
    CONFIG_DIR_ARTIFACT,
    POST_RUN_CHECK_TIMEOUT,
    Manifest,
    Shell,
    AUTH_MODE,
    check_env_allowlist,
    check_pins,
    ensure_clean_home,
    check_home_after_install,
    install_claude_from_artifacts,
    record_infra_failure,
    record_pre_start_cancellation,
    record_started,
    run_bounded,
    write_file_command,
)

BENCH_ROOT = Path(__file__).resolve().parents[1]
INSTRUCTION_SUFFIX = (BENCH_ROOT / "agents" / "instruction.txt").read_text(encoding="utf-8").strip()


def render_instruction(instruction: str) -> str:
    """Task text byte for byte, then a blank line and the shared suffix. Nothing stripped."""
    return f"{instruction}\n\n{INSTRUCTION_SUFFIX}\n"


class StorybloqBaseline(ClaudeCode):
    ARM = "A0"

    @staticmethod
    def name() -> str:
        return "storybloq-baseline"

    def __init__(self, logs_dir: Path, manifest: str | None = None, *args: Any, **kwargs: Any):
        super().__init__(logs_dir, *args, **kwargs)
        self.manifest = Manifest.load(manifest, BENCH_ROOT)
        check_pins(self.manifest, arm=self.ARM, claude_version_kwarg=self._version, model_name=self.model_name)
        check_env_allowlist(self.extra_env, self.ARM)

    def _config_dir(self) -> str:
        return (self.environment_logs_dir / "sessions").as_posix()

    def _shell(self, environment: BaseEnvironment) -> Shell:
        return Shell(lambda **kw: self.exec_as_agent(environment, kw["command"], env=kw.get("env"), timeout_sec=kw.get("timeout_sec")))

    async def install(self, environment: BaseEnvironment) -> None:
        sh = self._shell(environment)
        try:
            await ensure_clean_home(sh)  # before any install: the image carries no user state
            self._install_versions = await install_claude_from_artifacts(sh, environment, lambda cmd: self.exec_as_root(environment, cmd), self.manifest)
            await super().install(environment)  # finds the pinned claude and skips its bootstrap
            self._install_versions["home_after_install"] = await check_home_after_install(sh, allow_storybloq_settings=False, program="storybloq")  # A0 installs nothing: nothing may appear
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001  harbor's own claude install failed: pre-start, marker written
            await run_bounded(record_infra_failure(sh, self.environment_logs_dir, exc), 15)
            raise

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        sh = self._shell(environment)
        logs = self.environment_logs_dir
        try:
            versions = {"manifest_sha256": self.manifest.sha256, "arm": self.ARM, "auth_mode": AUTH_MODE, "harbor_version": self.manifest.data.get("harbor_version"),
                        "executor_model": self.manifest.data.get("executor_model"), **getattr(self, "_install_versions", {})}
            await sh.must(write_file_command((logs / "versions.json").as_posix(), json.dumps(versions, sort_keys=True)), "config")
            await record_started(sh, logs)
        except asyncio.CancelledError:
            await record_pre_start_cancellation(sh, logs)  # a pre-start hang cut by the task timeout is pre-start too
            raise
        except Exception as exc:  # noqa: BLE001  anything before claude starts is pre-start
            await run_bounded(record_infra_failure(sh, logs, exc), 15)
            raise
        try:
            await super().run(render_instruction(instruction), environment, context)
        finally:
            # Collection only, bounded and best-effort: nothing in this block can replace the
            # original outcome. Whether the config dir stayed empty (isolation held) is decided
            # host-side from this tar, in report/parse.py:check_a0_isolation -- not asserted live
            # in-container. That in-container check went through six review rounds (25-30) on a
            # shell/Node one-liner, each round closing one text-parsing, TOCTOU or portability gap
            # only to expose a narrower one, none of it ever touching an actual benchmark result;
            # a plain `tar` (byte-exact archive member names and types from a real stat/lstat tar
            # already has to do, no shell text-parsing of a listing at all) plus a host-side pure
            # Python check over the extracted archive removes every one of those classes at once.
            await run_bounded(self._collect_config_dir(sh, logs), POST_RUN_CHECK_TIMEOUT + 15)

    async def _collect_config_dir(self, sh: Shell, logs) -> None:
        cfg = self._config_dir()
        dest = (logs / CONFIG_DIR_ARTIFACT).as_posix()
        partial = dest + ".partial"
        try:
            # Built under a same-directory .partial name then renamed: /logs/agent is a bind
            # mount elsewhere in this adapter, where a cross-filesystem rename or hard link fails
            # (EXDEV) but a same-directory rename is always atomic.
            await asyncio.wait_for(sh.run(f"tar czf {shlex.quote(partial)} -C {shlex.quote(cfg)} . && mv -f {shlex.quote(partial)} {shlex.quote(dest)}"), POST_RUN_CHECK_TIMEOUT)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001  best-effort: report/parse.py treats a missing/partial artifact as unknown, never as a pass
            pass
