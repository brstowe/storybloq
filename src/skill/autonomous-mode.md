# Autonomous & Tiered Modes

This file is referenced from SKILL.md for `/story auto` / `$story auto`, review, plan, and guided commands.

## Autonomous Mode

`/story auto` in Claude Code, or `$story auto` in Codex, starts an autonomous coding session. The guide picks tickets, plans, reviews, implements, and commits -- looping until all tickets are done or the session limit is reached.

**How it works:**

1. Call `storybloq_autonomous_guide` with `{ "sessionId": null, "action": "start", "clientTaskId": "<known-current-task-id>" }` (omit `clientTaskId` only when unavailable)
2. The guide returns an instruction with ticket candidates and exact JSON for the next call
3. Follow every instruction exactly. Call the guide back after each step.
4. The guide advances through: PICK_TICKET -> PLAN -> PLAN_REVIEW -> IMPLEMENT -> CODE_REVIEW -> FINALIZE -> COMPLETE -> loop
5. Continue until the guide returns SESSION_END

**Ticket review depth:** Optional ticket metadata `reviewRisk` accepts `low`, `medium`, or `high` and sets the minimum PLAN_REVIEW depth to one, two, or three rounds. Set it with `storybloq ticket meta set T-001 reviewRisk '"high"'` or `storybloq_ticket_meta_set`. Legacy `risk` metadata remains compatible. Malformed explicit values fail closed to high, and risk metadata never skips a review stage.

**Frontend design:** If the current ticket involves UI, frontend, components, layouts, or styling, read `design/design.md` in the same directory as the skill file for design principles. Load the relevant platform reference from `design/references/`. Apply the priority order (clarity > hierarchy > platform correctness > accessibility > state completeness) during both planning and implementation.

## Precedence: task-aware active-session guard

Before any guide call that could start, resume, or cancel a session, run SKILL.md Step 0.5. Ownership determines the action:

- A matching `ownerTask` is the current pipeline. Continue normally; after COMPACT, resume automatically with the full `sessionId` and current `clientTaskId`.
- An unowned legacy COMPACT session resumes with the current `clientTaskId`; the guide binds it during recovery. A non-COMPACT legacy session stays conservative: Monitor/Other only.
- A different live owner is foreign. Open/message its task, monitor read-only, or work collaboratively on a different item. If it is COMPACT and the user confirms that the owner task is gone, recover with `takeover: true`; takeover never applies outside COMPACT.
- An expired COMPACT session can be resumed here only after explicit selection; successful resume binds the current task.
- Cancellation always requires an explicit cancel request plus exact typed `cancel <T>` confirmation. `<T>` is the shortest unique session-id prefix defined by SKILL.md; guide calls use the full id.

**Critical rules for autonomous mode:**
- Do NOT use client-native plan mode -- write plans as markdown files in `.story/sessions/<id>/plan.md`.
- Do NOT ask the user for confirmation or approval during the normal pipeline. The guard asks only for foreign/recovery choices; same-owner continuation is automatic.
- Do NOT stop or summarize between tickets unless the guide reaches a context-rotation HANDOVER -- otherwise call the guide IMMEDIATELY
- Do NOT wrap autonomous execution in scheduler or automation loops such as Claude Code's `/loop` skill, `ScheduleWakeup`, `CronCreate`, Codex automations, or thread wakeups. The state machine IS the loop: PICK_TICKET -> PLAN -> ... -> COMPLETE -> PICK_TICKET. "Continue immediately" means advance on THIS turn, not schedule a future wakeup. Scheduler and automation tools persist across compactions independent of conversation state, so a scheduled chain can self-perpetuate through compact/resume and keep burning prompt cache + compute; the user has no natural interrupt point because each turn looks like "just one more small close." The only correct pacing is the guide's `report` -> next-action cadence. See ISS-588 for the observed failure mode.
- Follow the guide's instructions exactly -- it specifies which tools to call, what parameters to use
- After each step completes, call `storybloq_autonomous_guide` with `action: "report"`, `clientTaskId` when known, and the results

**Recommended setup for long sessions:**

**Claude Code:** run with a model appropriate to the repo and, only in trusted repositories, `--dangerously-skip-permissions` when unattended execution is intentional. Skip-permissions avoids approval prompts consuming context, but disables safety prompts for all tool use.

**Codex:** use a trusted repo and a sandbox/approval profile that allows the intended edits and test commands. Ensure Storybloq MCP is registered with `STORYBLOQ_CLIENT=codex`, then restart Codex or start a new session after setup or MCP source changes so the live MCP process reloads. Check `/hooks` after setup: Codex requires non-managed command hooks to be reviewed and trusted before they run, so an installed `SessionStart`, `PreCompact`, or `Stop` hook is not necessarily active until trusted. `$story auto` does not require Codex subagents; keep the guide loop in the main thread unless the user explicitly chooses `$story orchestrate`.

