"""Trial directory -> one report row.

Reads, per harbor trial dir:
  agent/sessions/projects/**/*.jsonl   Claude Code transcripts (main + nested subagents)
  agent/claude-code.txt                stream-json stdout (final result event: total_cost_usd)
  agent/codex-home/sessions/**/rollout-*.jsonl   Codex rollouts (A2/A4)
  agent/story.tgz or agent/story-live/ storybloq session state (reviews, exit state)
  agent/versions.json                  manifest hash, versions, measured skill hash
  agent/infra-failure.json             adapter marker: pre-start infra failure (the ONLY exclusion)
  agent/started.json                   adapter marker: claude was launched
  agent/config-dir.tgz                 A0's collected CLAUDE_CONFIG_DIR (isolation checked here, host-side)
  agent/collect-errors.json            bounded-cleanup failures
  result.json                          harbor trial result (reward, exception, timing)

Usage identity rules (plan T-500):
  Claude: unit = (file, message.id); keep the LAST usage per unit; sum per model id. A message id
          seen in two files counts once when the copies are identical (duplicate-id-copy) and
          makes executor coverage incomplete when they differ (duplicate-id-conflict).
  Codex:  unit = (turn_id, response_id) from token_usage_record; first wins, repeat is a
          diagnostic; model from the turn_context with the same turn_id; token_count is
          never used (cumulative, modelless).
Coverage: any malformed line, missing required usage field, invalid count or unresolved
identity marks the source INCOMPLETE and the report treats its cost as unknown. Nothing here
substitutes zero for an unknown value.

Guide-invocation gate (ISS-1198): for every non-A0 arm, `check_guide_invoked` fails the row's
`compliance` status to "guide-not-invoked" -- excluded from every summary, same as an isolation
violation -- unless a `.story/sessions/<id>/state.json` exists in the collected story tree, or
an actual `tool_use` call to `storybloq_autonomous_guide` appears in a collected transcript.
Both are things only that MCP tool's own state machine can produce; a trial that completed,
even one that passed its task, proves nothing about the review loop under test without one of
them.
"""
from __future__ import annotations

import json
import math
import tarfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

ANTHROPIC_DIMS = ("input", "cache_read", "cache_write_5m", "cache_write_1h", "output")
OPENAI_DIMS = ("input", "cached_input", "output")
CLAUDE_REQUIRED = ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens")
CODEX_REQUIRED = ("input_tokens", "cached_input_tokens", "output_tokens")


@dataclass
class Usage:
    """Token counts for one model. Anthropic and OpenAI fields coexist; unused stay 0."""
    input: int = 0
    cache_read: int = 0
    cache_write_5m: int = 0
    cache_write_1h: int = 0
    output: int = 0
    cached_input: int = 0  # OpenAI: subset of input
    responses: int = 0

    FIELDS = ("input", "cache_read", "cache_write_5m", "cache_write_1h", "output", "cached_input", "responses")

    def add(self, other: "Usage") -> None:
        for k in self.FIELDS:
            setattr(self, k, getattr(self, k) + getattr(other, k))

    def as_dict(self) -> dict[str, int]:
        return {k: getattr(self, k) for k in self.FIELDS}


@dataclass
class ClaudeUsage:
    per_model: dict[str, Usage] = field(default_factory=dict)
    context_at_exit: int | None = None
    main_file: str | None = None
    files: int = 0
    diagnostics: list[str] = field(default_factory=list)
    coverage: str = "complete"  # complete | incomplete | none
    unpriceable: list[str] = field(default_factory=list)  # e.g. cache-tier-unknown


@dataclass
class CodexUsage:
    per_model: dict[str, Usage] = field(default_factory=dict)
    rollouts: dict[str, dict[str, Any]] = field(default_factory=dict)  # thread id -> {models, responses, file}
    diagnostics: list[str] = field(default_factory=list)
    coverage: str = "complete"  # complete | incomplete | none


def _iter_jsonl(path: Path, diags: list[str], label: str) -> Iterator[dict[str, Any]]:
    """Yields dict records; every unreadable line is a diagnostic (the caller downgrades coverage)."""
    data = path.read_bytes()
    lines = data.split(b"\n")
    for i, raw in enumerate(lines, 1):
        stripped = raw.strip()
        if not stripped:
            continue
        try:
            obj = json.loads(stripped)
        except (json.JSONDecodeError, UnicodeDecodeError):
            tail = i == len(lines) and not data.endswith(b"\n")
            diags.append(f"{'truncated-tail' if tail else 'malformed-line'}:{label}:{i}")
            continue
        if isinstance(obj, dict):
            yield obj
        else:
            diags.append(f"malformed-line:{label}:{i}")


def _count(u: dict[str, Any], key: str) -> int | None:
    v = u.get(key)
    if isinstance(v, bool) or not isinstance(v, int) or v < 0:
        return None
    return v


def _usage_from_claude(u: dict[str, Any]) -> tuple[Usage | None, list[str]]:
    """(usage, diagnostics). None usage when a required field is missing or invalid."""
    diags: list[str] = []
    vals: dict[str, int] = {}
    for k in CLAUDE_REQUIRED:
        if k not in u:
            diags.append(f"usage-missing-field:{k}")
            continue
        c = _count(u, k)
        if c is None:
            diags.append(f"usage-invalid:{k}")
            continue
        vals[k] = c
    if len(vals) != len(CLAUDE_REQUIRED):
        return None, diags
    agg = vals["cache_creation_input_tokens"]
    cc = u.get("cache_creation") if isinstance(u.get("cache_creation"), dict) else None
    w5 = _count(cc, "ephemeral_5m_input_tokens") if cc and "ephemeral_5m_input_tokens" in cc else None
    w1h = _count(cc, "ephemeral_1h_input_tokens") if cc and "ephemeral_1h_input_tokens" in cc else None
    if w5 is None and w1h is None:
        if agg > 0:
            # No tier split in this record: the aggregate cannot be priced. Recorded under the
            # 5m field for the token total; the caller marks the executor cost unpriceable.
            diags.append("cache-tier-unknown")
        w5, w1h = agg, 0
    else:
        w5, w1h = w5 or 0, w1h or 0
        if w5 + w1h != agg:
            diags.append("cache-tier-mismatch")
            return None, diags
    return Usage(input=vals["input_tokens"], cache_read=vals["cache_read_input_tokens"], cache_write_5m=w5, cache_write_1h=w1h, output=vals["output_tokens"], responses=1), diags


