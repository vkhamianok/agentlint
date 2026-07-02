# Plan: Building `agentlint`

Implements the design in [20-solution.md](20-solution.md). The plan is a sequence of milestones. Every milestone ends with something that runs, and gets reviewed (by eye, for now — the tool that will do it is the one we are building) before moving on.

## Module Layout

```
agentlint/
├─ package.json            # name: agentlint, bin: agentlint
├─ tsconfig.json
├─ src/
│  ├─ cli.ts               # entry: parse args, wire the pipeline
│  ├─ config.ts            # load + merge global/project config, defaults
│  ├─ targets.ts           # diff | staged | commit | range | snapshot → git
│  ├─ rules.ts             # built-in principles + global + project rules
│  ├─ prompt.ts            # assemble review prompt + output contract
│  ├─ engine/
│  │  └─ claude.ts         # the ONLY place that spawns the claude CLI
│  ├─ schema.ts            # findings schema (zod) + validation + retry
│  ├─ report/
│  │  ├─ terminal.ts       # colorized human output
│  │  ├─ json.ts           # --report
│  │  └─ markdown.ts       # --report-md
│  ├─ gate.ts              # verdict + failOn → exit code
│  ├─ interactive.ts       # manual-mode questions in the terminal
│  ├─ fix.ts               # --fix: fixer invocation + re-review loop
│  └─ commit.ts            # --commit: message generation + git commit
├─ prompts/
│  └─ principles.md        # built-in review principles (shipped in package)
├─ docs/                   # these documents
└─ test/
   ├─ unit/                # per-module tests, engine mocked
   └─ fixtures/
      ├─ claude-stub/      # fake claude binary replaying canned JSON
      └─ repos/            # small git repos with seeded good/bad diffs
```

Dependencies, deliberately few: `commander` (args), `zod` (schema), `execa` (spawning with Windows `.cmd` handling), `picocolors` (terminal), `gray-matter` (rule frontmatter). Dev: `typescript`, `tsup`, `vitest`, `eslint` + `husky` — the project dogfoods the workflow it is built for.

## Milestones

### M0 — Scaffolding + engine spike

- `git init`, npm package, TypeScript, tsup build, vitest, eslint, husky.
- **Spike first**: run the installed `claude` CLI headless by hand (`claude -p ... --output-format json`, allowed-tools flag, model flag) and pin the exact flag set of the installed version inside `engine/claude.ts`. Everything else builds on this, so it goes first.
- Done when: `npx agentlint --version` works; a throwaway script gets a JSON answer out of `claude -p`.

### M1 — Walking skeleton (tracer bullet)

The thinnest end-to-end slice: `agentlint` (default diff target) → hardcoded minimal prompt → real claude run → schema-validated findings → plain terminal report → exit code.

- `targets.ts` (diff target only), `prompt.ts` (minimal), `engine/claude.ts`, `schema.ts` with the retry-once / exit-2 rule, basic `report/terminal.ts`, `gate.ts`.
- Done when: on a repo with an obviously bad uncommitted change, `agentlint` blocks with a readable finding (what / why / fixes); on a clean change it passes with exit 0.

### M2 — Principles, rules, intent

- Write `prompts/principles.md` — the built-in review principles. This is a core deliverable, not filler: correctness against intent, simplicity, reuse before new code, honest error handling, no deleted tests, project conventions.
- `rules.ts`: load `~/.agentlint/rules/*.md` and `.agentlint/rules/*.md`, frontmatter (`severity`, `applies`), precedence project > global > built-in, mute support.
- `--task` / `--task-file`, commit-message fallback for commit targets.
- Done when: a project rule visibly changes the review focus (testable with the claude stub by asserting the assembled prompt; and once for real by eye).

### M3 — All targets + config + reports

- `targets.ts` complete: `staged`, `commit [ref]`, `range a..b`, `snapshot`; untracked files in the default diff; `ignore` globs.
- `config.ts`: `.agentlint/config.json` + global, merge with defaults; `failOn`, `maxDiffKb`, models per profile.
- `--report` (JSON) and `--report-md`; polished terminal output grouped by severity.
- Done when: every target from the solution doc, section 3, resolves correctly (unit tests against fixture repos); config values demonstrably take effect.

### M4 — Depth profiles + noise control

- `--depth quick|standard|deep`; per-profile model, turn cap, prompt focus; diff-size cap with the polite refusal in `quick`.
- `deep`: refutation pass — one extra claude call per finding trying to refute it; refuted findings dropped from the report.
- Non-interactive detection (TTY / `--non-interactive`) for hook and CI runs.
- Done when: `quick` on a small diff completes within a pre-commit-tolerable time; a planted borderline-bogus finding gets removed by the `deep` refutation pass.

### M5 — The human loop: questions, --fix, --commit

- `interactive.ts`: reviewer `questions` asked in the terminal in manual mode; printed in the report otherwise.
- `fix.ts`: confirm findings (or `--yes` for blockers), separate fixer invocation with edit tools, then one re-review of the new diff. Reviewer never edits; fixer never judges.
- `commit.ts`: on final `pass`, generate commit message from task + diff, `git commit`.
- Done when: `agentlint --fix --commit` on a fixture repo with a seeded bug ends in a clean committed fix — the user's whole manual loop, closed.

### M6 — Hardening + docs

- Windows path/spawn edge cases; husky recipe tested on this very repo (`npx agentlint staged --depth quick` in `.husky/pre-commit`).
- E2E suite against the real CLI on the fixture repos (seeded logic bug, deleted test, convention violation, clean change) — behind an env flag, run on demand, because it costs money.
- README: install, quick start, rules how-to, husky/CI recipes, config reference.
- Done when: the success criteria in [10-problem.md](10-problem.md), section 6, each have a demonstrated check.

## Testing Strategy

- **Unit tests (default `npm test`)**: everything with the engine mocked via the claude stub (a tiny script the adapter is pointed at through an env override, e.g. `AGENTLINT_CLAUDE_BIN`). Target resolution, rule assembly and precedence, prompt content, schema validation + retry + exit 2, gate logic, config merging. Free and deterministic.
- **E2E (opt-in)**: real claude CLI on fixture repos; asserts the gate behavior (bad blocked, clean passed), not exact wording.
- **Dogfooding**: from M1 on, agentlint reviews its own uncommitted changes before each milestone commit.

## Working Agreement

- Milestones land in order; each ends with a review by the user and then a commit (the usual loop — until M5, when agentlint starts closing it itself).
- If the M0 spike shows the installed claude CLI can't do something the design assumes (flag missing, JSON shape different), the fix goes into `engine/claude.ts` and, if it changes the design, back into 20-solution.md first.
