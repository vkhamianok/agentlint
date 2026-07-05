#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';

import pkg from '../package.json' with { type: 'json' };
import { registerIgnore } from './commands/ignore.js';
import { registerInit } from './commands/init.js';
import { registerProfile } from './commands/profile.js';
import { registerReview } from './commands/review.js';
import { registerRule } from './commands/rule.js';
import { registerScope } from './commands/scope.js';
import { ConfigError } from './config.js';
import { ClaudeEngineError } from './engine/claude.js';
import { RuleError } from './rules.js';
import { TargetError } from './targets.js';

const program = new Command();

program
  .name('agentlint')
  .description('A semantic review gate for agent-written code, powered by the Claude CLI')
  .version(pkg.version);

registerReview(program);
registerInit(program);
registerRule(program);
registerProfile(program);
registerScope(program);
registerIgnore(program);

program.parseAsync().catch((err: unknown) => {
  if (
    err instanceof ClaudeEngineError ||
    err instanceof TargetError ||
    err instanceof RuleError ||
    err instanceof ConfigError
  ) {
    console.error(pc.red(err.message));
    if (err instanceof ClaudeEngineError && err.detail) console.error(pc.dim(err.detail));
  } else {
    console.error(err);
  }
  process.exit(2);
});