def parse_claude_sessions(sessions_root: Path) -> ClaudeUsage:
    """sessions_root = <trial>/agent/sessions. Collects projects/**/*.jsonl recursively."""
    out = ClaudeUsage()
    projects = sessions_root / "projects"
    files = sorted(projects.rglob("*.jsonl")) if projects.exists() else []
    out.files = len(files)
    if not files:
        out.diagnostics.append("no-claude-transcripts")
        out.coverage = "none"
        return out
    mains = [f for f in files if f.parent.parent == projects]
    if not mains:
        out.diagnostics.append("no-main-transcript")
        out.coverage = "incomplete"
    elif len(mains) > 1:
        out.diagnostics.append(f"multiple-main-transcripts:{len(mains)}")
    first_seen: dict[str, tuple[str, dict[str, Any]]] = {}
    last_by_unit: dict[tuple[str, str], tuple[str, dict[str, Any]]] = {}
    last_main_usage: dict[str, Any] | None = None
    main_path = max(mains, key=lambda p: p.stat().st_mtime) if mains else None
    out.main_file = str(main_path.relative_to(sessions_root)) if main_path else None
    for f in files:
        rel = str(f.relative_to(sessions_root))
        for rec in _iter_jsonl(f, out.diagnostics, rel):
            msg = rec.get("message")
            if rec.get("type") != "assistant" or not isinstance(msg, dict):
                continue
            usage = msg.get("usage")
            mid = msg.get("id")
            if not isinstance(usage, dict) or not isinstance(mid, str):
                out.diagnostics.append(f"assistant-without-usage:{rel}")
                continue
            model = msg.get("model") if isinstance(msg.get("model"), str) else None
            if model is None:
                out.diagnostics.append(f"assistant-without-model:{rel}:{mid}")
                model = "unknown"
            last_by_unit[(rel, mid)] = (model, usage)
            first_seen.setdefault(mid, (rel, usage))
            if main_path is not None and f == main_path:
                last_main_usage = usage
    # Cross-file identity: identical copies count once; conflicting copies make coverage incomplete.
    by_mid: dict[str, list[tuple[str, tuple[str, dict[str, Any]]]]] = {}
    for (rel, mid), (model, usage) in last_by_unit.items():
        by_mid.setdefault(mid, []).append((rel, (model, usage)))
    counted: dict[tuple[str, str], tuple[str, dict[str, Any]]] = {}
    for mid, copies in by_mid.items():
        if len(copies) > 1:
            files_s = ",".join(r for r, _ in copies)
            if all(mu == copies[0][1] for _, mu in copies[1:]):  # same model AND same usage
                out.diagnostics.append(f"duplicate-id-copy:{mid}:{files_s}")
                copies = copies[:1]
            else:
                out.diagnostics.append(f"duplicate-id-conflict:{mid}:{files_s}")
                out.coverage = "incomplete"
        for rel, _u in copies:
            counted[(rel, mid)] = last_by_unit[(rel, mid)]
    for (_rel, _mid), (model, usage) in counted.items():
        u, d = _usage_from_claude(usage)
        for x in d:
            out.diagnostics.append(f"{x}:{_rel}:{_mid}")
            if x == "cache-tier-unknown":
                out.unpriceable.append("cache-tier-unknown")
        if u is None:
            out.coverage = "incomplete"
            continue
        out.per_model.setdefault(model, Usage()).add(u)
    if any(d.startswith(("malformed-line", "truncated-tail", "assistant-without")) for d in out.diagnostics):
        out.coverage = "incomplete"
    if not out.per_model and out.coverage == "complete":
        out.diagnostics.append("no-assistant-usage")
        out.coverage = "none"
    if last_main_usage is not None:
        u, _ = _usage_from_claude(last_main_usage)
        if u is not None:
            out.context_at_exit = u.input + u.cache_read + u.cache_write_5m + u.cache_write_1h
    return out


