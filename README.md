# agentlint

A semantic review gate for agent-written code, powered by the Claude CLI.

ESLint checks syntax and style. `agentlint` checks **meaning**: does the change
do what it claims, does it swallow errors, did it delete a failing test to look
green? It reviews a diff with an independent Claude instance, prints findings
with fix paths, and exits non-zero when the change must not be committed —
exactly like a linter on a husky hook.

One sentence: **ESLint's ergonomics, Claude's judgment.**

```
$ agentlint

✘ BLOCK  This change claims to harden applyDiscount but instead breaks it...

3 blockers

BLOCKER  Discount calculation is mathematically wrong
  discount.js:7
  The division by 100 was dropped: price * (1 - percent) ...
  why: Breaks the core function for every call with percent > 1.
  fix: Restore division by 100: return price * (1 - percent / 100);
...
quick  ·  19.0s  ·  $0.03
```

## Requirements

- Node.js >= 20
- git
- [Claude Code](https://claude.com/claude-code) installed and authenticated
  (`claude --version` must work) — agentlint spawns it headless and uses your
  existing subscription. No API keys.

## Install

The package is `@vkhamianok/agentlint`; the binary it installs is plain
`agentlint`.

```sh
# globally, for every project on the machine
npm install -g @vkhamianok/agentlint      # or: pnpm add -g @vkhamianok/agentlint
agentlint --version

# per project, shared with the team via package.json
npm install -D @vkhamianok/agentlint      # or: pnpm add -D @vkhamianok/agentlint
npx agentlint --version
```

## Quick start

```sh
agentlint init                   # set up config + rules dir (add --hook for husky)
agentlint                        # review uncommitted working-tree changes
agentlint --task "Add pagination to the user list"   # review against intent
agentlint --fix                  # fix confirmed findings, then re-review once
```

## What it can review

| Command                          | Reviews                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| `agentlint` / `agentlint review` | uncommitted working-tree changes (default)                     |
| `agentlint review staged`        | staged changes only (`git diff --cached`)                      |
| `agentlint review commit [ref]`  | a commit (default `HEAD`); its message becomes the task intent |
| `agentlint review range a..b`    | a commit range                                                 |
| `agentlint review snapshot`      | the whole project as it is now                                 |

Exit codes: `0` pass, `1` blocking findings, `2` error. Never a silent pass.

## Task intent

The reviewer judges _correctness against intent_ when it knows the intent:

```sh
agentlint --task "Migrate the cache layer to Redis without changing the API"
agentlint --task-file .task.md
```

Without a task, the review honestly degrades to general quality checking.
For `commit` targets the commit message is used as the fallback intent.

The task explains intent; it cannot override rules. If the task itself
demands something a rule forbids, the conflict is reported as a finding —
deliberate overrides go through the rules and the gate configuration
(edit or scope a rule, `--fail-on`, `AGENTLINT_SKIP=1`), never through
task wording. Rules are standing law from the repository's owner; the
task is a request from whoever produced the change.

## Rules

Rules are plain Markdown — instructions to the reviewer, not a DSL. They
**override the built-in principles**; project rules beat global rules.

- Global: `~/.agentlint/rules/*.md` (your defaults on every project)
- Project: `.agentlint/rules/*.md` (checked into git, shared with CI)

```markdown
---
severity: blocker # optional: report violations at this severity
---

# Database access goes through the repository layer

Flag any query built outside src/db/repositories/.
```

A rule can also mute a built-in principle ("ignore formatting entirely").
The recommended format adds `## Flag`, `## Do not flag`, and `## Examples`
sections with short Bad/Good snippets — see `rules/README.md`. Negative
examples are the best tool against false positives.

agentlint also ships a built-in library of default rules (`rules/` in the
package): fix the cause not the symptom, no swallowed errors, no history
comments, single source of truth, and more. Enable rules explicitly in the
config instead of copying files:

```json
{
  "rules": [
    "library:structure",
    "library:comments/no-history-comments",
    "./team-rules/*.md",
    { "rule": "library:naming/self-descriptive-names", "severity": "info" }
  ]
}
```

The project's `.agentlint/rules/` directory always loads, config or no
config, and loads last — its rules win over the library and global ones.
The `rules` key adds shipped and path-selected rules on top; global rules
apply unless `"inheritGlobalRules": false`.

`severity` is the only frontmatter key a rule file may carry; any other
key is a loud error.

### Managing rules

You do not have to write rules by hand. Describe what you want in any
language: agentlint writes the rule in the library's format — Flag, Do not
flag, and Bad/Good examples included — checks it against the format
contract, saves it, and prints the result for your review:

```sh
agentlint rule list      # every rule a review of this project would use
agentlint rule add all methods and functions must start with a verb
agentlint rule add --global --severity blocker никаких console.log в коде
agentlint rule edit verb-function-names allow noun names for factories
agentlint rule delete verb-function-names
```

`--global` targets `~/.agentlint/rules/` instead of the project;
`--severity` and `--name` override what the generator picks. Edits change
only what the instruction asks and go through the same format check — a
bad generation never destroys the existing file.

## Depth profiles

An LLM review costs time and money, so depth is budgeted per entry point:

| Profile    | Default for      | Model (default) | Behavior                                                                            |
| ---------- | ---------------- | --------------- | ----------------------------------------------------------------------------------- |
| `quick`    | pre-commit hooks | haiku           | blockers only, diff-only single shot (no repo exploration), 64 KB cap, ~30–60s      |
| `standard` | manual runs      | sonnet          | full principles + rules + code exploration                                          |
| `deep`     | CI / on demand   | opus            | standard + an independent refutation pass per finding; refuted findings are dropped |

The context (manual TTY / hook / CI) picks the default; `--depth` overrides.

## Fixing

```sh
agentlint --fix            # confirm findings one by one, then a separate
                           # fixer run applies them and the tree is re-reviewed once
agentlint --fix --yes      # fix all blocking findings without prompting
```

The reviewer and the fixer are separate Claude invocations: the reviewer
never edits, the fixer never judges. If the reviewer left open questions,
your answers are passed to the fixer as decisions.

Committing is deliberately not agentlint's job: the gate judges, the
caller acts. Exit code `0` is the signal that whoever invoked the review —
you, a hook, a coding agent — may commit.

## Configuration

`.agentlint/config.json` in the repo (project) and `~/.agentlint/config.json`
(global). Project wins; everything has a sane default.

```json
{
  "failOn": "blocker",
  "maxDiffKb": 200,
  "profiles": {
    "quick": { "model": "haiku", "timeoutMinutes": 5, "budgetUsd": 0.3 },
    "standard": { "model": "sonnet", "timeoutMinutes": 10, "budgetUsd": 1.5 },
    "deep": { "model": "opus", "timeoutMinutes": 20, "budgetUsd": 4 }
  },
  "depth": { "manual": "standard", "hook": "quick", "ci": "deep" },
  "ignore": ["**/node_modules/**", "**/dist/**", "**/pnpm-lock.yaml"]
}
```

Each profile carries its own model, wall-clock cap, and spend cap;
`depth` maps a run context to the profile it uses.

- `failOn` — lowest severity that blocks (`info` | `warning` | `blocker`).
  `--fail-on` overrides per run.
- `maxDiffKb` — hard size cap, enforced before any money is spent.
- `ignore` — globs excluded from review (setting it replaces the defaults).

## Hook and CI recipes

husky pre-commit:

```sh
# .husky/pre-commit
npx agentlint review staged --depth quick
```

This repository dogfoods the same gate, prefixed by its own checks and
using the locally built CLI instead of the published package — so every
commit is reviewed by the exact code it contains, not by the last release:

```sh
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test && pnpm build && node dist/cli.js review staged --depth quick
```

GitHub Actions:

```yaml
- run: npx agentlint review range ${{ github.event.pull_request.base.sha }}..HEAD --report agentlint.json
```

Escape hatch when a blocked commit must land anyway:
`AGENTLINT_SKIP=1 git commit ...` (skips only agentlint, not your other hooks).

## Reports

```sh
agentlint --report review.json --report-md review.md
```

JSON reports are versioned (`"version": 1`) and carry the verdict, findings,
depth, cost, and duration — the extension point for other tooling.

## Caching

A passing verdict is cached in `.git/agentlint/cache` (per clone and per
worktree, never committed), keyed by the change and the guidance that
judges it: the diff, new files, the task, the principles, and the rules.
Depth and model are recorded on the entry rather than hashed into the
key — which is what lets a deeper pass satisfy a shallower request.
Re-reviewing an unchanged diff — a hook re-run, a retried commit — is
instant and free, marked `cached` in the report. Change one word in one
rule and the key honestly misses.

Blocking verdicts are never cached (a block stays re-runnable), snapshots
are never cached, and `--no-cache` bypasses the cache for a run. A deeper
manual review that passes also satisfies the hook for the same diff.

## Design decisions

| Decision                                     | Why                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Engine: the installed `claude` CLI, headless | No API key management — your existing subscription; one thin adapter owns the invocation.                                                        |
| Every review is a fresh, independent process | The reviewer cannot inherit the writer's bias: fresh context by construction.                                                                    |
| Rules are Markdown prose, not a DSL          | Rules are instructions to an LLM; prose is the native format, and tuning the wording is tuning the reviewer.                                     |
| Findings are schema-validated JSON           | Machine-readable for the gate, renderable for the human; an engine failure is exit `2`, never a silent pass.                                     |
| `--fix` exists, committing does not          | Applying findings is still the review domain (the eslint `--fix` precedent); the gate judges, the caller acts — exit `0` means "safe to commit". |
| Cost is budgeted per depth profile           | An LLM is not a free linter: every profile caps diff size, turns, budget, and time.                                                              |

## How noise is kept down

A review gate that cries wolf gets disabled within a week. agentlint:

- instructs the reviewer to verify every finding against the code before
  reporting, and to prefer precision over recall;
- requires every finding to carry concrete fix paths and a confidence level;
- in `deep`, verifies each finding with an independent refutation call —
  findings that do not survive are dropped;
- never turns engine failures into a silent pass (exit 2 instead).

## Development

```sh
pnpm install
pnpm test          # unit tests, engine mocked, free
AGENTLINT_E2E=1 pnpm vitest run test/e2e   # real CLI, costs money
pnpm build
```

See `docs/10-problem.md` for the problem statement this tool answers —
its requirements, non-goals, and success criteria judge every scope
decision.
