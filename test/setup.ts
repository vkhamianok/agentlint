import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate os.homedir() so no unit test reads the developer's or CI runner's
// real ~/.agentlint — a global config or global rule there would silently
// shift verdicts and flip assertions between machines. An empty temp home
// makes every default-home review hermetic; tests that pass an explicit
// homeDir are unaffected.
//
// The e2e suite (AGENTLINT_E2E=1) is exempt: it spawns the real `claude` CLI,
// which inherits this process's env and finds its authenticated session under
// the real home — redirecting it would break the documented e2e command.
if (!process.env.AGENTLINT_E2E) {
  const isolatedHome = mkdtempSync(path.join(os.tmpdir(), 'agentlint-home-'));
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
}

// Pin the default engine to claude so a review under the default (model-less)
// config resolves without probing for installed CLIs — no `claude --version` /
// `codex --version` spawn during unit tests. Engine-resolution logic itself is
// tested directly with an injected detector, unaffected by this.
process.env.AGENTLINT_ENGINE ??= 'claude';
