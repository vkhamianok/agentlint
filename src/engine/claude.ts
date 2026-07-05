import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { ExecaError, execa } from 'execa';

import { EngineError, type EngineRunOptions } from './types.js';

/**
 * The one and only place that spawns the Claude CLI.
 *
 * Flag set pinned against Claude Code 2.1.198:
 *   -p <prompt-via-stdin>     headless mode, prompt piped through stdin to
 *                             avoid Windows argv length limits on big diffs
 *   --output-format json      single JSON envelope on stdout
 *   --json-schema <schema>    CLI-side structured output validation;
 *                             validated object lands in envelope.structured_output.
 *                             MUST NOT contain a top-level $schema key: 2.1.198
 *                             then silently drops the StructuredOutput tool
 *   --tools <list>            restrict built-in tools ("" disables all)
 *   --permission-mode <mode>  "acceptEdits" for fixer runs only; reviews
 *                             never edit
 *   --append-system-prompt-file <path>
 *                             principles + rules + output contract, via a
 *                             temp file: the payload (~25KB with the default
 *                             library) exceeds cmd.exe's 8191-char limit and
 *                             crowds the 32767-char CreateProcess limit as
 *                             argv. Undocumented in --help but verified live
 *   --model <alias>           per profile
 *   --max-budget-usd <n>      hard cost cap per run
 *   --max-turns <n>           hard turn cap per run
 *   --no-session-persistence  reviews must not clutter the user's session list
 */

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

/** Overridable so tests can point the adapter at a stub binary. */
export function claudeBinary(): string {
  return process.env.AGENTLINT_CLAUDE_BIN ?? 'claude';
}

export async function runClaude(opts: EngineRunOptions): Promise<ClaudeEnvelope> {
  // Streaming (stream-json) only when a caller is watching the steps —
  // agents, hooks, CI, and tests take the plain single-envelope path.
  const streaming = Boolean(opts.onStep);
  const args = streaming
    ? ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence']
    : ['-p', '--output-format', 'json', '--no-session-persistence'];
  if (opts.jsonSchema) args.push('--json-schema', JSON.stringify(opts.jsonSchema));
  if (opts.tools) args.push('--tools', opts.tools.join(','));
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.model) args.push('--model', opts.model);
  if (opts.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  if (opts.maxTurns !== undefined) args.push('--max-turns', String(opts.maxTurns));

  // The system prompt travels via a temp file, never argv: with the rule
  // library enabled it is far past cmd.exe's command-line limit.
  let systemPromptFile: string | undefined;
  if (opts.appendSystemPrompt) {
    systemPromptFile = path.join(os.tmpdir(), `agentlint-system-${randomUUID()}.md`);
    await writeFile(systemPromptFile, opts.appendSystemPrompt, 'utf8');
    args.push('--append-system-prompt-file', systemPromptFile);
  }

  try {
    const stdout = streaming ? await spawnStreaming(args, opts) : await spawnClaude(args, opts);

    let envelope: ClaudeEnvelope;
    try {
      envelope = JSON.parse(stdout) as ClaudeEnvelope;
    } catch {
      throw new EngineError('Claude CLI did not print a JSON envelope', stdout.slice(0, 2000));
    }
    if (process.env.AGENTLINT_DEBUG) {
      console.error(`[agentlint debug] claude ${args.join(' ')}`);
      console.error(`[agentlint debug] envelope: ${stdout}`);
    }
    if (envelope.is_error) {
      throw new EngineError(`Claude CLI reported an error (${envelope.subtype})`, envelope.result);
    }
    return envelope;
  } finally {
    if (systemPromptFile) await rm(systemPromptFile, { force: true });
  }
}

// Always spawn with the args as a real array, never through a shell: shell
// mode joins them into one unescaped string, which would let a repo's own
// config (e.g. a crafted model name) inject shell commands — in a tool whose
// whole job is running untrusted code. execa 9 spawns npm .cmd shims on
// Windows directly, so no shell fallback is needed.
async function spawnClaude(args: string[], opts: EngineRunOptions): Promise<string> {
  const bin = claudeBinary();
  const result = await execa(bin, args, {
    input: opts.prompt,
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    reject: false as const,
  }).catch((e: unknown) => e as ExecaError);
  const { stdout, stderr } = (result ?? {}) as { stdout?: string; stderr?: string };
  return checkResult(result, bin, opts, stdout ?? '', stderr);
}

/**
 * The stream-json path: read NDJSON events as they arrive, surface each tool
 * the reviewer runs as a live step, and keep the final `result` event — which
 * is the same envelope the plain path returns.
 */
async function spawnStreaming(args: string[], opts: EngineRunOptions): Promise<string> {
  const bin = claudeBinary();
  const subprocess = execa(bin, args, {
    input: opts.prompt,
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    reject: false as const,
    // Stream stdout ourselves, but let execa keep draining and capturing
    // stderr: with --verbose, an undrained stderr pipe would back-pressure
    // the child into a stall, and its text is the error detail we report.
    buffer: { stdout: false, stderr: true },
  });

  let resultLine = '';
  if (subprocess.stdout) {
    const rl = readline.createInterface({ input: subprocess.stdout });
    rl.on('line', (line) => {
      if (!line.startsWith('{')) return;
      let event: StreamEvent;
      try {
        event = JSON.parse(line) as StreamEvent;
      } catch {
        return;
      }
      if (event.type === 'result') {
        resultLine = line;
      } else if (event.type === 'assistant') {
        for (const block of event.message?.content ?? []) {
          if (block?.type === 'tool_use') {
            const step = describeStep(block.name, block.input);
            if (step) opts.onStep?.(step);
          }
        }
      }
    });
  }

  const result = await subprocess.catch((e: unknown) => e as ExecaError);
  const stderr = (result as { stderr?: string }).stderr;
  return checkResult(result, bin, opts, resultLine, stderr);
}

interface StreamEvent {
  type?: string;
  message?: { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] };
}

/** A short human phrase for one tool call, or nothing for tools not worth showing. */
function describeStep(
  name: string | undefined,
  input: Record<string, unknown> | undefined,
): string | undefined {
  switch (name) {
    case 'Read': {
      const file = input?.file_path;
      return typeof file === 'string' ? `reading ${path.basename(file)}` : 'reading a file';
    }
    case 'Grep':
      return typeof input?.pattern === 'string'
        ? `searching "${clip(input.pattern)}"`
        : 'searching';
    case 'Glob':
      return typeof input?.pattern === 'string' ? `scanning ${clip(input.pattern)}` : 'scanning';
    default:
      return undefined; // StructuredOutput is the answer, not a step
  }
}

function clip(s: string): string {
  return s.length > 32 ? `${s.slice(0, 31)}…` : s;
}

/** Shared error handling and result extraction for both spawn paths. */
function checkResult(
  result: unknown,
  bin: string,
  opts: EngineRunOptions,
  output: string,
  stderr?: string,
): string {
  const err = result instanceof Error ? (result as ExecaError) : undefined;
  if (err?.timedOut) {
    throw new EngineError(
      `The Claude CLI run timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s. ` +
        'Try a deeper profile (--profile standard) or a smaller change.',
    );
  }
  if (err && err.exitCode === undefined) {
    throw new EngineError(
      `Could not run the Claude CLI ("${bin}"). Is Claude Code installed and on PATH?`,
      err.message,
    );
  }
  const exitCode = (result as { exitCode?: number }).exitCode;
  if (exitCode !== 0 && !output.trimStart().startsWith('{')) {
    throw new EngineError(`Claude CLI exited with code ${exitCode}`, stderr || output);
  }
  return output;
}
