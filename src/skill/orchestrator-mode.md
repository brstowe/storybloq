# Orchestrator Mode

This file is referenced from SKILL.md for `/story orchestrate`. It instructs the main session to act as an **orchestrator/pen**: durable state lives in storybloq, implementation runs in background subagents (a tier below the session model when the client offers one), adversarial review gates run at or above the session model, and the main context holds only conclusions.

## The two planes

Storybloq is the durable STATE plane, background agents are the ephemeral EXECUTION plane, and the main session is the pen. Every storybloq unit maps to an orchestration role:

| storybloq unit | orchestration role |
|---|---|
| ticket / issue | the unit of work an agent receives -- one pipeline run each |
| enriched description | the portable, byte-verified spec (it carries the context so the implementer does not have to) |
| note | ratified owner constraints + decision briefs, injected verbatim into prompts |
| lesson | compounding rails, injected at every context load via the digest |
| handover | crash-safe loop boundary -- the re-entry point after any disruption |
| snapshot | diff baseline so recaps stay meaningful |
| sizing (free-text convention, see below) | the labor-scheduling signal inside the enriched description |

Recovery falls out for free: after any disruption, re-entry is "read the ledger, verify against git, continue." The ledger is the program counter.

## When to use

- The project is a storybloq **orchestrator** (federation `nodes` configured in `.story/config.json`), or a single repo with a large multi-ticket backlog the user wants driven autonomously.
- The user invoked `/story orchestrate` -- that invocation is the explicit opt-in to multi-agent orchestration (see the capability matrix below), confirmed for scope and scale in Step 1. Orchestration is never inferred from a large backlog alone.
- NOT for single-ticket collaborative work, and NOT a replacement for `/story auto` (the guide-driven state machine). Orchestrate replicates the guide's pipeline manually: it folds the guide's WRITE_TESTS and TEST stages into IMPLEMENT (the enriched spec's ACCEPTANCE carries the test plan; RED->GREEN is proven inside the stage and re-derived at byte-review), and it adds an enrichment stage plus two verification stages.

### What your client must support

Requirements are stated as tools the client exposes. Orchestrate keys off what is available:

| Client capability | Orchestrate runs as |
|---|---|
| Claude Code v2.1.154 or newer with dynamic workflows (all paid plans; terminal, desktop, IDE, web, and the Agent SDK) | Full orchestrate: waves as dynamic-workflow scripts, parallel per-repo pipelines, per-subagent `model` overrides, resumable runs. |
| Claude Code with subagents only (no dynamic workflows) | The same 6-stage pipeline dispatched as individual subagents from the main session. No script determinism and no cache-resume, but gates, enrichment, sizing, and one-pen rules are identical. This is a first-class path, not a footnote. |
| Any client, via `storybloq dispatch` | Product-native background sessions (built on the documented `claude --bg` background-sessions flag) running `/story auto` through the guide state machine -- no harness agent tooling needed. No per-item model tiering yet: `dispatch` does not expose a model flag (planned follow-up). |
| No agent capability at all | Refuse orchestrate cleanly and point the user at `/story auto`. |

`/story orchestrate` is your explicit opt-in to multi-agent orchestration; the skill directs Claude to run the waves as dynamic workflows. If your Claude Code version does not accept skill-directed workflows, the documented triggers are including the word ultracode in your prompt or setting `/effort ultracode` for the session (a session-only setting -- this skill mentions it, never requires it). Expect scale: an enrichment pass plus a wave can spawn dozens of agents, and token usage scales accordingly.

## Step 1: Active-session guard + opt-in (REQUIRED, before anything else)

SKILL.md Step 0.5 has already run for the orchestrator project itself. It does NOT cover federation nodes: the orchestrator's `storybloq_status` never scans node repos for sessions, and only the ticket/issue read tools accept the `node` parameter. So:

1. Call `storybloq_node_list` to enumerate the nodes.
2. For EACH node, check for an active session directly: list the node's `.story/sessions/` directory, or run `storybloq status` via Bash with the node's path as the working directory and look for the `## Active Sessions` heading.
3. If ANY node has an active session, REFUSE to start. One pen per repo. Surface the node and session to the user via `AskUserQuestion` (options: Monitor / Proceed excluding that node / Abort). Never dispatch any agent into a node that has an active session, even if the user proceeds elsewhere.
4. Only then confirm scope and scale via `AskUserQuestion`: "Orchestrate will run an enrichment pass plus waves that can spawn dozens of background agents across <N> repos, some possibly on a cheaper tier, and will push at wave boundaries. Proceed?" Options: Proceed / Scope to one repo / Cancel. Invoking `/story orchestrate` was the opt-in to multi-agent orchestration; this question confirms the blast radius (repos, scale, pushes) before any agent is dispatched.

This guard has precedence over every "do not ask the user" rule in this file, exactly as in `autonomous-mode.md`. `maxTicketsPerSession` does NOT apply to orchestrate; the user-visible unit of scope is the wave -- its contents are presented at planning and re-presented in every wave-boundary handover.

## Model economy: where judgment lives

Tiering is BIDIRECTIONAL and relative to whatever model the session runs -- no specific pairing is assumed. Labor de-escalates below the session model; judgment ESCALATES above it when the user's plan offers a stronger tier. This is a design principle, not a cost tip:

- **HANDS = one tier below the session model, when the client offers one.** XS/S/M implementation against an enriched spec, structured-output breadth scans, fix rounds, batched ships -- the stages that follow a spec.
- **INSPECTOR = the strongest reasonably available tier, never below the session model.** PLAN_REVIEW, CODE_REVIEW/BYTE-REVIEW, release-gate audits, security and design decisions, and L-sized or risk-flagged implementations (auth, RLS, money paths, anything that can brick login or deploys) run here -- routed UP via per-call model overrides when a stronger tier than the session default is available.
- **The PEN = the session model.** The orchestration loop itself (wave planning, acceptance, ledger writes) stays at the session tier, because it IS the session.

The asymmetry is the safety property: cheaper hands, same-or-stronger inspector. Two invariants hold in every configuration:

1. **The reviewer is never a cheaper model than the implementer.**
2. **The session model is the FLOOR for judgment, not the ceiling:** judgment runs at the strongest reasonably available tier and never below the session model; labor may run below it.

| Your session model | HANDS | INSPECTOR |
|---|---|---|
| Top tier | one tier down (e.g. Opus) | the session model (gates simply inherit) |
| Mid tier (e.g. Opus or Sonnet) | one tier down (e.g. Sonnet or Haiku), or the same tier | route gates up to the stronger tier when available; otherwise the session model |
| Single-model client, or no other tier | the session model | the session model |

Model names above are illustrative only; no rule in this file names a model. In the last row the pattern is STILL worth running: the value is the structure -- the enrichment pass, byte-verified gates, one pen per repo, batched ships -- not just the cost asymmetry. Upward routing depends on the stronger tier being available on the user's plan; when it is not, judgment stays at the session tier and the cross-model `reviewBackends` leg carries the independence. In-product precedent: storybloq's own lens system already does this -- `lensConfig.lensModels` defaults the security and concurrency lenses to a stronger tier than the default lens model, because those are judgment lenses.

- **An audit or review agent runs at the inspector tier when its task is judgment,** even when it looks like fan-out labor. Pinning a reviewer below its implementer's tier to save tokens is the classic misuse.
- **The inverse misuse is running plumbing at the inspector tier.** An agent that merely drives a tool -- generates a diff, calls an MCP endpoint, relays prompts or output -- is labor no matter how important the pipeline it serves: the judgment lives in the tool and the prompt, not the driver. Prepare steps, review-backend drivers, and mergers run at the hands tier; only the judges and adversarial reviewers inherit the inspector tier. Burning inspector budget on drivers is how sessions hit limits mid-gate.
- **Sizing classifies the LABOR; risk flags classify the JUDGMENT.** Judgment never gets downgraded.
- The riskiest items get a staged rollout (audit -> shadow -> enforce): the first pass ships only observe-only stages; enforcement ships separately after shadow evidence. The plan states the stage boundary explicitly.

Shipped vs convention: there is no `recipeOverrides.stages.*.model` config key. Tiering is done with per-subagent `model` overrides (a per-call parameter, or the agent definition's model frontmatter); omitting the override inherits the session model, the judgment floor. Downgraded hands are only safe AFTER the enrichment pass below -- a weaker model on a stale spec produces confident nonsense; the same model on a byte-verified spec with the inspector behind it produces shippable work.

## The enrichment pass (run once per wave, before dispatching hands)

There is no `storybloq enrich` command; the pass is a hand-authored fan-out of read-only **verify-and-enrich** agents over the wave's items. They touch no code and commit nothing; their only writes are storybloq updates to their assigned items. Enrichment matters MORE as the hands get cheaper; when hands run at the session tier it still pays -- smaller specs, less drift, fewer wasted runs. For each item:

1. **Byte-verify every claim at current HEAD.** Backlogs rot: re-derive line numbers, confirm each gap still exists, check whether the work already shipped (fully or partially).
2. **Classify:** `valid-enriched` / `partially-done-rescoped` (name what shipped, with the commit) / `recommend-close` (evidence only -- the orchestrator closes, never the agent).
3. **Rewrite into the junior-proof template** below. The enriched text IS the spec; implementer prompts collapse to "read the item, follow it, stop if reality differs from VERIFIED STATE."
4. **Write with read-modify-write, never blind.** `storybloq_ticket_update` with `{ "id": "T-310", "description": "<full new text>" }` REPLACES the description wholesale. Read the item first (`storybloq_ticket_get`), carry the full prior text into HISTORY, and re-read immediately before writing.
5. **Issues have NO description field.** Enrichment for issues targets `impact`: `storybloq_issue_update` with `{ "id": "ISS-042", "impact": "<enriched impact incl. template + HISTORY>" }`. Leave `resolution` for the eventual fix. Same read-modify-write discipline via `storybloq_issue_get`.
6. **Never enrich items belonging to a wave whose chain is currently running.** Read-only in code is not write-safe in the ledger; enrich between waves, or only items scheduled for future waves.

Template (SIZING is a free-text convention; there is no `ticket.sizing` field):

```
CONTEXT: <what + why, 2-3 sentences>
VERIFIED STATE @ <sha> (<date>): <exact file:line facts, re-derived at HEAD, that a weaker model can trust>
SCOPE: <numbered concrete steps, each naming exact files; smallest-correct-change bias>
OUT OF SCOPE: <explicit list -- the fence for eager models>
ACCEPTANCE: <testable criteria + test plan (suites, NEW tests, RED-without-the-change expectation)>
PITFALLS: <repo-specific hazards: deploy-on-push, drift gates, ratified postures, secrets>
VERIFICATION: <what the post-ship probe must show on production bytes>
SIZING: XS | S | M | L
HISTORY: <the full prior text, quoted -- descriptions are corrected additively, never clobbered>
```

## Sizing -> scheduling

- **XS/S/M** -> hands. **L or risk-flagged** -> the inspector tier. Review gates run at the inspector tier for all of them.
- Order waves **smallest-first** so progress banks early and an interruption costs the least.
- **Batch ships:** collect ~3 review-clean items per ship (one push, one deploy, per-item live verification from each spec's VERIFICATION section). A risky item always ships alone, fenced by a ship immediately before and after it.

## How it works

1. **Context load.** `storybloq_status` -> `storybloq_recap` -> `storybloq_handover_latest` with `{ "count": 3 }` -> read `RULES.md` -> `storybloq_lesson_digest` -> `git log --oneline -10`. Federation: `storybloq_node_list`.
2. **Ground-truth scouts.** Never trust ledger state; verify it. Dispatch one read-only scout per node/repo: git state (branch, HEAD, ahead/behind, dirty files), open tickets/issues, latest 3 handovers summarized. Scouts read the node's `.story/` files DIRECTLY -- handover, note, and lesson reads have no `node` parameter; only `storybloq_ticket_list`/`_get` and `storybloq_issue_list`/`_get` accept `node`. Reconcile scout reports against the orchestrator ledger and file corrections BEFORE planning (stale blocker edges, already-done "open" items, unfiled follow-ups).
3. **Wave planning.** Group actionable work into waves by (repo, dependency, theme). One wave per repo at a time; waves in different repos may run in parallel; severity and time-sensitivity first; owner-gated items go on the register (step 8), never into a wave.
4. **Enrichment pass** for the wave (section above), then assign models by sizing and risk.
5. **Execute the wave as a dynamic workflow** running the 6-stage pipeline per item (below), with per-item model assignment. The orchestrator does not implement; it launches, accepts, and verifies.
6. **Accept via the byte-review verdict, never the implementer's report.** On wave completion: read the reports, file every follow-up the agents surfaced (agents report, the orchestrator files -- check the node's existing items first, concurrent duplicates are the failure mode), close recommend-close items with evidence.
7. **Wave boundary:** `storybloq_snapshot`, then `storybloq_handover_create` (deltas + evidence + owner-gate register + next wave), then commit and push every touched ledger. Node-scoped MCP writes land UNCOMMITTED in the node's tree -- sweep them into a commit here.
8. **Owner-gate register** in every handover: decisions awaiting ratification, external errands, posture sign-offs. Per gated decision: a decision-brief note (file:line evidence, options, exact proposed ratification text), real blocker edges via `crossNodeBlockedBy` with qualified IDs (`orchestrator:T-XXX`, never bare). On ratification: log it, lift the edges, inject the ratified text verbatim into implementer prompts, and make deviation from it a BLOCKING review finding.
9. **Loop** to the next wave until every node's agent-actionable queue is empty. Session end: lessons via `storybloq_lesson_create` / `storybloq_lesson_reinforce`, including lessons that supersede a disproven lesson in place, with the evidence.

## Review backends

PLAN_REVIEW and CODE_REVIEW/BYTE-REVIEW SHOULD use the project's configured backends: `recipeOverrides.reviewBackends` in `.story/config.json`, with per-stage `stages.PLAN_REVIEW.backends` / `stages.CODE_REVIEW.backends` taking precedence. When codex is configured (via codex-bridge), use it -- a second model with different training catches what the authoring model is blind to. Inspector-tier adversarial subagents are the fallback when no backend is configured, and the second leg alongside codex: byte-verifying the report against repo reality is their job even when codex has reviewed the diff. On modest session tiers with no stronger tier to route up to, lean HARDER on the cross-model leg: reviewer independence compensates for tier.

## The 6-stage per-item pipeline (inside dynamic workflows)

1. **PLAN** *(hands; inspector tier for L/risk)* -- read the enriched item + cited notes + the ACTUAL code; re-verify VERIFIED STATE with cheap greps; write a markdown plan: exact edits, tests, migration/deploy safety, post-deploy probe, explicit out-of-scope.
2. **PLAN_REVIEW** *(inspector tier / configured backends)* -- verify the plan implements SCOPE exactly, stays out of OUT OF SCOPE, meets ACCEPTANCE, respects every PITFALL. Verdict `approve`/`revise`; on revise, one revision round addressing EVERY finding (address or rebut in the plan text).
3. **IMPLEMENT** *(hands; inspector tier for L/risk)* -- follow the approved plan exactly (deviations justified in the report). Full suite green with counts before/after; at least one proven RED->GREEN. Item status updated via storybloq CLI in the same commit as the code. Commit locally; do NOT push.
4. **CODE_REVIEW + BYTE-REVIEW** *(inspector tier / configured backends -- this verdict gates the ship)* -- byte-verify the REPORT against repo reality: commits exist as described, RED->GREEN re-derived (not trusted), logs show real EXECUTED test counts (runner totals include skips; subtract them), ledger matches bytes, no invented wire/contract codes. On revise: fix round -> re-review; still dirty -> stop the chain and return to the orchestrator.
5. **SHIP** *(hands, batched)* -- fetch first; push; watch CI + deploy to conclusion; live-verify health plus each shipped item's VERIFICATION section against production bytes. Deploy failure -> documented remediation only, never a blind retry.
6. **PROBE-LOOP** -- exercise the real production path; verify actual bytes/artifacts, never status codes; fix the root layer; LOCK every probe as a regression test or a documented manual-probe checklist entry. Cheap probes fold into stage 5's live-verify; anything unprobeable is stated as an honest boundary with its test-lock named.

XS/chore items may collapse stages 1-2 into the implementation prompt, DISCLOSED (the report states the 5-line plan). No stage is ever skipped silently.

## Dynamic-workflow skeleton (tiered models)

```js
const HANDS = '<one tier below the session model>'         // single-model client: set to undefined -> everything runs at the session tier
const INSPECTOR = undefined                                // undefined -> the session model (the floor); set to a stronger tier when the plan offers one
const ITEMS = [
  { id: 'ISS-201', collapsed: true },                      // XS -> hands, plan collapsed (disclosed)
  { id: 'T-310' },                                         // S/M -> hands plan + implement
  { id: 'T-295', judgment: true, risky: true },            // L / risk-flagged -> inspector-tier implementer
]
let shipQueue = []
for (const it of ITEMS) {                                  // sequential: same repo = one pen
  const exec = it.judgment ? INSPECTOR : HANDS             // undefined model -> inherit the session model
  let plan = it.collapsed ? null
    : await agent(planPrompt(it), { label: `plan:${it.id}`, schema: PLAN, model: exec })
  if (plan) {
    const pr = await agent(planReviewPrompt(it, plan), { label: `plan-review:${it.id}`, schema: REVIEW, model: INSPECTOR })
    if (pr.verdict === 'revise') plan = await agent(revise(plan, pr.findings), { schema: PLAN, model: exec })
  }
  const impl = await agent(implementPrompt(it, plan), { label: `impl:${it.id}`, schema: RESULT, model: exec })
  const review = await agent(byteReviewPrompt(it, impl), { label: `byte-review:${it.id}`, schema: REVIEW, model: INSPECTOR })
  if (review.verdict === 'revise') { /* fix round (exec) -> re-review (inspector); still dirty -> break */ }
  shipQueue.push(it.id)
  if (shipQueue.length >= 3 || isLast(it) || it.risky) {   // batched ships; risky items deploy alone
    const ship = await agent(shipPrompt(shipQueue), { label: `ship:${shipQueue.length}`, schema: RESULT, model: exec })
    shipQueue = []
    if (!ship || ship.status === 'blocked') break          // stop for the orchestrator
  }
}
```

Waves in different repos: wrap per-repo chains in `parallel([...])`. The enrichment pass is its own earlier run: `parallel(GROUPS.map(g => () => agent(enrichPrompt(g), { schema: OUT })))` -- read-only in code, ledger-writes only, and only against items outside any running chain's wave.

## Critical rules

- **DO keep one pen per repo.** Never two waves, or an orchestrator edit and a wave, in the same repo concurrently. Read-only scout/enrichment agents are the only exception (with the ledger-write restriction above).
- **DO run the second-pen protocol.** A shared working tree has no private commits: any pen's push publishes ALL local commits, which on a deploy-on-push repo can bypass the ship gate. Before pushing, check `git log origin/main..HEAD` and either wait or explicitly accept carrying the other pen's commits. Ship agents treat origin==HEAD as a verifiable arrival state (check WHAT landed and that CI ran green on that sha), not an anomaly.
- **DO gate every irreversible action on the byte-review verdict.** Nothing pushes to a prod-deploying branch on an implementer's word, regardless of which model implemented. The gates catch real bugs: ISS-767..770 were four confirmed release-gating defects surfaced by this pattern's adversarial reviewers.
- **DO verify-then-trust, including yourself:** `git fetch` before trusting ahead/behind counts; prefer CI/deploy run state over local ref math; after any disruption, verify pen ownership before writing -- the run journals show who holds the pen (L-021).
- **DO recover, never redo.** On dynamic-workflow clients, re-launch a failed run with `resumeFromRunId` (completed agents return cached; only the failed stage re-runs); on subagent or dispatch paths, re-dispatch only the failed stage. If the dead agent left commits, edit the failed stage's prompt into verify-and-complete: byte-verify the inherited commits against the approved plan, run the suites, finish the remainder. If subagent capacity is throttled, the main loop may take over a SHIP stage directly.
- **DO keep the cadence:** snapshot -> handover -> ledger commit+push after every wave loop; owner-gate register in every handover; lessons at session end.
- **DO NOT let agents file or close items.** Agents report; the orchestrator files (after checking existing items) and closes (on evidence).
- **DO NOT let an agent fake its way to done.** Prompts must permit the honest-open off-ramp: "this cannot be completed legitimately -- leave OPEN with a dated disposition note." Never a faked fixture, hand-edited vendored data, or fabricated probe.
- **DO NOT blind-retry a failed deploy or gate.** Expected gate failures get documented remediations spelled out in the ship prompt (for example hash-pinned infra files); anything else stops the chain.
- **DO NOT take over IMPLEMENT in the main loop.** It bloats the orchestrator context; SHIP takeover (push/watch/verify) is the only main-loop-safe substitution.
- **DO NOT leave node writes uncommitted past a wave boundary,** and DO NOT use bare cross-node IDs (`cloud:T-139`, never `T-139`).
- **DO NOT run probes carelessly:** live probes that hit paid APIs state their spend; restore every binding/config a probe touched and verify the restoration.

## Evidence

- 2026-07-02, first in-house run (the 1.5.0 fix train): ISS-767 (XS) and ISS-770 (S) were implemented by hands-tier agents (Opus, in that run) against enriched specs; both passed the session-model byte-review and codex gates cleanly on post-hoc verification. The train was interrupted mid-L-item, and the session model completed that item directly (ISS-768/769). The interruption exercised the disruption-recovery rules for real: `resumeFromRunId` returned completed agents from cache, and pen ownership was re-verified from the run journals before takeover (L-021).
- The T-400 release-gate audits ran as the same pattern -- parallel background auditors returning structured findings, filed by the orchestrator as ISS-775..784.
