# Fork update routine

How to pull a new upstream `storybloq` release into this fork, preserve the
fork's custom features, and deploy. Proven on the 1.13.0 and 1.15.0 merges.

## Layout

- This CLI fork lives at `~/dev/storybloq` (origin = `brstowe/storybloq`,
  upstream = `Storybloq/storybloq`). The working branch is `dev`.
- The global `storybloq` binary symlinks to `~/dev/storybloq/dist/cli.js`.
- The **dashboard** is a separate app at `~/Apps/storybloq` (pm2 process
  `storybloq`, port 3008). It reads `.story/` data directly and shells out to
  the `storybloq` CLI for writes.

## Fork features to preserve

The reason the fork exists — keep these working through every merge:

- Native **projects** + **phase state** (parked phases: pending/paused/skipped).
- **Federation inheritance**: nodes absorb the orchestrator root's lessons/notes.
- **Storyknow** knowledge packs (attached `K-NNN` knowledge, `lesson promote`).
- Project-targeted autonomous/plan flows (`/story auto <project-id>`, project-level plan).
- Four extra MCP tools: `storybloq_phase_update`, `storybloq_project_list/create/update`.
- **Shortcode**: every board's terse handle (`storybloq shortcode get|set|clear`),
  defaulting to the slugified project directory name and overridable by a
  top-level `shortcode` in `.story/config.json`. Identifier only — nothing
  resolves by it. Surfaces as `shortcode` + `shortcodeSource` in full
  `status --format json` (and each node's on its `scanSummary`); the dashboard's
  header field reads and writes it. Two traps when merging: `ConfigSchema`
  declares it a BARE optional string (project-loader `.parse`s, so a regex there
  would throw and break every command that loads a project — resolution fails
  open to the directory default instead), and it must stay OUT of
  `status --compact` (T-320's pinned schema gains no keys, and the priming
  harness hashes two runs from fresh fixture copies in different temp dirs, which
  a directory-derived value cannot survive). `validate` warns on
  `invalid_shortcode` and `duplicate_shortcode`.

## Procedure

1. `cd ~/dev/storybloq && git fetch upstream`. Size it up:
   `git rev-list --left-right --count dev...upstream/main` and
   `git log <merge-base>..upstream/main`.
2. Trial-merge on a safety branch: `git switch -c merge-upstream-<ver> dev`
   then `git merge upstream/main`. List conflicts; resolve preserving fork features.
3. **Don't hand-merge** `plugins/storybloq/skills/story/*` — it's generated.
   Resolve `src/skill/*` (canonical), then regenerate the mirror:
   `npx tsx scripts/sync-plugin-skill.ts`. A drift test
   (`test/core/skill-sync-check.test.ts`) gates the mirror matching the source.
4. **`npm install`** — MANDATORY after the merge. Upstream bumps deps (e.g.
   `@storybloq/lenses`); a stale `node_modules` builds fine but the CLI crashes
   at load with `does not provide an export named ...`.
5. `npm run build` (tsup + DTS).
6. Run tests — see **Testing** below. Targeted subset only.
7. Commit as a real two-parent merge. **Never `git stash` mid-merge** — it
   silently clears `MERGE_HEAD`, and the commit loses its second parent (so the
   next upstream pull re-merges everything). Verify:
   `git rev-list --parents -n1 HEAD` shows both parents.
8. `git switch dev && git merge --ff-only merge-upstream-<ver>`; delete the branch.
9. `npm run build`; verify `storybloq --version` shows the new version and loads.
10. Strip any re-introduced `.github/workflows/*` — nothing should run on GitHub.
    (Our deletion usually wins the merge, but check: `ls .github/workflows/`.)
11. `git push origin dev`.
12. Restart the dashboard so it uses the new CLI:
    `cd ~/Apps/storybloq && pm2 restart storybloq`, then
    `curl localhost:3008/api/bloqs/<slug>` to confirm it serves.

## Resolving fork-vs-upstream tension

When a fork feature conflicts with an evolved upstream model, prefer upstream
and note the concession:

- **1.13.0**: fork `reviewDepth` knob → adopted upstream's richer `reviewEffort`.
- **1.15.0**: fork phase-defaulting → adopted upstream's `inferIssuePhase` for
  issues; kept top-level-ticket phase defaulting but let child tickets stay
  phase-less (upstream's umbrella/child model needs that).

## Testing — do not burn the machine

Run a **targeted vitest subset**, never the full suite. The full suite is 419
files, ~20+ min, mostly process-spawning e2e tests; an interrupted/killed run
orphans a worker (reparented to init) that spins at ~99% CPU indefinitely.

```
timeout 240 npx vitest run \
  test/core/phase-state-projects.test.ts \
  test/cli/commands/project.test.ts \
  test/cli/commands/ticket.test.ts \
  test/cli/commands/issue.test.ts \
  test/cli/commands/lesson.test.ts \
  test/federation/inherit.test.ts \
  test/knowledge/storyknow.test.ts \
  test/core/shortcode.test.ts \
  test/mcp/tools.test.ts \
  test/mcp/tool-contract-cues.test.ts \
  test/core/skill-sync-check.test.ts \
  test/core/recommend.test.ts \
  --reporter=dot
```

- A foreground run that finishes cleans itself up. Never launch the suite in
  the background and walk away; if you stop one, confirm no worker survives:
  `pgrep -af vitest`.
- `test/mcp/tool-contract-cues.test.ts` encodes the MCP tool **count** and the
  payload **byte ceiling**; both shift on every merge (the fork adds 4 tools,
  upstream adds its own). Update the expected count and ceiling to the measured
  values.
