# Solution: `agentlint` — a Review Gate on Top of the Claude CLI

Answers the problem in [10-problem.md](10-problem.md). Working name: **agentlint** — a linter for agent-written code, and a linter that works agent-style (LLM judgment instead of static rules). Still easy to rename: it appears only as the binary name and the `.agentlint/` config directory.

## 1. Overview

`agentlint` is a small TypeScript CLI. It collects a change (diff, commit, or snapshot), builds a review prompt from built-in principles plus user rules, runs the locally installed `claude` CLI in headless mode as an independent reviewer, parses its structured findings, prints a report, and exits with a code that tells husky or CI whether to block.

One sentence: **ESLint's ergonomics, Claude's judgment.**

```
agentlint [target] [flags]
   │
   ├─ 1. Resolve target ──── git diff / git show / file tree
   ├─ 2. Assemble context ── principles + rules + task description + diff
   ├─ 3. Run reviewer ────── claude -p (headless, read-only tools, fresh context)
   ├─ 4. Parse findings ──── JSON, schema-validated, retry once on garbage
   ├─ 5. Report ──────────── terminal + optional JSON/Markdown file
   └─ 6. Gate ────────────── exit 0 (pass) / exit 1 (block)
                              └─ optional: --fix, --commit
```

## 2. Decisions Already Made (and why)

| Decision               | Choice                                                            | Why                                                                            |
| ---------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Engine                 | Installed `claude` CLI, headless (`claude -p`)                    | User's constraint. No API key management, uses existing subscription.          |
| Harness language       | TypeScript / Node.js                                              | User's stack; npm gives us `bin`, husky lives there anyway.                    |
| Distribution           | npm package with a `agentlint` binary                             | Works globally (`npm i -g`) and per project (devDependency + npx).             |
| Reviewer independence  | Every review is a fresh `claude -p` process in the repo directory | Fresh context by construction — the reviewer cannot inherit the writer's bias. |
| Rules format           | Markdown files, plain language                                    | Rules are instructions to an LLM; prose is the native format. No DSL to learn. |
| Findings format        | JSON validated against a schema                                   | Machine-readable for the gate, renderable for the human.                       |
| Auto-fix / auto-commit | Yes, both — opt-in flags                                          | The user's goal is to close the whole manual loop, not half of it.             |

## 3. Review Targets

The first CLI argument selects what to review. Under the hood, plain git:

| Command                        | Reviews                                    | Git source                        |
| ------------------------------ | ------------------------------------------ | --------------------------------- |
| `agentlint` / `agentlint diff` | uncommitted working-tree changes (default) | `git diff HEAD` + untracked files |
| `agentlint staged`             | staged changes only                        | `git diff --cached`               |
| `agentlint commit [ref]`       | last commit, or a given one                | `git show <ref>` (default `HEAD`) |
| `agentlint range <a>..<b>`     | a commit range                             | `git diff a..b`                   |
| `agentlint snapshot`           | the whole project as it is now             | file tree, no diff                |

The harness computes the diff itself and puts it in the prompt. The reviewer also gets read-only tools (Read, Grep, Glob) so it can look at surrounding code — a diff alone is often not enough to judge a change.

## 4. Principles and Rules

Three layers, later layers override earlier ones:

1. **Built-in principles** — ship inside the package. General review wisdom: correctness against intent, simplicity, reuse of existing code before writing new code, honest error handling, no dead code, no deleted-to-make-it-pass tests, matching project conventions.
2. **Global rules** — `~/.agentlint/rules/*.md`. The user's personal defaults across all projects.
3. **Project rules** — `.agentlint/rules/*.md` in the repo. Checked into git, so they also steer reviews in CI and for teammates.

A rule file is plain Markdown with a small optional frontmatter:

```markdown
---
severity: blocker # optional: what to report violations as
applies: 'src/db/**' # optional: glob to scope the rule
---

All database access goes through the repository layer.
Flag any direct query built outside `src/db/repositories/`.
```

A rule can also mute a built-in principle ("ignore formatting entirely") — the assembled prompt states explicitly that user rules win over built-ins.

## 5. The Reviewer Run

One review = one headless invocation, roughly:

```
claude -p <review prompt>
  --append-system-prompt <principles + rules + output contract>
  --allowedTools "Read,Grep,Glob"      # read-only; no Edit, no Write, no Bash
  --output-format json
  --model <from depth profile>
  --max-turns <from depth profile>
```

(Exact flag names get pinned against the installed CLI version during implementation.)

The **output contract** in the prompt demands a single JSON object:

```json
{
  "verdict": "pass | block",
  "summary": "one paragraph",
  "findings": [
    {
      "file": "src/api/user.ts",
      "line": 42,
      "severity": "blocker | warning | info",
      "title": "Deleted failing test instead of fixing it",
      "what": "…",
      "why": "…",
      "fixes": ["restore the test and fix the off-by-one in …", "…"],
      "confidence": "high | medium | low"
    }
  ],
  "questions": ["real forks the reviewer could not decide alone"]
}
```

