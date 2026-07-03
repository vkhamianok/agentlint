# Problem: No Review Gate for Agent-Written Code

## 1. Background

More and more code is written by coding agents (Claude Code and similar tools). The human's role shifts: from writing code to reviewing it. The agent produces the change; the human decides if it is good enough to keep.

This project starts from one developer's daily workflow, but the problem is general: anyone who lets agents write code needs a way to check that code before it enters the project history.

## 2. Current Workflow and Pain Points

The current loop looks like this:

1. Ask a coding agent to make a change, with the instruction "do not commit".
2. Read the uncommitted diff by eye.
3. Either ask the agent to fix things, or approve and ask it to commit.
4. Repeat.

This works, but it does not scale:

- **The human is the bottleneck.** Every change, even a routine one, waits for a manual read-through.
- **Agents sometimes produce plausible-looking but wrong code.** The code compiles, looks clean, and still does the wrong thing: a subtle logic bug, a silently swallowed error, a copy-pasted block that ignores the project's existing utilities, a "fix" that deletes the failing test.
- **Existing tools do not catch this.** ESLint, tsc, and formatters check syntax, style, and types. They do not check intent, correctness, or project conventions. Tests help, but agents write the tests too — and a bad change often comes with tests that pass.
- **The writing agent cannot review itself.** Asking the same agent "now check your work" does not help much: it reviews inside the same context, with the same blind spots, and is biased toward approving what it just wrote.
- **Review quality drifts.** A tired human skims. An agent reviewer applies the same rigor at 2 AM as at 10 AM.

## 3. Problem Statement

There is no automated, configurable, semantic review gate between "an agent wrote code" and "that code enters history". ESLint guards style and syntax on a pre-commit hook; nothing comparable guards meaning. The result: either the human reads every diff (slow), or unreviewed agent code gets committed (risky).

## 4. Required Capabilities

Any solution must provide the following. This is a list of requirements, not a design.

### Review targets

The reviewer must be able to check:

- the **uncommitted working-tree diff** (the default case),
- the **staged diff**,
- the **last commit**, a **specific commit**, or a **commit range**,
- the **full project snapshot** (everything, not just a diff).

### Independence and intent

- The reviewer is **independent** of the agent that wrote the code: a fresh context, its own principles and rules, no memory of the writing session. It judges the change on its own merits.
- The reviewer accepts an **optional task description** — what the change was supposed to do (passed as an argument, read from a task file, or taken from the commit message). With it, the reviewer can check the change against intent. Without it, the review honestly degrades to a general quality review.

### Principles and rules

- The reviewer ships with **built-in general review principles** (correctness, simplicity, reuse of existing code, error handling, no dead code, and so on).
- The user can define **rules** — per project and/or globally — that **override or focus** those principles. Example: "in this repo, flag any direct DB access outside the repository layer" or "ignore formatting entirely".
- TypeScript is the first-class stack, but nothing in the design may be TypeScript-only. Other stacks must work.

### Findings

- Every finding reports three things: **what is wrong**, **why it matters** (with a severity level), and **one or two candidate ways to fix it**. The user should be able to decide in seconds, without re-investigating the code themselves.
- Output is **structured** (machine-readable and human-readable), so it can be printed in a terminal, saved as a report, or consumed by another tool.

### Gate semantics

- The reviewer exits **non-zero when blocking findings exist**, and zero when the change is clean — exactly like ESLint. This makes it usable as a husky pre-commit hook and as a CI step.
- Severity thresholds decide what blocks and what is only reported.

### Interaction model

- The reviewer runs **standalone**, outside any interactive agent session, using the locally installed `claude` CLI.
- The user **stays in the loop but is not a micromanager**: obvious decisions are made autonomously; only genuine forks (two defensible options, unclear intent) are escalated to the user.
- Escalation applies to **manual runs**. In hook or CI mode there is no one to ask: the run reduces to pass/block plus a report, and open questions appear in the report.

### Fixing

- Opt-in **auto-fix**: a separate fixer applies confirmed findings, and the
  gate re-reviews the result once. The reviewer never edits; the fixer never
  judges.

## 5. Non-Goals

- **Not a replacement for ESLint, tsc, or tests.** Those stay. This gate sits above them and checks what they cannot.
- **Not a replacement for the human on architecture.** Big design decisions stay with the user.
- **Not the committer.** The gate judges, the caller acts: exit code `0` is the "safe to commit" signal for whoever invoked the review.
- **Not a generic CI platform.** It is one focused tool: review a change, report findings, pass or block.

## 6. Success Criteria

The problem is solved when:

- The user no longer eyeballs routine diffs; they read findings instead.
- A seeded bad diff (planted logic bug, deleted test, ignored convention) is **blocked**; a clean diff **passes**.
- Every finding comes with a fix path the user can act on immediately.
- Findings are rarely dismissed as noise. A gate that cries wolf gets disabled within a week and solves nothing — so the reviewer verifies a finding before reporting it, and precision beats recall.
- Adding a rule visibly shifts what the reviewer focuses on.
- A typical diff review fits a tolerable pre-commit budget in both time and cost.

## 7. Constraints and Assumptions

- **The reviewer is an LLM, not a linter.** Reviews are non-deterministic and cost real money and latency, unlike ESLint. The design must respect this tension with the pre-commit use case (for example: fast/cheap defaults for hooks, deeper modes on demand).
- Runs on the developer's machine using the **installed `claude` CLI** and the user's existing credentials. No separate API key management.
- Must work on **Windows** (the primary dev machine) as well as POSIX systems.
- Projects under review are **git repositories**.
