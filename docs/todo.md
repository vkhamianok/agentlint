# agentlint — TODO / open problems

## 1. Diff context should be a review option

A review always shows the reviewer the git diff with one fixed amount of
surrounding context. How much context it sees changes what it can judge:

- `-U3` — git's default, 3 lines around each change. Small, but it can hide
  where a variable or function is defined just outside the change.
- `-U12` — 12 lines around each change. Bounded; catches nearby context.
- `-W` / `--function-context` — the whole enclosing function. Complete context,
  but the diff can grow large.

Idea: let the caller choose the context amount per review — a flag (e.g.
`--context`) and/or a per-profile setting — instead of one hard-coded value.

## 2. A diff bigger than the size cap makes the commit fail

A review has a size cap (the `quick` profile caps the diff at 64 KB). When a
change is bigger than the cap, the review stops with an error. In the
pre-commit hook that error fails the whole commit, so a large but honest change
cannot be committed through the gate at all.

We need a way out. Possible directions (decide later):

- fall back to a profile with a bigger cap (or no cap) automatically;
- review a large change in parts and combine the results;
- make the cap per-profile / configurable, and let the hook degrade instead of
  hard-failing.
