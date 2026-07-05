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

## Scopes

A scope is a named set of paths — the inverse of `ignore`. Where `ignore` says
"never look here", a scope says "for this run, look only here". Manage scopes
from the CLI (no need to hand-edit the config):

```sh
agentlint scope add orchestrator "services/orchestrator/**"   # define one
agentlint scope add web "apps/web/**" "packages/ui/**"        # several globs
agentlint scope edit web "apps/web/**"                        # replace its globs
agentlint scope remove web
agentlint scope list                                          # what is defined
```

Then restrict any review to a scope with `--scope`:

```sh
agentlint review snapshot --scope orchestrator   # only that subsystem
agentlint review staged --scope web              # only staged changes under apps/web
```

Scopes live under a `scopes` map in `.agentlint/config.json`, which you can also
edit directly: `{ "scopes": { "orchestrator": ["services/orchestrator/**"] } }`.

`--scope` also takes an ad-hoc path glob, so a one-off review needs no config
entry — a value that is not a defined scope name is treated as a glob (comma-
separate several):

```sh
agentlint review snapshot --scope "services/api-auth/**"
agentlint review snapshot --scope "services/api-auth/**,packages/shared/**"
```

Scopes turn a snapshot review of a large monorepo from one thin pass over
everything into a focused, thorough pass over one part. An unknown `--scope`
name fails loudly. Scopes and `--profile` compose:
`review snapshot --scope orchestrator --profile audit`. A profile can also carry
a `defaultScope`, so a profile that is inherently a slice never needs the flag —
see [Custom profiles](#custom-profiles).

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
agentlint rule remove verb-function-names
agentlint rule check     # audit the set: contradictions, duplication, noise risks
```

Rules are prompts, and prompts can contradict, duplicate, or blur each
other without anyone noticing. `rule check` reads the whole effective set
and reports unintentional conflicts, duplicated laws that will drift
apart, wording a reviewer cannot falsify, and noise risks — each with a
concrete rewording to apply.

`--global` targets `~/.agentlint/rules/` instead of the project;
`--severity` and `--name` override what the generator picks. Edits change
only what the instruction asks and go through the same format check — a
bad generation never destroys the existing file.

## Profiles

An LLM review costs time and money, so each entry point runs a profile that
budgets it. Three are built in:

| Profile    | Default for      | Model (default) | Behavior                                                                            |
| ---------- | ---------------- | --------------- | ----------------------------------------------------------------------------------- |
| `quick`    | pre-commit hooks | haiku           | blockers only, diff-only single shot (no repo exploration), 64 KB cap, ~30–60s      |
| `standard` | manual runs      | sonnet          | full principles + rules + code exploration                                          |
| `deep`     | CI / on demand   | opus            | standard + an independent refutation pass per finding; refuted findings are dropped |

`defaultProfile` maps the run context (manual TTY / hook / CI) to its
profile; `--profile <name>` overrides it. The set is open — see
[Custom profiles](#custom-profiles) to add your own.

### Engines: Claude and Codex

agentlint reviews with either the Claude CLI or the OpenAI Codex CLI. If you
configure nothing, it **autodetects** the one installed — and picks Claude when
both are. Each engine supplies its own model per tier:

| tier       | claude   | codex          |
| ---------- | -------- | -------------- |
| `quick`    | `haiku`  | `gpt-5.4-mini` |
| `standard` | `sonnet` | `gpt-5.4`      |
| `deep`     | `opus`   | `gpt-5.5`      |

You can be explicit in three ways, most specific first:

- **Pin a model** on a profile: `"model": "opus"` or `"model": "openai:gpt-5.5"`.
  A bare model's provider is inferred (`opus` → claude, `gpt-5.4` → codex); a
  `provider:` prefix (`claude:…`, `openai:…`, alias `codex:…`) is exact.
- **Pin an engine** without a model: `--engine claude|openai` on the command, a
  top-level `"engine"` in the config, or `"engine"` on a profile. The profile's
  tier then chooses the model. `agentlint review --profile deep --engine openai`
  runs codex's `gpt-5.5`.
- **The `AGENTLINT_ENGINE` env var** sets the default engine for a shell.

`--fix` runs on the same engine that reviewed, using that engine's fixer model.

Both engines give the same validated, structured findings (Codex via
`codex exec --output-schema`, reshaped to OpenAI's stricter schema form). Two
caveats on Codex: `budgetUsd` has no effect (Codex has no per-run USD cap, so a
run is bounded by the profile's `timeoutMinutes`), and the report shows no USD
cost.

### Managing profiles

You do not have to hand-edit the config. Describe a profile in any language
and agentlint picks a fitting model and budget and writes its focus
`instructions` for you, editing `.agentlint/config.json` in place while
leaving the rest of the file untouched:

```sh
agentlint profile list      # built-ins plus your custom profiles
agentlint profile add security audit on the strongest model, hunting for injection and secrets
agentlint profile edit audit also check authorization on every route
agentlint profile remove audit
```

`--global` targets `~/.agentlint/config.json`; `--model` and `--name`
override what the generator picks. Built-in profiles can be tuned with
`profile edit` but not removed. The generator writes the model, budget, and
`instructions`; a profile's `rules`, `inheritProjectRules`, and `defaultScope`
are set by hand in the config (see [Custom profiles](#custom-profiles)). Then
run a review under a custom profile:

```sh
agentlint review snapshot --profile audit --report-md audit.md
```

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

## Ignoring a false positive

An LLM reviewer is not infallible. When a finding is wrong, dismiss it
surgically instead of disabling the whole gate — with a reason that is kept:

```sh
agentlint ignore a1b2c3d4 "false positive: the value is validated upstream"
agentlint ignore --run 3f8a91c2e004 "accepted for this release, tracked in TICKET-1"
```

Every finding in a report carries a short id, and each run carries a run id —
those are the handles. Ignoring a finding drops it from the verdict, so a
re-review of the unchanged change proceeds if nothing else blocks; anything you
did not ignore still gates. `--run` dismisses the whole run: the reasoned
alternative to `AGENTLINT_SKIP`, leaving a trail (reason, who, when) a teammate
can review. An ignore is local to your clone and tied to the exact change —
edit the code and the review runs fresh, so it can never hide a problem you
have since changed.

The verdict itself is derived, never authored by the model: the reviewer rates
each finding by severity, and the gate blocks when an open finding reaches
`failOn`. Lower the bar for one run with `--fail-on warning`.

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
  "defaultProfile": { "manual": "standard", "hook": "quick", "ci": "deep" },
  "ignore": ["**/node_modules/**", "**/dist/**", "**/pnpm-lock.yaml"]
}
```

Each profile carries its own model, wall-clock cap, spend cap, and optional
free-text `instructions`; `defaultProfile` maps a run context to the profile
it uses, and `--profile <name>` overrides it.

### Custom profiles

`profiles` is an open set: tune the three built-ins, or add your own named
profile for a different job — for example a periodic security audit on a
stronger, pricier model. A custom profile inherits the standard profile's
numbers, so it needs only what differs, and it runs a thorough review
(repo exploration + refutation pass) like `deep`. Beyond a model, budget, and
free-text `instructions`, a profile can override which rules apply and which
paths it looks at:

- `rules` — selectors (same grammar as the top-level `rules`) added on top of
  the project's, so a profile can pull in its own without every review paying
  for them.
- `inheritProjectRules` — set `false` to make the profile stand alone:
  `config.rules` and the project `.agentlint/rules/` directory are dropped,
  leaving only the profile's own rules (global rules still apply). A focused
  audit is then not diluted by the general rule set.
- `defaultScope` — a scope name the profile restricts to unless `--scope`
  overrides it, for a profile that is inherently a slice.

```json
{
  "scopes": { "docs": ["docs/**"] },
  "profiles": {
    "audit": {
      "model": "claude-fable-5",
      "budgetUsd": 12,
      "rules": ["library:errors", "./security/*.md"],
      "inheritProjectRules": false,
      "instructions": "Audit for security: injection, committed secrets, unvalidated input at trust boundaries, unsafe deserialization."
    },
    "docs": {
      "model": "sonnet",
      "defaultScope": "docs",
      "rules": ["library:prose"],
      "inheritProjectRules": false,
      "instructions": "Review documentation prose: clarity and accuracy against the code it describes. Do not review code quality."
    }
  }
}
```

A security audit deliberately has no `defaultScope` — narrowing it would hide
the very things it hunts (secrets, injection in scripts outside `src/`), so it
stays whole-repo and is scoped per run. A `docs` profile is the opposite: a
slice by nature, so it defaults to its scope.

```sh
agentlint review snapshot --profile audit --report-md audit.md
```

This pairs with the audit workflow: a snapshot review (the whole codebase,
not a diff) under a security profile is how you catch latent problems the
per-commit gate never sees, because they are not in any diff. Run it before
a release or after a big refactor — it is an audit that produces a to-do
list, not a gate that blocks.

- `failOn` — lowest severity that blocks (`info` | `warning` | `blocker`).
  `--fail-on` overrides per run.
- `maxDiffKb` — hard size cap, enforced before any money is spent.
- `ignore` — globs excluded from review (setting it replaces the defaults).
- `scopes` — named path filters for partial reviews; see [Scopes](#scopes).

## Hook and CI recipes

husky pre-commit:

```sh
# .husky/pre-commit
npx agentlint review staged --profile quick
```

This repository dogfoods the same gate, prefixed by its own checks and
using the locally built CLI instead of the published package — so every
commit is reviewed by the exact code it contains, not by the last release:

```sh
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test && pnpm build && node dist/cli.js review staged --profile quick
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
agentlint --report -       # JSON on stdout, nothing else — for pipes and agents
```

JSON reports are versioned (`"version": 1`) and carry the verdict, findings,
profile, cost, and duration — the extension point for other tooling. With
`--report -` the JSON report is the only stdout output, so a calling agent
can consume findings without parsing the human-readable rendering.

## Caching

A passing verdict is cached in `.git/agentlint/cache` (per clone and per
worktree, never committed), keyed by everything that shapes the verdict:
the change (diff, new files, task) and the guidance that judges it — the
principles, the rules, and the profile's verdict-shaping settings (model,
focus, whether it explores, whether it refutes). Re-reviewing an unchanged
diff under the same profile — a hook re-run, a retried commit — is instant
and free, marked `cached` in the report. Change one word in one rule, or
switch the profile's model, and the key honestly misses.

Each profile caches for itself: there is no cross-profile satisfaction, so a
manual `standard` pass does not answer a later `quick` hook for the same
diff (the hook re-runs its cheap `quick` review). Blocking verdicts are never
cached (a block stays re-runnable), snapshots are never cached, and
`--no-cache` bypasses the cache for a run.

## Design decisions

| Decision                                     | Why                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Engine: the installed `claude` CLI, headless | No API key management — your existing subscription; one thin adapter owns the invocation.                                                        |
| Every review is a fresh, independent process | The reviewer cannot inherit the writer's bias: fresh context by construction.                                                                    |
| Rules are Markdown prose, not a DSL          | Rules are instructions to an LLM; prose is the native format, and tuning the wording is tuning the reviewer.                                     |
| Findings are schema-validated JSON           | Machine-readable for the gate, renderable for the human; an engine failure is exit `2`, never a silent pass.                                     |
| `--fix` exists, committing does not          | Applying findings is still the review domain (the eslint `--fix` precedent); the gate judges, the caller acts — exit `0` means "safe to commit". |
| Cost is budgeted per profile                 | An LLM is not a free linter: every profile caps diff size, turns, budget, and time.                                                              |

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
