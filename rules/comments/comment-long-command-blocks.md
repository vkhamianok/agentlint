---
severity: warning
---

# Long command blocks need a purpose comment

Imperative command sequences — shell scripts, CI steps, migrations, setup
code — do not carry intent the way named functions do. Once a logical block
grows past three command lines, a one-line comment saying what the block
achieves saves every future reader from simulating it in their head.

## Flag

- a logical block of more than three command lines with no comment stating
  its purpose;
- one giant unseparated sequence of commands doing several unrelated things
  (also split it into blocks with blank lines).

## Do not flag

- blocks of up to three lines;
- code where names already carry the intent (function bodies with clear
  calls) — this rule is about command-style sequences, not all code.

## Examples

### Bad

```sh
docker compose down
rm -rf data/postgres
docker compose up -d postgres
sleep 5
pnpm db:migrate && pnpm db:seed
```

### Good

```sh
# Rebuild the local database from scratch: fresh volume, schema, seed data.
docker compose down
rm -rf data/postgres
docker compose up -d postgres
sleep 5
pnpm db:migrate && pnpm db:seed
```
