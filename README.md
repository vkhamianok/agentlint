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

```sh
npm install -g agentlint     # or: pnpm add -g agentlint
# per project:
npm install -D agentlint     # then use npx agentlint
```

## Quick start

```sh
agentlint                        # review uncommitted working-tree changes
agentlint --task "Add pagination to the user list"   # review against intent
agentlint --fix --commit         # fix confirmed findings, re-review, commit
```

## What it can review

| Command                        | Reviews                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `agentlint` / `agentlint diff` | uncommitted working-tree changes (default)                     |
| `agentlint staged`             | staged changes only (`git diff --cached`)                      |
| `agentlint commit [ref]`       | a commit (default `HEAD`); its message becomes the task intent |
| `agentlint range a..b`         | a commit range                                                 |
| `agentlint snapshot`           | the whole project as it is now                                 |

Exit codes: `0` pass, `1` blocking findings, `2` error. Never a silent pass.

## Task intent

The reviewer judges _correctness against intent_ when it knows the intent:

```sh
agentlint --task "Migrate the cache layer to Redis without changing the API"
agentlint --task-file .task.md
```

Without a task, the review honestly degrades to general quality checking.
For `commit` targets the commit message is used as the fallback intent.

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

Without a `rules` key the `.agentlint/rules/` directories load as before;
global rules apply either way unless `"inheritGlobalRules": false`.

Note for rule files written against older versions: `applies` is no longer
supported in frontmatter (a rule scopes itself better in prose), and any
unknown frontmatter key is a loud error.

### Generating rules

You do not have to write rules by hand. Describe the rule in any language
and agentlint writes it in the library's format — Flag, Do not flag, and
Bad/Good examples included — checks it against the format contract, saves
it, and prints the result for your review:

```sh
agentlint add-rule all methods and functions must start with a verb
agentlint add-rule --global --severity blocker никаких console.log в коде
```

`--global` writes to `~/.agentlint/rules/` instead of the project;
`--severity` and `--name` override what the generator picks.

## Depth profiles

An LLM review costs time and money, so depth is budgeted per entry point:

| Profile    | Default for      | Model (default) | Behavior                                                                            |
| ---------- | ---------------- | --------------- | ----------------------------------------------------------------------------------- |
| `quick`    | pre-commit hooks | haiku           | blockers only, diff-only single shot (no repo exploration), 64 KB cap, ~30–60s      |
| `standard` | manual runs      | sonnet          | full principles + rules + code exploration                                          |
| `deep`     | CI / on demand   | opus            | standard + an independent refutation pass per finding; refuted findings are dropped |

The context (manual TTY / hook / CI) picks the default; `--depth` overrides.

## Fixing and committing

```sh
agentlint --fix            # confirm findings one by one, then a separate
                           # fixer run applies them and the tree is re-reviewed once
agentlint --fix --yes      # fix all blocking findings without prompting
agentlint --fix --commit   # ...and commit when the final review passes
```

The reviewer and the fixer are separate Claude invocations: the reviewer
never edits, the fixer never judges. If the reviewer left open questions,
your answers are passed to the fixer as decisions.

## Configuration

`.agentlint/config.json` in the repo (project) and `~/.agentlint/config.json`
(global). Project wins; everything has a sane default.

```json
{
  "failOn": "blocker",
  "maxDiffKb": 200,
  "models": { "quick": "haiku", "standard": "sonnet", "deep": "opus" },
  "depth": { "manual": "standard", "hook": "quick", "ci": "deep" },
  "timeoutMinutes": { "quick": 5, "standard": 10, "deep": 20 },
  "ignore": ["**/node_modules/**", "**/dist/**", "**/pnpm-lock.yaml"]
}
```

- `failOn` — lowest severity that blocks (`info` | `warning` | `blocker`).
  `--fail-on` overrides per run.
- `maxDiffKb` — hard size cap, enforced before any money is spent.
- `ignore` — globs excluded from review (setting it replaces the defaults).

## Hook and CI recipes

husky pre-commit:

```sh
# .husky/pre-commit
npx agentlint staged --depth quick
```

This repository dogfoods the same gate, prefixed by its own checks and
using the locally built CLI instead of npx:

```sh
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test && pnpm build && node dist/cli.js staged --depth quick
```

GitHub Actions:

```yaml
- run: npx agentlint range ${{ github.event.pull_request.base.sha }}..HEAD --report agentlint.json
```

Escape hatch when a blocked commit must land anyway:
`AGENTLINT_SKIP=1 git commit ...` (skips only agentlint, not your other hooks).

## Reports

```sh
agentlint --report review.json --report-md review.md
```

JSON reports are versioned (`"version": 1`) and carry the verdict, findings,
depth, cost, and duration — the extension point for other tooling.

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

See `docs/` for the problem statement, solution design, plan, and the
verification of success criteria.