**Storybloq preserves compaction automatically** when hooks are installed and trusted, but it cannot invoke the client's user-level compaction command. A real client compaction runs PreCompact and then SessionStart; the same session resumes and pressure resets only when SessionStart confirms `source: compact`. `compactThreshold` (`medium`, `high`, or `critical`) selects both pressure limits and the rotation trigger. If pressure reaches the trigger at a clean COMPLETE boundary without confirmed client compaction, the guide ends the bounded session through HANDOVER.

**For an explicit user-triggered compaction:** In the owning task, call the guide with `action: "pre_compact"` and `clientTaskId`, then have the user run the client's compaction command. Do not call `resume` before the post-compaction SessionStart hook runs. The marker/guard then resumes the same full `sessionId` with `clientTaskId`. No second confirmation is needed when `ownerTask` matches or when migrating an unowned legacy session. A different recorded owner requires confirmation that the old task is gone plus `takeover: true`.

**If something goes wrong:**
- Context feels large -- continue the guide. Do not cancel manually; verified client compaction preserves the session, and threshold pressure rotates through HANDOVER at the next clean boundary.
- Compaction happened -- rerun Step 0.5. If `ownerTask` matches or is absent on a legacy COMPACT session, resume automatically. If the compacted lease expired, ask for `Resume here`; if another live task owns it, open/message that task unless the user explicitly confirms it is gone and requests takeover.
- Session stuck after compact -- inspect with `storybloq_session_report`. A verified same owner may run `storybloq session clear-compact <full-sessionId>` for a stale or blocked marker, then resume that same full id with `clientTaskId`. An expired session still requires explicit recovery selection. Never clear a foreign live lease.
- Unrecoverable error -- `storybloq session stop <sessionId>` is destructive and must never be called bare. Require exact typed `cancel <T>` confirmation, resolve `<T>` to the full id, and stop only that session.

## Targeted Mode

`/story auto T-183 T-184 ISS-077 T-185` starts an autonomous session that works ONLY on the specified items, in order, then ends.

**How it works:**

1. Call `storybloq_autonomous_guide` with `{ "sessionId": null, "action": "start", "targetWork": ["T-183", "T-184", "ISS-077", "T-185"], "clientTaskId": "<known-current-task-id>" }`
2. The guide validates all IDs, filters out already-complete items, and presents only target items as candidates
3. Session works through each item via the standard pipeline (T-XXX through PLAN, ISS-XXX through ISSUE_FIX)
4. Session ends when all targets are done (or all remaining are blocked)

**Behavior details:**
- Session cap is auto-set to the number of targets
- PICK_TICKET only shows target items -- the agent cannot pick non-target work
- Array order is respected -- first unworked item is suggested
- Blocked targets are warned about at start but included (completing earlier targets may unblock them)
- Already-complete targets are filtered out at start with a warning
- Invalid IDs cause a hard error before session creation
- Compact/resume preserves targetWork -- the session continues where it left off
- If all remaining targets are blocked by items outside the list, session ends with an explanation

**Project targets:** a targetWork entry may be a project id from roadmap.projects
(e.g. `/story auto tigris` -> `"targetWork": ["tigris"]`). The guide expands it
in place to the project's remaining leaf tickets (in `order` sequence) followed
by its open issues -- only items whose phase matches the project's phase count.
Completed members are skipped like any other done target; a project with no
assigned items is a hard error. Mixed lists work: `"targetWork": ["tigris", "T-099"]`.
Pass the project id verbatim -- do NOT pre-expand it yourself.

**Use when:**
- Triaging a specific set of high-priority items
- Breaking up work into focused sprints
- Working through a dependency chain in order
- Fixing a cascade of related issues
- Driving a project (roadmap.projects grouping) to completion end-to-end

## Tiered Access -- Review, Plan, Guided Modes

The autonomous guide supports four execution tiers. Same guide, same handlers, different entry/exit points.

### `/story review T-XXX`

"I wrote code for T-XXX, review it." Enters at CODE_REVIEW, loops review rounds, exits on approval.

1. Call `storybloq_autonomous_guide` with `{ "sessionId": null, "action": "start", "mode": "review", "ticketId": "T-XXX", "clientTaskId": "<known-current-task-id>" }`
2. The guide enters CODE_REVIEW -- follow its diff capture and review instructions
3. On approve: session ends automatically. On revise/reject: fix code, re-review
4. After approval, you can proceed to commit -- the guide does NOT auto-commit in review mode

**Note:** Review mode relaxes git constraints -- dirty working tree is allowed since the user has code ready for review.

### `/story plan T-XXX`

"Help me plan T-XXX." Enters at PLAN, runs PLAN_REVIEW rounds, exits on approval.

1. Call `storybloq_autonomous_guide` with `{ "sessionId": null, "action": "start", "mode": "plan", "ticketId": "T-XXX", "clientTaskId": "<known-current-task-id>" }`
2. The guide enters PLAN -- write the implementation plan as a markdown file
3. On plan review approve: session ends automatically. On revise/reject: revise plan, re-review
4. The approved plan is saved in `.story/sessions/<id>/plan.md`

### `/story plan <project-id>` -- Project-level planning

