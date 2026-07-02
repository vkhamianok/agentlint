# Verification: Success Criteria

Each criterion from [10-problem.md](10-problem.md), section 6, with its
demonstrated check. "Live" = a real run against the installed Claude CLI
(2.1.198) on 2026-07-02; costs and timings from those runs.

## 1. The user no longer eyeballs routine diffs

The gate reviews every change of this repository itself: every milestone
diff since M1 was reviewed by agentlint before commit (dogfooding), and
`.husky/pre-commit` runs `agentlint review staged --depth quick` on every commit.
The M4 dogfood run **blocked a real bug** (a `Promise.all` failure mode in
the refutation pass) before it reached history.

## 2. A seeded bad diff is blocked; a clean diff passes

- Live (M1): a diff with a broken formula, a swallowed validation error, and
  a deleted test → `✘ BLOCK`, exit 1, all three found as blockers.
- Live (M1): an honest small addition → `✔ PASS`, exit 0.
- Repeatable: `test/e2e/review.e2e.test.ts` (run with `AGENTLINT_E2E=1`)
  asserts both verdicts against the real CLI on the quick profile.

## 3. Every finding comes with an actionable fix path

Enforced by the schema: `fixes` requires at least one entry, validated
CLI-side and re-validated locally; the e2e suite asserts it on live output.

## 4. Findings are rarely dismissed as noise

- The prompt contract demands verify-before-report and precision over recall.
- `deep` adds an independent refutation call per finding (capped at 8,
  blockers first); refuted findings are dropped and the verdict recomputed.
  Unit-tested deterministically; live deep run kept 3/3 real findings.
- Anecdotal but real: across five dogfood reviews (M1–M5), every finding was
  judged fair by the author — several were fixed on the spot, none dismissed
  as hallucinated.

## 5. Adding a rule visibly shifts the review focus

Live (M2): a fixture that passed cleanly flips to `✘ BLOCK` after adding a
`no-template-literals` project rule — while a pre-existing violation outside
the diff is correctly left alone. Repeatable in the e2e suite.

## 6. A typical diff review fits a pre-commit budget

Live quick-profile runs: 19–33s, $0.03–0.04 per review. The 64 KB quick cap
refuses oversized diffs with a pointer to `--depth standard`, and
`AGENTLINT_SKIP=1` is the hook escape hatch.

## Bonus: the whole manual loop closes

Live (M5): `agentlint --fix --yes --commit` on a seeded-bug fixture went
block (3 blockers) → separate fixer run → re-review pass → generated commit
message → commit. The restored tests pass under `node`. ~2.5 minutes, ~$0.15.
