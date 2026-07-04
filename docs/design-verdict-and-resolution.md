# Design: verdict and resolution (target model)

This is the model we agreed to move toward. Not all of it is built yet.

## The problem it fixes

Today the reviewer outputs a top-level `verdict` (pass / block) AND a
`severity` on each finding. The two can disagree: a review once set
`verdict: block` while its only finding was a `warning`, and the commit was
blocked even though no finding reached the blocking threshold. The verdict was
a redundant "second opinion" that mostly produced false blocks.

## Two axes, at two levels

A finding and the run as a whole each carry two separate things:

- **assessment** — how bad it is. On a finding this is `severity`
  (blocker / warning / info), set by the reviewer. On the run it is `verdict`
  (pass / block), which is DERIVED, never set by the reviewer.
- **resolution** — what the actor (human or agent) decided to do about it.
  The same shape on a finding and on the run:
  `{ state: open | ignored, reason?, by?, at? }`, default `open`.

`resolution` is the one uniform variable across both levels. The assessment is
different by nature — a finding's severity has three levels, the run's verdict
is the two-level gate answer — and that is correct, because they measure
different things.

## The verdict is computed, never stored

`run.verdict` is a pure function of the findings and the config:

```
run.resolution == ignored                             -> pass
else some finding, resolution == open, severity >= failOn -> block
else                                                  -> pass
```

It depends on `failOn`, which can change per run (`--fail-on`), so it is
computed at gate time, never frozen. The cache stores the raw findings (with
severity and resolution) plus run metadata — not a frozen verdict.

## Ignore

- `agentlint ignore <finding-id> "reason"` sets that finding's resolution to
  ignored; it drops out of the derived verdict.
- `agentlint ignore --run "reason"` sets the run's resolution to ignored; the
  whole run passes.

Both are surgical and leave a trail (reason, who, when). This replaces the
blunt `AGENTLINT_SKIP`, which leaves no record. A code change invalidates the
cache key, so an ignore can never mask a problem in changed code.

Each finding needs a stable `id` — a short hash, like a git short sha —
computed when the result is produced and stored in the cache, so `ignore` has
something to point at and a re-run on unchanged code keeps the same id.

## Cache

- store the full result (findings with severity, id, resolution) plus
  metadata: profile, model, target, timestamp;
- store blocks too, not only passes, so an ignore has something to attach to;
- serve cached results deterministically (no more "re-run until it passes by
  luck"); the only ways past a block are to fix the code (new key -> fresh
  review) or an explicit ignore.

## Not in this model yet

A committed, team-wide baseline (see `todo.md` item 3) is separate and later.

## Build order

1. Derive the verdict: the reviewer stops authoring it; the gate, report, and
   cache compute pass / block from findings + failOn. (Fixes the bug above.)
2. Per-finding `id` + `resolution`, the `ignore` command, and caching blocks.
3. Run-level `resolution` (the reasoned replacement for `AGENTLINT_SKIP`).
4. Cache metadata (profile / model / target / timestamp).