# Round 38: sourced from the authoritative schema, storybloq/src/autonomous/session-types.ts's
# WORKFLOW_STATES array and SessionStateSchema's status enum -- not guide.ts's RECOVERY_MAPPING,
# which is a narrower, unrelated table and was missing INIT/LOAD_CONTEXT/BUILD/VERIFY/COMPACT.
GUIDE_STATES = {"INIT", "LOAD_CONTEXT", "PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "WRITE_TESTS", "TEST", "CODE_REVIEW", "BUILD", "VERIFY", "FINALIZE", "COMPACT", "HANDOVER", "COMPLETE", "LESSON_CAPTURE", "ISSUE_FIX", "ISSUE_SWEEP", "SESSION_END"}
GUIDE_STATUSES = {"active", "completed", "superseded"}


def _ticket_identity_confirmed(story: "StoryState", created_ticket_id: str | None) -> bool:
    """True iff the SESSION's own recorded ticket reference (`session_ticket_id`, from
    currentTicket/currentIssue -- never the ticket-file fallback, which proves only that a
    ticket file happens to exist, not which one the session referenced) resolves to the same
    ticket the adapter actually created for this trial (`created_ticket_id`, from
    versions.json). Both may be either the display id (T-xxx) or the internal hash id; the
    single loaded ticket record, when there is exactly one, resolves between the two forms."""
    if created_ticket_id is None or story.session_ticket_id is None:
        return False
    if story.session_ticket_id == created_ticket_id:
        return True
    rec = story.ticket_record
    if rec is None:
        return False
    ids = {v for v in (rec.get("id"), rec.get("displayId")) if isinstance(v, str)}
    return story.session_ticket_id in ids and created_ticket_id in ids


def check_guide_invoked(agent_dir: Path, story: "StoryState", created_ticket_id: str | None = None) -> bool:
    """ISS-1198: `/story auto <ticket>` sent as the first line of a prompt piped to `claude
    --print` was found (A1 and A2 smoke, 2026-09-12) to never actually invoke the storybloq
    skill's autonomous-mode flow -- Claude reads it as prose and calls a couple of storybloq
    tools directly instead, never storybloq_autonomous_guide. Neither of those smoke trials
    exercised the review loop the benchmark exists to measure, and nothing upstream of this
    caught it: a trial can complete, pass its task, and still have run none of the discipline
    under test. This is the hard gate that catches it in code rather than by eye.

    True iff EITHER of the two independent things `storybloq_autonomous_guide`'s state machine
    is the only thing that can produce is present AND VALIDATED, not merely present:

    (1) A `.story/sessions/<id>/state.json` in the collected story tree
    (`story.session_state_present`), but only when ALL of: it parsed cleanly (no diagnostic
    whose PREFIX is `session-state-unreadable` -- round 37: the actual diagnostic carries a
    suffix, e.g. `session-state-unreadable:JSONDecodeError`, so an exact-membership check against
    it never matched anything and this branch was silently unconditional; round 36 originally
    meant to require this); its `state` is one of the guide's own named states (`GUIDE_STATES`)
    or its `status` one of the guide's own named statuses (`GUIDE_STATUSES`) -- round 37: an
    arbitrary non-null string like `"anything"` no longer counts, only a value the state machine
    actually emits; and `_ticket_identity_confirmed` holds against `created_ticket_id` (the
    adapter's own recorded ticket for this trial, from versions.json) -- round 37: replaces the
    round-36 ticket-DESCRIPTION-text comparison (which silently passed whenever a description was
    merely absent) with an actual ticket-ID correlation between the session's own reference and
    the ticket the adapter created.

    (2) A `tool_use` call to `storybloq_autonomous_guide` -- made by an actual `assistant`
    record, never a `user` or other record merely CONTAINING a tool_use-shaped item -- that also
    has a matching `tool_result` recording success (`is_error` not true) somewhere in the
    transcripts: a rejected or errored call proves an attempt, not that the guide's flow
    actually ran, so it is not accepted on its own (round 35 findings). The tool's bare presence
    in a transcript's system-init tool inventory does NOT count either: every registered MCP
    tool is listed there on every session regardless of whether it was ever called."""
    if (story.session_state_present
            and not any(d.startswith("session-state-unreadable") for d in story.diagnostics)
            and (story.exit_state in GUIDE_STATES or story.status in GUIDE_STATUSES)
            and _ticket_identity_confirmed(story, created_ticket_id)):
        return True
    transcript_dir = agent_dir / "sessions" / "projects"
    if not transcript_dir.exists():
        return False
    files = sorted(transcript_dir.rglob("*.jsonl"))
    scratch: list[str] = []
    pending_ids: set[str] = set()
    for f in files:
        for rec in _iter_jsonl(f, scratch, str(f)):
            if rec.get("type") != "assistant":
                continue
            msg = rec.get("message")
            content = msg.get("content") if isinstance(msg, dict) else None
            if not isinstance(content, list):
                continue
            for item in content:
                if not isinstance(item, dict) or item.get("type") != "tool_use":
                    continue
                name, tool_id = item.get("name"), item.get("id")
                if isinstance(name, str) and isinstance(tool_id, str) and name.rsplit("__", 1)[-1] == "storybloq_autonomous_guide":
                    pending_ids.add(tool_id)
    if not pending_ids:
        return False
    for f in files:
        for rec in _iter_jsonl(f, scratch, str(f)):
            msg = rec.get("message")
            content = msg.get("content") if isinstance(msg, dict) else None
            if not isinstance(content, list):
                continue
            for item in content:
                if isinstance(item, dict) and item.get("type") == "tool_result" and item.get("tool_use_id") in pending_ids and item.get("is_error") is not True:
                    return True
    return False


def parse_codex_home(codex_home: Path) -> CodexUsage:
    out = CodexUsage()
    sessions = codex_home / "sessions"
    files = sorted(sessions.rglob("rollout-*.jsonl")) if sessions.exists() else []
    if not files:
        out.diagnostics.append("no-codex-rollouts")
        out.coverage = "none"
        return out
    for f in files:
        thread_id = "-".join(f.stem.split("-")[-5:])  # rollout-<ts>-<uuid with 4 dashes>
        rel = str(f.relative_to(codex_home))
        turn_model: dict[str, str] = {}
        seen: set[tuple[str, str]] = set()
        models: set[str] = set()
        responses = 0
        for rec in _iter_jsonl(f, out.diagnostics, rel):
            t = rec.get("type")
            p = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}
            if t == "turn_context":
                tid, model = p.get("turn_id"), p.get("model")
                if isinstance(tid, str) and isinstance(model, str):
                    turn_model[tid] = model
            elif t == "token_usage_record":
                tid, rid, usage = p.get("turn_id"), p.get("response_id"), p.get("usage")
                if not (isinstance(tid, str) and isinstance(rid, str) and isinstance(usage, dict)):
                    out.diagnostics.append(f"malformed-usage-record:{thread_id}")
                    out.coverage = "incomplete"
                    continue
                if (tid, rid) in seen:
                    out.diagnostics.append(f"duplicate-response:{thread_id}:{rid}")
                    continue
                seen.add((tid, rid))
                counts = {k: _count(usage, k) for k in CODEX_REQUIRED}
                if any(v is None for v in counts.values()) or counts["cached_input_tokens"] > counts["input_tokens"]:  # type: ignore[operator]
                    out.diagnostics.append(f"usage-invalid:{thread_id}:{rid}")
                    out.coverage = "incomplete"
                    continue
                model = turn_model.get(tid)
                if model is None:
                    out.diagnostics.append(f"usage-without-turn-model:{thread_id}:{tid}")
                    out.coverage = "incomplete"
                    model = "unknown"
                models.add(model)
                responses += 1
                out.per_model.setdefault(model, Usage()).add(Usage(input=counts["input_tokens"], cached_input=counts["cached_input_tokens"], output=counts["output_tokens"], responses=1))
        if responses == 0:
            out.diagnostics.append(f"rollout-empty:{thread_id}")
            out.coverage = "incomplete"  # a rollout that recorded no usage is evidence of lost records, not of zero spend
        out.rollouts[thread_id] = {"models": sorted(models), "responses": responses, "file": rel}
    if any(d.startswith(("malformed-line", "truncated-tail")) for d in out.diagnostics):
        out.coverage = "incomplete"
    if out.coverage == "complete" and not out.per_model:
        out.coverage = "none"
    return out


