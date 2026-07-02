import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';

import { ConfigError } from './config.js';

export interface InitStep {
  name: string;
  status: 'created' | 'updated' | 'skipped';
  detail: string;
}

const STARTER_CONFIG = `{
  "rules": [
    "library:root-cause",
    "library:errors",
    "library:comments",
    "library:structure",
    "library:naming",
    "library:prose"
  ]
}
`;

const RULES_README = `# Project rules

Every \`.md\` file in this directory is a review rule: it always loads, on
top of whatever \`.agentlint/config.json\` enables, and wins over library
and global rules when they conflict.

Manage rules with plain-language commands:

\`\`\`sh
npx agentlint rule add <describe what the rule should enforce>
npx agentlint rule edit <slug> <what to change>
npx agentlint rule delete <slug>
\`\`\`

Format reference: https://github.com/vkhamianok/agentlint/tree/master/rules
`;

const HOOK_LINE = 'npx agentlint review staged --depth quick';

/** Idempotent project setup; never overwrites what already exists. */
export async function initProject(opts: {
  repoRoot: string;
  hook: boolean;
  /** Injectable for tests; the default probes the real claude CLI. */
  checkEngine?: () => Promise<string>;
}): Promise<InitStep[]> {
  const version = await (opts.checkEngine ?? probeClaude)();
  const steps: InitStep[] = [
    { name: 'claude CLI', status: 'skipped', detail: `found (${version.trim()})` },
  ];

  steps.push(
    await createIfMissing(
      path.join(opts.repoRoot, '.agentlint', 'config.json'),
      STARTER_CONFIG,
      'config with the default rule library enabled',
    ),
  );
  steps.push(
    await createIfMissing(
      path.join(opts.repoRoot, '.agentlint', 'rules', 'README.md'),
      RULES_README,
      'project rules directory',
    ),
  );
  if (opts.hook) {
    steps.push(await wireHook(opts.repoRoot));
  }

  return steps;
}

async function probeClaude(): Promise<string> {
  const result = await execa('claude', ['--version'], { reject: false });
  if (result.exitCode !== 0) {
    throw new ConfigError(
      'The claude CLI is not available on PATH. agentlint runs reviews through ' +
        'Claude Code — install it first: https://claude.com/claude-code',
    );
  }
  return result.stdout;
}

async function createIfMissing(file: string, content: string, what: string): Promise<InitStep> {
  const name = path.basename(file) === 'README.md' ? path.dirname(file) : file;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
    return { name, status: 'created', detail: what };
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { name, status: 'skipped', detail: 'already exists, left untouched' };
    }
    throw err;
  }
}

async function wireHook(repoRoot: string): Promise<InitStep> {
  const hookFile = path.join(repoRoot, '.husky', 'pre-commit');
  let current: string;
  try {
    current = await readFile(hookFile, 'utf8');
  } catch (err) {
    // Only a missing hook means "husky is not set up"; anything else
    // (permissions, a directory in the way) must not be misreported.
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        name: hookFile,
        status: 'skipped',
        detail: `no husky pre-commit hook found — set up husky, then add: ${HOOK_LINE}`,
      };
    }
    throw err;
  }

  if (current.includes('agentlint')) {
    return { name: hookFile, status: 'skipped', detail: 'agentlint is already in the hook' };
  }
  await appendFile(hookFile, `${HOOK_LINE}\n`);
  return { name: hookFile, status: 'updated', detail: `appended: ${HOOK_LINE}` };
}
