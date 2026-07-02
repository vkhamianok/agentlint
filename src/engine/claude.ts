import { ExecaError, execa } from 'execa';

/**
 * The one and only place that spawns the Claude CLI.
 *
 * Flag set pinned against Claude Code 2.1.198 (verified on this machine, M0 spike):
 *   -p <prompt-via-stdin>     headless mode, prompt piped through stdin to
 *                             avoid Windows argv length limits on big diffs
 *   --output-format json      single JSON envelope on stdout
 *   --json-schema <schema>    CLI-side structured output validation;
 *                             validated object lands in envelope.structured_output.
 *                             MUST NOT contain a top-level $schema key: 2.1.198
 *                             then silently drops the StructuredOutput tool
 *   --tools <list>            restrict built-in tools ("" disables all)
 *   --append-system-prompt    principles + rules + output contract
 *   --model <alias>           per depth profile
 *   --max-budget-usd <n>      hard cost cap per run
 *   --max-turns <n>           hard turn cap per run
 *   --no-session-persistence  reviews must not clutter the user's session list
 */

export interface ClaudeRunOptions {
  prompt: string;
  appendSystemPrompt?: string;
  /** JSON Schema the CLI validates the structured output against. */
  jsonSchema?: object;
  /** Built-in tools to expose. Empty array = no tools at all. */
  tools?: string[];
  model?: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
  cwd?: string;
  timeoutMs?: number;
}

/** The envelope `--output-format json` prints on stdout (fields we rely on). */
export interface ClaudeEnvelope {
  type: 'result';
  subtype: string;
  is_error: boolean;
  result: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  session_id?: string;
  permission_denials?: unknown[];
}

export class ClaudeEngineError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ClaudeEngineError';
  }
}

/** Overridable so tests can point the adapter at a stub binary. */
export function claudeBinary(): string {
  return process.env.AGENTLINT_CLAUDE_BIN ?? 'claude';
}

export async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeEnvelope> {
  const args = ['-p', '--output-format', 'json', '--no-session-persistence'];
  if (opts.jsonSchema) args.push('--json-schema', JSON.stringify(opts.jsonSchema));
  if (opts.tools) args.push('--tools', opts.tools.join(','));
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
  if (opts.model) args.push('--model', opts.model);
  if (opts.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  if (opts.maxTurns !== undefined) args.push('--max-turns', String(opts.maxTurns));

  const stdout = await spawnClaude(args, opts);

  let envelope: ClaudeEnvelope;
  try {
    envelope = JSON.parse(stdout) as ClaudeEnvelope;
  } catch {
    throw new ClaudeEngineError('Claude CLI did not print a JSON envelope', stdout.slice(0, 2000));
  }
  if (process.env.AGENTLINT_DEBUG) {
    console.error(`[agentlint debug] claude ${args.join(' ')}`);
    console.error(`[agentlint debug] envelope: ${stdout}`);
  }
  if (envelope.is_error) {
    throw new ClaudeEngineError(
      `Claude CLI reported an error (${envelope.subtype})`,
      envelope.result,
    );
  }
  return envelope;
}

async function spawnClaude(args: string[], opts: ClaudeRunOptions): Promise<string> {
  const bin = claudeBinary();
  const execaOpts = {
    input: opts.prompt,
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    reject: false as const,
  };
  let result = await execa(bin, args, execaOpts).catch((e: unknown) => e as ExecaError);

  // npm-installed claude is a .cmd shim on Windows; Node refuses to spawn
  // those directly (EINVAL). Retry once through a shell.
  if (
    result instanceof Error &&
    'code' in result &&
    result.code === 'EINVAL' &&
    process.platform === 'win32'
  ) {
    result = await execa(bin, args, { ...execaOpts, shell: true }).catch(
      (e: unknown) => e as ExecaError,
    );
  }

  if (result instanceof Error && result.timedOut) {
    throw new ClaudeEngineError(
      `The Claude CLI run timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s. ` +
        'Try a deeper profile (--depth standard) or a smaller change.',
    );
  }
  if (result instanceof Error && result.exitCode === undefined) {
    throw new ClaudeEngineError(
      `Could not run the Claude CLI ("${bin}"). Is Claude Code installed and on PATH?`,
      result.message,
    );
  }
  const { exitCode, stdout, stderr } = result as {
    exitCode?: number;
    stdout: string;
    stderr: string;
  };
  if (exitCode !== 0 && !looksLikeEnvelope(stdout)) {
    throw new ClaudeEngineError(`Claude CLI exited with code ${exitCode}`, stderr || stdout);
  }
  return stdout;
}

function looksLikeEnvelope(stdout: string): boolean {
  return stdout.trimStart().startsWith('{');
}