@dataclass
class StoryState:
    exit_state: str | None = None
    status: str | None = None
    ticket_id: str | None = None
    rounds: list[dict[str, Any]] = field(default_factory=list)  # each: stage, round, reviewer, verdict, reviewerSessionId, reviewerModel
    ticket_description: str | None = None
    diagnostics: list[str] = field(default_factory=list)
    source: str | None = None  # story.tgz | story-live
    session_state_present: bool = False  # a .story/sessions/<id>/state.json existed in the tree
    # at all (parse failure doesn't clear this: only storybloq_autonomous_guide ever creates this
    # path, so its mere presence is evidence the guide ran -- see ISS-1198 / check_guide_invoked)
    session_ticket_id: str | None = None  # currentTicket/currentIssue.id from the SESSION state
    # only (round 37: distinct from ticket_id below, which also falls back to "there happens to
    # be a ticket file" -- that fallback proves nothing about which ticket the session itself
    # references, so it must never be used for guide-invocation identity correlation)
    ticket_record: dict[str, Any] | None = None  # the single loaded ticket file's raw dict, kept
    # so its id/displayId can resolve against session_ticket_id and the adapter's created id


def _norm(name: str) -> str:
    return name[2:] if name.startswith("./") else name


def _load_story_tree(agent_dir: Path, diags: list[str]) -> tuple[dict[str, bytes], str | None]:
    """Prefer story.tgz (final); fall back to story-live/ (incremental) when the archive is
    missing or unreadable (a bounded cleanup or a cancel can leave it truncated)."""
    tgz = agent_dir / "story.tgz"
    if tgz.exists():
        tree: dict[str, bytes] = {}
        try:
            with tarfile.open(tgz, "r:gz") as tf:
                for m in tf.getmembers():
                    if m.isfile():
                        fh = tf.extractfile(m)
                        if fh is not None:
                            tree[_norm(m.name)] = fh.read()
            return tree, "story.tgz"
        except (tarfile.TarError, EOFError, OSError) as exc:
            diags.append(f"story-archive-unreadable:{type(exc).__name__}")
    live = agent_dir / "story-live" / ".story"  # the copier publishes a symlink to the latest complete snapshot
    if live.exists():
        tree = {}
        root = live.resolve()
        for p in root.rglob("*"):
            if p.is_file():
                tree[".story/" + str(p.relative_to(root))] = p.read_bytes()
        return tree, "story-live"
    return {}, None


def parse_story(agent_dir: Path) -> StoryState:
    out = StoryState()
    tree, out.source = _load_story_tree(agent_dir, out.diagnostics)
    if not tree:
        out.diagnostics.append("no-story-state")
        return out
    states = [k for k in tree if k.startswith(".story/sessions/") and k.endswith("/state.json")]
    out.session_state_present = bool(states)
    if not states:
        out.diagnostics.append("no-session-state")
    else:
        if len(states) > 1:
            out.diagnostics.append(f"multiple-sessions:{len(states)}")
        try:
            s = json.loads(tree[sorted(states)[-1]].decode("utf-8"))
            if not isinstance(s, dict):
                raise ValueError("state.json is not an object")
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
            out.diagnostics.append(f"session-state-unreadable:{type(exc).__name__}")
            s = {}
        out.exit_state = s.get("state") if isinstance(s.get("state"), str) else None
        out.status = s.get("status") if isinstance(s.get("status"), str) else None
        ct = s.get("currentTicket") or s.get("currentIssue")
        if isinstance(ct, dict):
            out.ticket_id = ct.get("id") if isinstance(ct.get("id"), str) else None
        elif isinstance(ct, str):
            out.ticket_id = ct
        out.session_ticket_id = out.ticket_id  # captured before the ticket-file fallback below
        raw_reviews = s.get("reviews")
        if raw_reviews is not None and not isinstance(raw_reviews, dict):
            out.diagnostics.append("reviews-malformed:container")
        reviews = raw_reviews if isinstance(raw_reviews, dict) else {}
        for stage in ("plan", "code"):
            lst = reviews.get(stage)
            if lst is not None and not isinstance(lst, list):
                out.diagnostics.append(f"reviews-malformed:{stage}")
                continue
            for r in lst or []:
                if not isinstance(r, dict):
                    out.diagnostics.append(f"reviews-malformed:{stage}:entry")
                    continue
                if True:
                    out.rounds.append({"stage": stage, **{k: r.get(k) for k in ("round", "reviewer", "verdict", "reviewerSessionId", "reviewerModel", "reviewerEvidence", "findingCount")}})
    tickets = [k for k in tree if k.startswith(".story/tickets/") and k.endswith(".json")]
    if len(tickets) == 1:
        try:
            t = json.loads(tree[tickets[0]].decode("utf-8"))
            if not isinstance(t, dict):
                raise ValueError
            out.ticket_description = t.get("description") if isinstance(t.get("description"), str) else None
            out.ticket_id = out.ticket_id or t.get("displayId") or t.get("id")
            out.ticket_record = t
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            out.diagnostics.append("ticket-unreadable")
    elif tickets:
        out.diagnostics.append(f"multiple-tickets:{len(tickets)}")
    else:
        out.diagnostics.append("no-ticket")
    return out


