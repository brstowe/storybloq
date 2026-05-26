# Team CI Validation

Run `storybloq team doctor --ci` and `storybloq reconcile --ci` in CI to catch team-mode issues before merge.

## What it catches

- **Duplicate displayIds** after merge (two developers create T-042 independently)
- **Unresolved conflicts** (`_conflicts` field present on entities)
- **Stale references** (blockedBy/parentTicket pointing to non-existent items)
- **Missing displayIds** on team-mode entities
- **CLI version mismatches** against config.team.minCliVersion

## GitHub Actions Workflow

Create `.github/workflows/story-validate.yml`:

```yaml
name: Story Validation

on:
  pull_request:
    paths:
      - '.story/**'

permissions:
  contents: read

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install storybloq
        run: npm install -g @storybloq/storybloq@latest

      - name: Run team doctor
        run: storybloq team doctor --ci

      - name: Check for duplicate displayIds
        run: storybloq reconcile --ci

      - name: Validate references
        run: storybloq validate --format md
```

## How it works

The `pull_request` event checks out the **merge commit** (the result of merging the PR branch into the base branch). This means the validation runs against the post-merge state, catching conflicts that only appear after combining both branches.

`fetch-depth: 0` ensures full history is available for staleness detection.

## Exit codes

| Command | Exit 0 | Exit 1 |
|---------|--------|--------|
| `team doctor --ci` | No error-level findings | Error-level findings found |
| `reconcile --ci` | No duplicate displayIds | Duplicates detected |
| `validate` | All references valid | Reference errors found |

## Protected branch setup

1. Go to Settings > Branches > Branch protection rules
2. Enable "Require status checks to pass before merging"
3. Add "Story Validation / validate" as a required check
4. Recommended: enable "Require branches to be up to date before merging" to avoid stale merge results

## Merge queues

If your repository uses GitHub merge queues, the workflow runs automatically on the queue's merge group. No additional configuration needed -- the `pull_request` trigger covers queue validation.

## Customizing the base branch

If your default branch is not `main`, the workflow works unchanged -- `pull_request` targets the PR's base branch automatically.

For monorepos with `.story/` in a subdirectory, adjust the `paths` filter:

```yaml
on:
  pull_request:
    paths:
      - 'packages/my-app/.story/**'
```

And set `working-directory` on each step:

```yaml
      - name: Run team doctor
        run: storybloq team doctor --ci
        working-directory: packages/my-app
```

## Troubleshooting

**"storybloq: command not found"**: The install step failed or was skipped. Ensure `setup-node` and `npm install -g` steps are present.

**Doctor reports "Not a team-mode project"**: Your project's config.json has `schemaVersion` < 2. Team doctor checks only run on team-mode projects (schemaVersion >= 2).

**Reconcile reports duplicates on every PR**: Two items share a displayId in the base branch. Run `storybloq reconcile` locally on the base branch to fix, then push.

**False positives on reference validation**: If `validate` flags references that exist in your working copy but not in the PR, ensure `fetch-depth: 0` is set so the full tree is checked out.
