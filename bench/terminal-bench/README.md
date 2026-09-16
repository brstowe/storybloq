# Terminal-Bench 2.0 adapter for the storybloq harness (T-500)

Not part of the npm package (`files` allow-list excludes `bench/`). Runs the Terminal-Bench
2.0 task set (89 tasks, repo `laude-institute/terminal-bench-2`, pinned by commit in the
manifest) through the `harbor` 0.22.0 runner with two custom agents.

## Framing (fixed)

Terminal-Bench scores one sandboxed session per task; nothing carries between tasks.
storybloq's cross-session continuity contributes zero here by construction. What this
measures is the single-session discipline the `/story` skill imposes: plan before code,
proven-RED tests, an independent review round, repair on failure. Results are never
described as "storybloq makes models smarter". Cost per task is reported beside pass rate,
always; cost per PASSED task (total arm spend including failures, divided by passes) is
the decision number.

## Arms

| Arm | Agent | Review backend |
|---|---|---|
| A0 | `agents.baseline:StorybloqBaseline` (harbor's Claude Code agent plus isolation checks) | none |
| A1 | `agents.storybloq_auto:StorybloqAuto --ak arm=A1` | skill's built-in agent reviewer |
| A2 | same, `arm=A2` | Codex via codex-bridge inside the container |
| A3 | same, `arm=A3` | lenses |
| A4 | same, `arm=A4` | Codex + lenses |

Every arm appends the same task-neutral sentence (`agents/instruction.txt`) to the task text,
byte for byte, nothing stripped. Executor model is passed with `-m anthropic/<model>` and the
Claude Code pin with `--ak version=<pin>`; both must equal the frozen manifest or the agent
refuses to construct. Treatment arms create ONE ticket from the task text and run
`/story auto <id>`; only their wrapper mentions the ticket.

## Protocol (frozen by the manifest hash)

Identical across arms: task text, instruction suffix, executor model, no `--max-turns`, no
`--max-budget-usd`, one attempt, no retries except a single rerun of a PRE-START infra failure.
The task's own verifier, agent-setup and environment-build timeouts stay at harbor's default
multiplier (1.0) for every arm. The AGENT timeout (each task's `[agent] timeout_sec`, harbor's
`agent_timeout_multiplier`) is per-arm, frozen in the manifest's `protocol.agent_timeout_multiplier`
(ISS-1200: a real storybloq-arm smoke trial finished cleanly at 1027.8s, past regex-log's 900s
cap, and was still recorded as a timeout): A0 stays at 1.0 (900s) since it runs no guide/review
workflow and never approaches the cap; A1-A4 run at 2.5 (2250s), 2x that trial's wall rounded up,
so the cap is not binding for them. Estimand: equal wall-clock budget per arm's own timeout;
treatment arms may spend more tokens and that spend is what the cost column reports. Per task
the arm order is drawn from the seed; runs are sequential (`-n 1`), foreground, logs to a file.
`regex-log` (from `terminal-bench-sample@2.0`) is the smoke task and is excluded from the pilot
frame. Any change to a hashed file after the freeze requires a new manifest; affected arms
rerun and the report lists both.

## Authentication (subscriptions, never API keys)

The owner's decision: model calls run on the Claude and ChatGPT subscriptions. The token from
`claude setup-token` is the ONLY `--ae` value (`--ae CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN"`);
harbor scrubs every sensitive-looking `--ae` value from the collected artifacts, which is wanted for
the token. `CLAUDE_FORCE_OAUTH=1` (harbor then drops any API key so the CLI uses the token) must be
EXPORTED in the launch shell and never passed with `--ae`: as an `--ae` value harbor scrubbed its
`1` from every collected file and corrupted result.json (r11 dry run). The allow-list refuses every
`*_API_KEY` and every other `CLAUDE_*`, `CODEX_*`, `RB_*` or `*_TOKEN` variable, in `--ae` and
exported alike. A2/A4 pass the
ChatGPT login file with `--ak codex_auth=~/.codex/auth.json` (regular file, mode 0600, `auth_mode`
chatgpt); it is uploaded to the container's `CODEX_HOME` at `/opt/bench/codex-home` (0700), which is
OUTSIDE harbor's collection tree; only `codex-home/sessions/` (rollouts) is copied into `/logs/agent`
at cleanup, so no auth file, refreshed or not, can be collected. Credentials live in `/Volumes/Sharge/cpm-bench/.env` (mode 600, gitignored), sourced
only in the launch shell (`set -a; . /Volumes/Sharge/cpm-bench/.env; set +a`) and never printed:

```
CLAUDE_CODE_OAUTH_TOKEN=<output of claude setup-token>
CLAUDE_FORCE_OAUTH=1
CODEX_AUTH=/Users/<owner>/.codex/auth.json
```

The report parser refuses to build when any collected artifact (every file and every tar member
read to its end; anything not completely inspectable fails closed, so `story.tgz` is built as
`story.tgz.partial` inside the bind-mounted `/logs/agent` and published by an atomic same-directory
rename; a leftover `*.partial` is rejected by the scanner) carries the Codex login file, an OAuth token (`sk-ant-oat`),
the variable assignment or a token field. Cost is therefore ESTIMATED AT API LIST PRICE
from transcript token counts and is never reconciled against a bill; the harness figure it is
reconciled against is Claude Code's own estimate. Subscription runs are rate-limit bound: a 429,
overloaded or usage-limit stop is recorded as a protocol event (`rate_limit: rate-limited`, counted
per arm) and the row stays a started trial; the owner decides whether such rows are rerun.

## Run

```
export UV_CACHE_DIR=/Volumes/Sharge/cpm-bench/uv-cache
PY=/Volumes/Sharge/cpm-bench/venv/tb-env/bin/python
$PY manifest/prepare.py --out /Volumes/Sharge/cpm-bench/artifacts/<date> --storybloq ../.. \
   --bridge ~/Developer/codex-claude-bridge --tasks-repo <terminal-bench-2 checkout> \
   --arms A0,A1,A2 --claude-code-version <x.y.z> --codex-version <x.y.z> --node-version <x.y.z> \
   --executor-model claude-sonnet-5 --reviewer-model gpt-6-astra --pull-images
$PY manifest/freeze.py .../prepare-manifest.json .../run-manifest.json   # prints the manifest SHA-256 (file bytes)
PYTHONPATH=$PWD /Volumes/Sharge/cpm-bench/venv/tb-env/bin/harbor run --path .../tasks --agent agents.storybloq_auto:StorybloqAuto \
   --ak manifest=.../run-manifest.json --ak arm=A1 --ak version=<claude code pin> \
   -m anthropic/claude-sonnet-5 --ae CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
   [--ak codex_auth="$CODEX_AUTH"] --agent-timeout-multiplier <manifest protocol.agent_timeout_multiplier[<arm>]> \
   -n 1 -o /Volumes/Sharge/cpm-bench/runs/<job> \
   --agent-include-logs '**' 2>&1 | tee /Volumes/Sharge/cpm-bench/runs/<job>.log
$PY report/build_report.py --job A1=/Volumes/Sharge/cpm-bench/runs/<job>/<YYYY-MM-DD__HH-MM-SS> ... \
   [--rerun A1=<job dir holding the single authorised reruns>] \
   [--annotate task:arm:attempt="why the harness and transcript costs differ"] \
   --prices report/prices.json --manifest .../run-manifest.json --out report.md
```

Run from this directory with `PYTHONPATH=$PWD` (the harbor console script does not put the
cwd on sys.path). Harbor writes each job under `<-o dir>/<timestamp>/` with one
`<task>__<id>/` trial directory each; that timestamp directory is what `--job` takes.
Everything the run stores lives on the SSD; nothing benchmark-related goes on the internal disk.

Claude Code is installed from manifest artifacts, never resolved at run time: a
checksum-verified Node linux-x64 tarball (`prepare.py --node-version`) extracted to
`/opt/node`, and a locked install project (`install/claude`, `npm ci --ignore-scripts`, so only
lock-hashed bytes land and no lifecycle script runs) for the pinned
`@anthropic-ai/claude-code`. Its postinstall would only hardlink the linux-x64 platform
package's binary into place; instead the manifest records that binary's SHA-256 and the
container verifies the installed file and links it as `claude` directly. The same rule covers the
treatment-arm install projects: no lifecycle script runs, so a dependency whose install script
would build or fetch a native addon (`better-sqlite3`, needed by codex-bridge) has its published
linux-x64 prebuild for the pinned Node ABI downloaded at prepare time, hashed into the manifest
(`install.<arm>.prebuilds`), placed into the package directory after `npm ci` and
load-checked with the pinned `node`; any other package with an install script makes prepare refuse. Harbor's own bootstrap installer (a Bun binary) is never used:
the Terminal-Bench images are linux/amd64 only and it segfaults under qemu on Apple Silicon.
Install method, node version and tarball hash are recorded in `versions.json`.

`prepare.py` records the arm schedule (A0 installs nothing), locks one install project per
treatment arm (exactly that arm's tarballs), materialises every task from the recorded git
commit (`git archive`, dirty checkouts refused), snapshots the smoke task beside the pilot
tasks, refuses an existing output directory, and requires an exact `--codex-version`
whenever the bridge is packed. `freeze.py` checks the task snapshot set and hashes, requires dated and sourced
prices, and never overwrites a frozen manifest.

## What is recorded per trial

`agent/versions.json` (manifest hash, versions, `auth_mode` subscription, measured SKILL.md SHA-256, ticket id,
WORKDIR, preflight, runtime env, `home_after_install`: what the installs left in the real
home. The clean-home isolation gate runs before any install; a second gate after the installs
permits exactly one file on treatment arms, `~/.claude/settings.json` as written by storybloq's
CLI housekeeping (a single `hooks` key, every command a storybloq program), and nothing on A0;
skills, MCP config, Codex state or a foreign hook are pre-start infra errors. The effective
configuration under `CLAUDE_CONFIG_DIR` is asserted again before launch (A1/A2 only). A0's
post-run state is not asserted live in-container: `CLAUDE_CONFIG_DIR` is tar'd into
`agent/config-dir.tgz` (best effort, bounded), and the report build checks it host-side
(`report/parse.py:check_a0_isolation`, pure Python over the archive's own member metadata, no
shell). The invariant is narrow -- did storybloq install itself, matching the pre-launch gate's
own question for A1/A2 -- not "the directory is pristine": Claude Code's own per-trial
bookkeeping under a redirected `CLAUDE_CONFIG_DIR` (`.claude.json`, `.last-cleanup`, `backups/`,
`debug/`, `policy-limits.json`, `projects/` session transcripts, `remote-settings.json`,
`session-env/`, `shell-snapshots/`, a `skills/` that is a real, empty directory) is expected and
tolerated. Makes the row's `compliance` status `isolation-violated`: a populated `skills/`, a
`skills` entry that is a symlink rather than a real directory (tar never follows it into whatever
it points at, so that content is otherwise invisible here), a top-level `settings.json`, or a
`storybloq` entry under `.claude.json`'s top-level or per-project `mcpServers` (Claude Code's own
user-scope MCP config lives there, not only in `settings.json`, and can also be scoped under
`projects.<path>.mcpServers`) -- matched against each server's identity/execution fields (name,
`command`, `args`, `url`, `type`) only, never its free-form `env` or other config, so an unrelated
server whose env happens to mention "storybloq" is not a false positive -- an unparseable or
oversized `.claude.json` counts as a violation too, never a silent skip. A missing, empty, or
unreadable archive is `unknown` (fails closed, never silently `ok`).

For every non-A0 arm (A1-A4), `compliance` also carries a `guide-not-invoked` gate (ISS-1198):
`/story auto <ticket>` sent as prose piped into `claude --print`'s stdin was found not to
actually invoke the storybloq skill's autonomous-mode flow (Claude reads it as prose and calls
a couple of storybloq tools directly instead of ever calling `storybloq_autonomous_guide`), so
a trial can complete, even pass its task, having run none of the review discipline the
benchmark exists to measure. The gate requires positive, VALIDATED evidence the guide's own
state machine ran at all, not merely something that resembles it: either a
`.story/sessions/<id>/state.json` in the collected story tree that parsed cleanly, recorded a
real guide state or status (not an arbitrary non-null string), and whose `currentTicket`
resolves to the ticket the adapter actually created for this trial (`versions.json`'s
`ticket_id`, correlated through the loaded ticket record's id/displayId when the two forms
differ) -- or an actual `tool_use` call to `storybloq_autonomous_guide`, made by a real
`assistant` record (never a record merely containing a tool_use-shaped item), with a matching
`tool_result` recording success (an errored or unacknowledged call doesn't count; the tool's
presence in a transcript's system-init tool inventory doesn't count either -- every registered
MCP tool is listed there on every session whether or not it was ever called). Absent both, `compliance` becomes
`guide-not-invoked`, which excludes the row from every compliant-only summary and flags it in
the raw one, the same treatment as `no-review` and `isolation-violated`; for A2/A4 it takes
priority over the existing `reviewed`/`no-review` distinction, since that distinction
presupposes the guide ran in the first place.