TERMINAL_STATES = {"SESSION_END", "COMPLETE"}
TERMINAL_STATUSES = {"completed", "failed", "cancelled", "aborted"}


def _story_state_complete(story: StoryState) -> bool:
    """Session state was found, read and parsed without any diagnostic that could hide a review
    round, AND the session had ended: a live pre-review snapshot proves nothing about spend."""
    bad = ("no-story-state", "no-session-state", "session-state-unreadable", "story-archive-unreadable", "reviews-malformed", "multiple-sessions")
    terminal = story.exit_state in TERMINAL_STATES or story.status in TERMINAL_STATUSES
    return story.source is not None and terminal and not any(d.startswith(bad) for d in story.diagnostics)


LEAK_PATTERNS = (b"sk-ant-oat", b"CLAUDE_CODE_OAUTH_TOKEN=", b'"refresh_token"', b'"access_token"')


class CredentialLeak(RuntimeError):
    """A collected artifact carries a subscription credential. The report refuses to build."""


SCAN_CHUNK = 8 * 1024 * 1024
SCAN_OVERLAP = max(len(p) for p in LEAK_PATTERNS) - 1  # a pattern straddling two chunks is still seen whole


def _stream_leak(fh: Any) -> bool:
    """Incremental scan of a binary stream, whole file, with overlap across chunk boundaries."""
    tail = b""
    while True:
        chunk = fh.read(SCAN_CHUNK)
        if not chunk:
            return False
        if any(pat in tail + chunk for pat in LEAK_PATTERNS):
            return True
        tail = chunk[-SCAN_OVERLAP:] if SCAN_OVERLAP else b""


def scan_credential_leak(agent_dir: Path) -> None:
    """Defense in depth behind keeping credentials outside the collection tree: the Codex login file
    must not have been collected and no collected byte, including every member of every collected
    tar archive, may contain an OAuth token, the variable assignment or a token field. Every file
    and member is read to its end. Fails CLOSED: a file or archive that cannot be read completely
    is a finding. Raises CredentialLeak naming files only, never content."""
    if not agent_dir.exists():
        return
    hits: list[str] = []
    for f in sorted(agent_dir.rglob("*")):
        if f.is_symlink() or not f.is_file():
            continue
        rel = str(f.relative_to(agent_dir))
        if rel.startswith("codex-home/") and f.name.startswith("auth.json"):
            hits.append(rel)
            continue
        if f.name.endswith(".partial"):  # a cut archive build: its bytes cannot be inspected as an archive
            hits.append(f"{rel} (partial archive, not inspectable)")
            continue
        try:
            with f.open("rb") as fh:
                leaked = _stream_leak(fh)
        except OSError as exc:
            hits.append(f"{rel} (unreadable: {type(exc).__name__})")
            continue
        if leaked:
            hits.append(rel)
            continue
        if f.suffix in (".tgz", ".gz", ".tar") or f.name.endswith(".tar.gz"):
            try:
                with tarfile.open(f, "r:*") as tf:
                    for m in tf:
                        if m.name.rsplit("/", 1)[-1].startswith("auth.json"):
                            hits.append(f"{rel}:{m.name}")
                            continue
                        if not m.isfile():
                            continue
                        ex = tf.extractfile(m)
                        if ex is not None and _stream_leak(ex):
                            hits.append(f"{rel}:{m.name}")
            except (OSError, tarfile.TarError, EOFError) as exc:
                hits.append(f"{rel} (archive not completely inspectable: {type(exc).__name__})")
    if hits:
        raise CredentialLeak("credential material in collected artifacts: " + ", ".join(hits[:20]))


