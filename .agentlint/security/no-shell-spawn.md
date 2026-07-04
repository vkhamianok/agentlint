---
severity: blocker
---

# Never launch a subprocess through a shell

A shell turns a subprocess call into a string it re-parses: spaces, quotes,
`&`, `|`, `$()`, backticks all become operators. If any argument carries
attacker- or repo-controlled text, the shell runs it as a command. agentlint
spawns the `claude` CLI and `git` with values that come from untrusted
repository config, so a shell in that path is a command-injection hole. Pass an
explicit argv array to a direct spawn instead; the OS hands each element to the
child verbatim, with no re-parsing.

## Flag

- `execa(cmd, { shell: true })`, `execa.command(...)`, or any spawn where the
  command and its arguments are joined into one string;
- `child_process.exec` / `execSync` (they always use a shell) on anything but a
  fixed literal;
- building a command line by concatenating or interpolating variables, then
  handing it to a shell;
- a "fallback" that retries a failed argv spawn by re-running it through a shell.

## Do not flag

- `execa(cmd, [arg1, arg2], { ... })` with `shell` unset or `false` — arguments
  travel as a real array;
- a shell invocation whose every token is a hard-coded literal with no
  interpolation.

## Examples

### Bad

```js
await execa('claude', { shell: true, input: `-p ${model} ${promptPath}` });
```

### Good

```js
await execa('claude', ['-p', '--model', model, '--append-system-prompt-file', promptPath]);
```
