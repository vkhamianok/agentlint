#!/usr/bin/env node
import { Command } from 'commander';

import pkg from '../package.json' with { type: 'json' };

const program = new Command();

program
  .name('agentlint')
  .description('A semantic review gate for agent-written code, powered by the Claude CLI')
  .version(pkg.version);

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