def check_a0_isolation(agent_dir: Path) -> str:
    """A0's isolation state, checked here rather than live in-container. A shell/Node one-liner
    doing this live went through six review rounds (25-30) that each closed one text-parsing,
    TOCTOU or filesystem-portability gap only to expose a narrower one -- none of it ever touching
    an actual benchmark result. `tar` already has to stat (never just read a directory-entry type
    hint) every member it archives, so its recorded type is reliable regardless of filesystem
    quirks, and its header format needs no shell-style text splitting of a listing at all; this
    reads that archive's own metadata directly, with plain Python and no shell.

    Round 31 caught a real bug in an earlier version of this function: it tolerated ONLY a real
    regular file named `.claude.json`, but a genuinely clean A0 trial's CLAUDE_CONFIG_DIR (verified
    against an actual successful run) also normally holds `.last-cleanup`, `backups/`, `debug/`,
    `policy-limits.json`, `projects/` (session transcripts), `remote-settings.json`, `session-env/`,
    a nested `sessions/`, and `shell-snapshots/` -- all Claude Code's own per-trial bookkeeping
    under a redirected CLAUDE_CONFIG_DIR, none of it storybloq state. The invariant this function
    checks is narrower and matches the ORIGINAL (pre-round-25) design and the pre-launch gate used
    for A1/A2 (`assert_effective_config`, `check_home_after_install`): did STORYBLOQ install itself
    here. That is exactly two things: a non-empty `skills/` directory, or a `settings.json` file at
    the top level (where storybloq's hooks/MCP registration would live). Everything else -- CLI
    housekeeping, `.claude.json` included -- is tolerated regardless of what it is.

    Round 32 (real Codex review) caught two more gaps in that two-thing check: (a) a `skills`
    entry that is a SYMLINK rather than a real directory produces no `skills/...` members at all
    (tar does not follow a symlink into its target), so it would pass as "empty" while pointing
    at an arbitrarily populated directory elsewhere -- only a real directory at that exact path is
    now tolerated; (b) `.claude.json` can itself carry an `mcpServers` registration (Claude Code's
    user-scope MCP config lives there, not only in `settings.json`), so its bare presence is no
    longer tolerated unconditionally: if it parses as JSON with an `mcpServers` object, every
    server's identity fields are checked for the word "storybloq" (case-insensitive); a file that
    fails to parse as JSON, or whose size exceeds a sane bound, is a violation rather than
    silently skipped, since an unreadable/oversized file could be hiding exactly this.

    Round 33 (real Codex review) caught two more gaps in (b): (c) `.claude.json` can ALSO carry
    project-scoped registrations under `projects.<path>.mcpServers`, not only the top-level
    `mcpServers` object -- every project entry's `mcpServers` is now checked the same way; (d) the
    original check serialized the ENTIRE server config (including arbitrary `env` values) and
    substring-matched it, so an unrelated server with an incidental env value like
    `PROJECT_NAME=storybloq` would false-positive -- the check now only looks at identity/execution
    fields (server name, `command`, `args`, `url`, `type`), never `env` or other free-form config.

    Returns "ok" (none of the things below is present), "isolation-violated" (a populated or
    symlinked `skills`, a `settings.json`, or a storybloq MCP registration -- top-level or
    project-scoped -- inside `.claude.json`), or "unknown" (the artifact is missing, empty, or not
    a readable, complete archive -- failing closed, never silently "ok")."""
    f = agent_dir / "config-dir.tgz"
    if not f.is_file() or f.stat().st_size == 0:
        return "unknown"
    try:
        with tarfile.open(f, "r:*") as tf:
            members = tf.getmembers()
            claude_json_member = next((m for m in members if (m.name[2:] if m.name.startswith("./") else m.name) == ".claude.json"), None)
            claude_json_bytes = None
            if claude_json_member is not None and claude_json_member.isfile() and claude_json_member.size <= 1_000_000:
                ex = tf.extractfile(claude_json_member)
                claude_json_bytes = ex.read() if ex is not None else None
    except (OSError, tarfile.TarError, EOFError):
        return "unknown"
    unexpected = []
    for m in members:
        name = m.name[2:] if m.name.startswith("./") else m.name
        if name in ("", "."):
            continue  # the archived directory's own top-level entry, not a content entry
        if name == "settings.json":
            unexpected.append(name)
        elif name == "skills":
            if not m.isdir():  # a symlink or file here hides its true, unarchived contents
                unexpected.append(f"{name} (not a real directory)")
        elif name.startswith("skills/"):
            unexpected.append(name)
        elif name == ".claude.json":
            if claude_json_bytes is None:  # too large or unreadable: cannot be verified clean
                unexpected.append(f"{name} (not verifiably clean)")
            else:
                try:
                    data = json.loads(claude_json_bytes)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    unexpected.append(f"{name} (not valid JSON)")
                else:
                    hit = _find_storybloq_mcp_server(data.get("mcpServers") if isinstance(data, dict) else None)
                    if hit is not None:
                        unexpected.append(f"{name} (mcpServers.{hit})")
                    else:
                        projects = data.get("projects") if isinstance(data, dict) else None
                        if isinstance(projects, dict):
                            for project_path, project_cfg in projects.items():
                                if not isinstance(project_cfg, dict):
                                    continue
                                hit = _find_storybloq_mcp_server(project_cfg.get("mcpServers"))
                                if hit is not None:
                                    unexpected.append(f"{name} (projects.{project_path}.mcpServers.{hit})")
    return "isolation-violated" if unexpected else "ok"


def _find_storybloq_mcp_server(servers: Any) -> str | None:
    """First server name in `servers` (an `mcpServers`-shaped mapping) that names storybloq via
    its identity/execution fields (name, command, args, url, type) only -- never `env` or other
    free-form config, since those can hold arbitrary unrelated values (round 33: a non-storybloq
    server's env containing e.g. `PROJECT_NAME=storybloq` must not false-positive)."""
    if not isinstance(servers, dict):
        return None
    for server_name, cfg in servers.items():
        identity_fields: list[Any] = [server_name]
        if isinstance(cfg, dict):
            identity_fields.extend(cfg.get(k) for k in ("command", "args", "url", "type") if k in cfg)
        haystack = json.dumps(identity_fields)
        if "storybloq" in haystack.lower():
            return server_name
    return None


RATE_LIMIT_MARKERS = ("rate limit", "rate_limit", "usage limit", "usage_limit", "429", "overloaded")


def rate_limited(stream: dict[str, Any] | None) -> bool:
    """Subscription runs are rate-limit bound: a 429 or usage-limit stop is a protocol event."""
    if not stream:
        return False
    if stream.get("api_error_status") == 429:
        return True
    text = " ".join(str(stream.get(k) or "") for k in ("result", "terminal_reason", "error")).lower()
    return stream.get("is_error") is True and any(m in text for m in RATE_LIMIT_MARKERS)