A hook command passes
only as a single plain invocation of one of the package's two bins (`storybloq`,
`storybloq-presence`) with an audited subcommand: no shell operators,
substitutions, quotes or redirections anywhere in the string), `agent/started.json` (written right before claude is
launched), `agent/infra-failure.json` (written on a PRE-START failure, including a pre-start hang cut by
the task timeout, reason `pre-start-timeout`; the only thing the report accepts as an infra
exclusion), `agent/config-dir.tgz` (A0's collected `CLAUDE_CONFIG_DIR`; an isolation violation
found there keeps the row in the denominator, flagged), `agent/claude-code.txt`
(stream-json), `agent/sessions/` (Claude transcripts incl. subagents), `agent/codex-home/`
(Codex rollouts, A2/A4), `agent/story-live/` (incremental copy of `.story/`, each snapshot published by atomic rename
and `last-snapshot` stamped only after a successful copy),
`agent/story.tgz`, `agent/story-status.json`, `agent/story-sessions.json`,
`agent/collect-errors.json`.

## Report rules

Rows are enumerated from the frozen manifest: every scheduled arm needs a job directory, an
unscheduled arm is refused, a scheduled trial without output is a visible missing row and a
build error, and a started trial without a readable result.json is a build error. The ticket
text of every treatment trial is compared byte for byte with `instruction.md` from the
frozen task snapshot. Every started row must carry the report's manifest hash and
arm. Cost is unknown (never zero) when transcript coverage is incomplete (malformed line,
missing usage field, conflicting duplicate message id, cache write without a tier split), when
a model or dimension is unpriced, or when an A2/A4 row's Codex usage is neither complete nor
verified zero (session state present and no Codex round). One rerun of a pre-start infra
failure is allowed; the original stays in the raw listing unselected, anything else is an
error. Harness `total_cost_usd` is reconciled against the transcript at max(0.02, 5%); an
annotated mismatch stays visible with both figures and the explanation.

## Tests

```
$PY -m pytest -q          # 77 tests, no container; adapters run with their real constructors against a strict fake environment
$PY tests/mutants.py      # m1..m10 against report/parse.py: baseline must pass, every mutant must be KILLED by a test failure
```

Smoke gates that need a container: A0 and A1 on `regex-log`; the A2 gate (a `/story auto`
run whose `reviews` round carries a `reviewerSessionId` naming a rollout under the gate's
`CODEX_HOME`); the two recovery trials (`--ak gate_cancel_after_start=true`, and
`--agent-timeout-multiplier 0.01`); the two-process socket probe for the duet arms.

## Prices

`report/prices.json` must carry `date` and a `source` per model, copied from the providers'
official price pages. Unknown model or dimension makes a row's cost unknown; the report
then marks the arm's cost metrics unavailable and prints a labelled lower bound.
