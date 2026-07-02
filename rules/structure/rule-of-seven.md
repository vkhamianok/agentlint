---
severity: warning
---

# Rule of 7±2

A flat list of more than about seven entities — functions in a file, files
in a folder, options in a config block, sections in a document — is a
candidate for grouping by some meaningful attribute. Humans hold about
seven things in working memory; past that, a flat list stops being
scannable.

## Flag

- clear offenders only: a flat structure well past seven entries that has
  an obvious grouping attribute (by domain, by lifecycle, by layer) and
  a change that keeps piling into it;
- a new module or document born with a dozen siblings at one level.

## Do not flag

- borderline cases of eight or nine — the rule is a heuristic, not a
  ceiling;
- lists that are inherently flat and homogeneous (locale files, migration
  folders, generated code).

## Examples

### Bad

```
src/helpers/  (14 files: dates.ts, money.ts, s3.ts, email.ts, jwt.ts, ...)
```

### Good

```
src/format/   dates.ts, money.ts
src/integrations/  s3.ts, email.ts
src/auth/     jwt.ts
```