"Help me plan the tigris project." Produces ONE plan document covering the whole
project. This is a document-writing flow, NOT an autonomous session -- do not
call `storybloq_autonomous_guide` for it (plan mode's ticketId requirement is
deliberate; project planning happens outside the state machine).

1. Resolve the project: `storybloq_project_list` (or `storybloq project list`) --
   confirm the id exists and note its phase. If the arg matches no project, treat
   the command as single-ticket plan mode instead.
2. Gather the members: `storybloq_ticket_list` with `project: "<id>"` (and
   `storybloq_issue_list` with `project: "<id>"`). Read each member's description;
   read `storybloq_handover_latest` and any lessons digest for context.
3. Write `.story/plans/project-<id>.md` covering: goal of the project, member
   inventory (tickets in order + issues), sequencing and dependencies (blockedBy
   edges within the project, cross-project blockers), shared design decisions,
   risks, and a recommended `/story auto <project-id>` execution order.
4. Present a summary and offer the follow-up: `/story auto <project-id>` to
   execute the plan.

### `/story guided T-XXX` (deprecated -- alias for targeted auto)

Use `/story auto T-XXX` instead. A single-ticket targeted auto session is equivalent. The guide handler still accepts `mode: "guided"` for backward compatibility but routes to the same targeted auto path.

### All tiered modes:
- Require a `ticketId` -- no ad-hoc review without a ticket in V1
- Use the same review process as auto mode (same backends, same adaptive depth)
- Can be cancelled with `action: "cancel"` at any point

### Code-review landing cap

`recipeOverrides.stages.CODE_REVIEW.maxReviewRounds` defaults to 12. The effective cap is the larger of that value and the ticket risk's required review rounds; `0` explicitly disables the cap. `reject`, plan redirects, and unresolved critical findings remain blocking at any round. At the cap, `revise` or `request_changes` with zero unresolved critical findings advances to FINALIZE and converts unresolved major/minor findings into deduplicated follow-up issues. A `landingDecision.reason` of `max_review_rounds_no_blocking` is an instruction to land the ticket, not reopen implementation. PLAN_REVIEW convergence remains separate.

### Plan-review landing cap and review proportionality

`recipeOverrides.stages.PLAN_REVIEW.maxReviewRounds` (default `0` = disabled) applies the same landing-cap semantics to PLAN_REVIEW: at the cap, `revise`/`request_changes` with zero unresolved critical findings advances to IMPLEMENT and defers remaining major/minor findings as follow-up issues. `reject` and unresolved criticals remain blocking at any round.

Review effort must stay proportional to ticket risk: run ONE reviewer subagent per round (a focused pass for low risk). Do NOT spawn multiple independent reviewers, adversarial panels, or primary-source verification sweeps unless the ticket's risk is high. If a configured reviewer backend (e.g. codex) is unavailable, substitute a single agent review — not a heavier process.

## Review findings and dispositions

When you report a review round (`action: "report"` with `findings`), each finding
carries a `disposition`. The four values are not interchangeable, and one has a
side effect worth knowing before you choose it:

- `open` -- unresolved this round (the round will not converge to approve)
- `addressed` -- fixed in this round
- `contested` -- you judge the finding a false positive. This feeds the false-positive
  learning loop and files no issue. Do NOT use it to park a valid finding you simply
  will not fix now; that pollutes the learning signal.
- `deferred` -- the finding is valid but out of scope for this ticket. This AUTO-FILES
  a storybloq issue so the work is tracked. A `deferred` finding whose severity is the
  canonical lowercase `suggestion` is exempt and is not filed (severity is normalized to
  lowercase before this check, so `Suggestion`/`SUGGESTION` are treated the same). Use
  `deferred` only when you genuinely want a new issue created.

So the rule of thumb: park valid-but-out-of-scope work as `deferred` (it becomes an
issue), and reserve `contested` for genuine false positives.

## Branch Affinity

When running `/story auto` (standard mode, no targetWork), the guide checks if the
current git branch contains a ticket or issue ID (e.g. `story/T-012-rebrand`).

**Behavior:**
- If the branch implies a specific ticket, the candidate list shows it first with a
  `[Branch affinity]` marker. The guide expects you to pick that ticket.
- If you pick a DIFFERENT ticket, the guide blocks the pick and routes to HANDOVER.
  This prevents unrelated commits from contaminating a feature branch.
- If the branch contains multiple IDs (ambiguous), a warning is shown but no blocking
  occurs.

**If mismatch blocking triggers, tell the user:**
> This branch is scoped to {id}. The session will end with a handover.
> To work on other tickets:
> - Switch to `main` and run `/story auto` from there
> - Use targeted mode: `/story auto T-XXX` (skips the branch check)
> - Set `branchStrategy: "per-ticket"` in config (auto-creates branches per ticket)

**When branchStrategy is "per-ticket":**
The guide creates a new branch per ticket automatically. The mismatch check is skipped
because each ticket gets its own branch.

**Targeted mode (`/story auto T-XXX ISS-YYY`):**
Branch affinity is skipped entirely. The targetWork list constrains picks regardless of
branch name.
