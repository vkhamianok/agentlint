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

## 3. Committed baseline for accepted findings (future)

The per-finding ignore we plan first is local and temporary: it lives in the
git cache and dies when the code changes. It cannot help CI or a teammate on a
fresh clone. For that we would need a baseline — a committed file that records
accepted findings and is shared with everyone.

The hard part is the key. A finding's wording is not stable run to run, so we
cannot match on its text. Each baseline entry needs a fingerprint anchored to
the code, not to a line number — for example a hash of (file + the name of the
enclosing function or symbol + the rule or category) — so the suppression
survives edits and line shifts.

Sketch:

- `.agentlint/baseline.json`: entries of `{ fingerprint, reason, who, date }`;
- after a review, findings that match an entry become ignored, so CI sees the
  same result;
- `agentlint baseline add <id> "reason"` adds one entry; `agentlint baseline
accept` freezes every current finding and gates only new ones (the usual way
  to adopt a gate on an existing codebase);
- hygiene: `agentlint baseline prune` removes entries that no longer match any
  finding (the code was fixed), a reason is required on every entry, and the
  file is reviewed in pull requests.

Risk: a baseline is a debt magnet — it is tempting to accept everything and
quietly make the gate toothless. Keep it small, reasoned, and pruned.

Deferred — maybe a later version.