The harness validates against the schema. On invalid output it retries once with the validation error appended; a second failure is an `error` exit (exit 2), never a silent pass.

**Noise control** (precision beats recall, per the problem doc): the prompt instructs the reviewer to verify each finding against the actual code via its read tools before reporting, to report only findings it would defend, and to use `confidence`. In `deep` mode the harness adds a second pass: a separate `claude -p` call per finding that tries to refute it; refuted findings are dropped.

**Intent input**: `--task "<what the change was supposed to do>"` or `--task-file <path>`; for commit targets the commit message is used as a fallback. Without any of these the prompt says so, and the review degrades to general quality checking (as the problem doc allows).

## 6. Depth Profiles

The answer to "an LLM is not a linter" — cost and latency are budgeted per entry point:

| Profile    | Default for      | Model                   | Behavior                                  |
| ---------- | ---------------- | ----------------------- | ----------------------------------------- |
| `quick`    | husky pre-commit | fast/cheap (e.g. Haiku) | diff-focused, few turns, blockers only    |
| `standard` | manual runs      | default model           | full principles + rules, code exploration |
| `deep`     | CI / on demand   | strongest model         | standard + refutation pass per finding    |

Selected via `--depth`, defaulted via config. Additional cost guards: a diff size cap (above it, `quick` refuses politely and suggests `standard`), and a per-run turn limit.

## 7. Report and Gate

- **Terminal**: findings grouped by severity, colorized, each with its fix paths. Readable in a failed husky run.
- **`--report <path>`**: writes JSON (and `--report-md` for Markdown) for other tools or later reading.
- **Exit codes**: `0` pass, `1` blocking findings, `2` harness/engine error. The blocking threshold defaults to `blocker` and is configurable (`--fail-on warning` for strict CI).

## 8. Modes and the Human Loop

- **Manual run** (interactive): after the report, if the reviewer returned `questions`, the harness asks them in the terminal — this is the "real forks reach the user" channel. Everything else was decided autonomously.
- **Hook / CI run** (non-interactive, auto-detected via TTY or `--non-interactive`): no prompts; `questions` are printed in the report; verdict is pass/block only.
- **`--fix`** (opt-in): for findings the user confirms (or all blockers with `--fix --yes`), the harness runs a second, separate `claude -p` invocation — this one with edit tools enabled, scoped to the repo — with the finding and its chosen fix path as the task. Then it **re-reviews the new diff** once. Fixer and reviewer stay separate invocations: the reviewer never edits.
- **`--commit`** (opt-in): if the final verdict is `pass`, generate a commit message from the task description and diff, and commit. Combined `agentlint --fix --commit` closes the user's entire manual loop.

## 9. Configuration

`.agentlint/config.json` in the repo (plus `~/.agentlint/config.json` global, project wins):

```json
{
  "depth": { "hook": "quick", "manual": "standard", "ci": "deep" },
  "models": { "quick": "haiku", "standard": "sonnet", "deep": "opus" },
  "failOn": "blocker",
  "maxDiffKb": 200,
  "ignore": ["**/*.lock", "dist/**"]
}
```

Everything has a sane default; a repo with no config at all still works.

## 10. Tech Notes

- **Windows first**: spawn the `claude` binary via Node's `child_process` with proper `.cmd` shim handling; no POSIX-only assumptions; paths through Node APIs.
- **Husky recipe** (documented in the README): `npx agentlint staged --depth quick` in `.husky/pre-commit`.
- **Testing**: unit tests for target resolution, rule assembly, schema validation, and gate logic with a **mocked claude CLI** (a stub binary that replays canned JSON). A small set of end-to-end tests against the real CLI on fixture repos with seeded bugs — run on demand, not in the default test run, because they cost money.

## 11. Risks

| Risk                                            | Mitigation                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Reviewer output is not valid JSON               | schema validation + one retry + exit 2, never silent pass                                                            |
| Too noisy → user disables the gate              | verification instructions, confidence field, refutation pass in `deep`, rules to mute noise sources                  |
| Too slow/expensive for pre-commit               | `quick` profile, diff cap, turn cap; user can move the gate to pre-push or CI                                        |
| Non-determinism (same diff, different verdicts) | accepted per problem doc; thresholds only on severities the reviewer must justify; refutation pass stabilizes `deep` |
| `claude` CLI flags change between versions      | one thin adapter module owns the invocation; version check with a clear error                                        |

## 12. Out of Scope (for v1)

- Caching / incremental review across runs — revisit if pre-commit cost hurts in practice.
- PR-platform integration (GitHub comments etc.) — the JSON report is the extension point.
- Multiple engine backends (API, other CLIs) — the adapter module keeps the door open.