def parse_stream_result(claude_txt: Path, diags: list[str]) -> dict[str, Any] | None:
    """Final {"type":"result"} event from claude-code.txt, or None when absent (timeout)."""
    if not claude_txt.exists():
        return None
    last = None
    scratch: list[str] = []
    for rec in _iter_jsonl(claude_txt, scratch, "claude-code.txt"):
        if rec.get("type") == "result":
            last = rec
    return last


def _read_json(path: Path, diags: list[str], label: str) -> Any:
    if not path.exists():
        return None
    try:
        v = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
        diags.append(f"{label}-unreadable:{type(exc).__name__}")
        return None
    return v


@dataclass
class Row:
    task: str
    arm: str
    attempt: int
    statuses: dict[str, str]
    pass_: bool | None
    reward: float | None
    wall_clock_s: float | None
    executor: dict[str, dict[str, int]]
    reviewer: dict[str, dict[str, int]]
    executor_coverage: str   # complete | incomplete | none | unpriceable
    reviewer_coverage: str   # complete | verified-zero | incomplete | missing | n/a
    started: bool | None     # started.json present; None when neither marker nor result exists
    context_at_exit: int | None
    review_rounds: int
    reviewer_attempts: int
    exit_state: str | None
    harness_cost_usd: float | None
    versions: dict[str, Any]
    diagnostics: list[str]

    def to_json(self) -> dict[str, Any]:
        d = self.__dict__.copy()
        d["pass"] = d.pop("pass_")
        return d

    @property
    def key(self) -> str:
        return f"{self.task}:{self.arm}:{self.attempt}"


def _wall_clock(result: dict[str, Any]) -> float | None:
    ae = result.get("agent_execution") if isinstance(result.get("agent_execution"), dict) else None
    if not ae:
        return None
    from datetime import datetime
    try:
        s = datetime.fromisoformat(str(ae.get("started_at")).replace("Z", "+00:00"))
        e = datetime.fromisoformat(str(ae.get("finished_at")).replace("Z", "+00:00"))
        return (e - s).total_seconds()
    except (TypeError, ValueError):
        return None


def missing_row(task: str, arm: str, attempt: int = 1) -> Row:
    """A scheduled trial with no output directory or no result.json: stays visible, flagged."""
    st = {"infra": "unknown", "agent": "missing", "verifier": "missing", "telemetry": "missing", "compliance": "unknown", "collection": "missing"}
    return Row(task, arm, attempt, st, None, None, None, {}, {}, "none", "n/a", None, None, 0, 0, None, None, {}, ["no-trial-output"])


def parse_trial(trial_dir: Path, arm: str, instruction: str | None = None, attempt: int = 1) -> Row:
    agent_dir = trial_dir / "agent"
    scan_credential_leak(agent_dir)
    diags: list[str] = []
    result = _read_json(trial_dir / "result.json", diags, "result")
    if not isinstance(result, dict):
        result = {}
        if "result-unreadable" not in ",".join(diags):
            diags.append("no-result")
    task = str(result.get("task_name") or trial_dir.name.split("__")[0])
    versions = _read_json(agent_dir / "versions.json", diags, "versions")
    versions = versions if isinstance(versions, dict) else {}
    statuses: dict[str, str] = {"infra": "ok", "agent": "completed", "verifier": "ok", "telemetry": "ok", "compliance": "n/a", "collection": "ok"}

    infra = _read_json(agent_dir / "infra-failure.json", diags, "infra-marker")
    started = (agent_dir / "started.json").exists()
    exc = result.get("exception_info") if isinstance(result.get("exception_info"), dict) else None
    if isinstance(infra, dict) and not started:
        statuses["infra"] = str(infra.get("reason") or "unknown")
        statuses["agent"] = "not-started"
    else:
        if isinstance(infra, dict) and started:
            diags.append("infra-marker-after-start")
        if not started:
            diags.append("start-unknown")  # no marker either way: build() refuses to classify this trial
        if exc:
            et = str(exc.get("exception_type") or "")
            msg = str(exc.get("exception_message") or "")
            statuses["agent"] = "timeout" if ("Timeout" in et or "timed out" in msg) else f"error:{et or 'unknown'}"
        elif not result:
            statuses["agent"] = "missing"

    vr = result.get("verifier_result") if isinstance(result.get("verifier_result"), dict) else None
    reward: float | None = None
    passed: bool | None = None
    if vr and isinstance(vr.get("rewards"), dict) and "reward" in vr["rewards"]:
        raw = vr["rewards"]["reward"]
        if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(float(raw)) or float(raw) not in (0.0, 1.0):
            statuses["verifier"] = "invalid"
            diags.append(f"reward-out-of-domain:{raw!r}")
        else:
            reward = float(raw)
            passed = reward == 1.0
    else:
        statuses["verifier"] = "missing"
    if statuses["infra"] != "ok":
        reward, passed, statuses["verifier"] = None, None, "skipped"  # nothing ran; a verifier result here is not a trial outcome
    # ISS-1200: A1-A4 run 13-17 min against regex-log's 900s [agent] timeout_sec; a trial that
    # solves and cleans up before harbor's own AgentTimeoutError finalizes it is not a real
    # timeout. Both reward AND the full cleanup set (only A1-A4 write these) are required --
    # a reward alone could belong to a verifier that ran without agent cleanup ever completing.
    if arm != "A0" and statuses["agent"] == "timeout" and reward is not None and all(
        (agent_dir / f).exists() for f in ("versions.json", "story.tgz", "story-status.json", "story-sessions.json")
    ):
        statuses["agent"] = "timeout-after-completion"

    ce = _read_json(agent_dir / "collect-errors.json", diags, "collect-errors")
    if isinstance(ce, list) and ce:
        statuses["collection"] = "error:" + ",".join(str(e.get("step")) for e in ce if isinstance(e, dict))
    elif (agent_dir / "collect-errors.json").exists() and not isinstance(ce, list):
        statuses["collection"] = "error:unreadable"

    claude = parse_claude_sessions(agent_dir / "sessions") if started else ClaudeUsage(coverage="none")
    diags += claude.diagnostics
    story = parse_story(agent_dir) if arm != "A0" else StoryState()
    diags += story.diagnostics
    codex = parse_codex_home(agent_dir / "codex-home") if arm in ("A2", "A4") else CodexUsage(coverage="n/a")
    diags += codex.diagnostics

    executor_coverage = claude.coverage
    if executor_coverage == "complete" and claude.unpriceable:
        executor_coverage = "unpriceable"
    created_ticket_id = versions.get("ticket_id") if isinstance(versions.get("ticket_id"), str) else None
    guide_invoked = check_guide_invoked(agent_dir, story, created_ticket_id) if (arm != "A0" and started) else None
    if arm in ("A2", "A4"):
        codex_rounds = [r for r in story.rounds if r.get("reviewer") == "codex"]
        if codex.coverage == "complete":
            reviewer_coverage = "complete"
        elif codex.coverage == "incomplete":
            reviewer_coverage = "incomplete"
        elif codex.coverage == "none" and "no-codex-rollouts" in codex.diagnostics and not codex_rounds and _story_state_complete(story):
            reviewer_coverage = "verified-zero"  # readable session state with no codex round, and no rollout file at all
        else:
            reviewer_coverage = "missing"
        ids = {r.get("reviewerSessionId") for r in codex_rounds}
        correlated = [i for i in ids if isinstance(i, str) and codex.rollouts.get(i, {}).get("responses", 0) > 0]
        # ISS-1198: a trial that never invoked the guide never ran the review loop at all, no
        # matter what story.rounds or the Codex rollout appear to show -- this takes priority
        # over the reviewed/no-review distinction below, which presupposes the guide ran.
        statuses["compliance"] = "guide-not-invoked" if not guide_invoked else ("reviewed" if correlated else "no-review")
    else:
        reviewer_coverage = "n/a"
        if guide_invoked is not None:  # arm != A0 and started
            statuses["compliance"] = "ok" if guide_invoked else "guide-not-invoked"
    if arm == "A0":
        statuses["compliance"] = check_a0_isolation(agent_dir)

    if instruction is not None and arm != "A0" and started:
        if story.ticket_description is None:
            diags.append("ticket-description-missing")
        elif story.ticket_description != instruction:
            diags.append("ticket-description-mismatch")

    stream = parse_stream_result(agent_dir / "claude-code.txt", diags)
    harness_cost = float(stream["total_cost_usd"]) if stream is not None and isinstance(stream.get("total_cost_usd"), (int, float)) and not isinstance(stream.get("total_cost_usd"), bool) else None
    if rate_limited(stream):
        statuses["rate_limit"] = "rate-limited"  # protocol event: the subscription throttled the run; the row stays a started trial

    heads = sorted({d.split(":", 1)[0] for d in diags})
    if heads:
        statuses["telemetry"] = "issues:" + ",".join(heads)
    return Row(
        task=task, arm=arm, attempt=attempt, statuses=statuses, pass_=passed, reward=reward,
        wall_clock_s=_wall_clock(result),
        executor={m: u.as_dict() for m, u in claude.per_model.items()},
        reviewer={m: u.as_dict() for m, u in codex.per_model.items()},
        executor_coverage=executor_coverage, reviewer_coverage=reviewer_coverage,
        started=started if (started or infra is not None or result) else None,
        context_at_exit=claude.context_at_exit,
        review_rounds=len(story.rounds),
        reviewer_attempts=sum(1 for r in codex.rollouts.values() if r["responses"] > 0),
        exit_state=story.exit_state or story.status,
        harness_cost_usd=harness_cost,
        versions=versions,
        diagnostics=diags,
    )


def load_prices(path: Path) -> dict[str, dict[str, float]]:
    data = json.loads(path.read_text())
    return {k: v for k, v in (data.get("models") or {}).items() if isinstance(v, dict)}


def cost_usd(per_model: dict[str, dict[str, int]], prices: dict[str, dict[str, float]], provider: str) -> tuple[float | None, list[str]]:
    """Returns (cost, unknowns) for OBSERVED usage. Cost is None when any model or dimension is
    unpriced or when there is no usage at all (an empty map is not a known zero; the caller
    decides from coverage whether zero was verified)."""
    if not per_model:
        return None, ["no-usage"]
    total = 0.0
    unknown: list[str] = []
    dims = ANTHROPIC_DIMS if provider == "anthropic" else OPENAI_DIMS
    for model, u in per_model.items():
        p = prices.get(model)
        if p is None:
            unknown.append(f"model:{model}")
            continue
        missing = [d for d in dims if d not in p]
        if missing:
            unknown.append(f"dims:{model}:{','.join(missing)}")
            continue
        m = 1_000_000
        if provider == "anthropic":
            total += (u["input"] * p["input"] + u["cache_read"] * p["cache_read"] + u["cache_write_5m"] * p["cache_write_5m"] + u["cache_write_1h"] * p["cache_write_1h"] + u["output"] * p["output"]) / m
        else:
            total += ((u["input"] - u["cached_input"]) * p["input"] + u["cached_input"] * p["cached_input"] + u["output"] * p["output"]) / m
    if unknown:
        return None, unknown
    return total, []


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("trial_dir")
    ap.add_argument("--arm", required=True)
    ap.add_argument("--instruction-file")
    a = ap.parse_args()
    instr = Path(a.instruction_file).read_text() if a.instruction_file else None
    print(json.dumps(parse_trial(Path(a.trial_dir), a.arm, instr).to_json(), indent=2))
