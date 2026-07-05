import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type ExecaError, execa } from 'execa';

import { EngineError, type EngineResult, type EngineRunOptions } from './types.js';

/**
 * The codex adapter (OpenAI Codex CLI). Verified against codex-cli 0.142.4:
 *   exec                       run non-interactively
 *   -                          prompt read from stdin (avoids argv limits)
 *   --output-schema <file>     constrain the final message to a JSON Schema;
 *                              that message is the structured output
 *   -o <file>                  write the final message to a file, which we read
 *   --sandbox read-only|workspace-write   read-only for reviews, workspace-write
 *                              for the fixer — the analogue of claude's tools/
 *                              permission-mode
 *   --model <model>            per profile
 *   --cd <dir> / --ephemeral / --skip-git-repo-check / --color never
 *
 * codex has no system-prompt channel (folded into the prompt), no per-run USD
 * cap (maxBudgetUsd is a no-op — the run is bounded by the profile timeout),
 * and does not report cost in USD, so total_cost_usd is left undefined.
 */

/** Overridable so tests can point the adapter at a stub binary. */
export function codexBinary(): string {
  return process.env.AGENTLINT_CODEX_BIN ?? 'codex';
}

// Validation keywords OpenAI's strict json-schema mode does not accept; they
// ride along from zod (looseObject, .min(1), etc.) and must be dropped.
const UNSUPPORTED_KEYWORDS = [
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'uniqueItems',
  'pattern',
  'format',
  'default',
  'minContains',
  'maxContains',
];

/**
 * Reshapes a JSON Schema (built for claude) into the strict form OpenAI's
 * structured output demands: every object forbids additional properties and
 * lists all of its properties as required, and unsupported validation keywords
 * are stripped. Every property in our schemas is required already, so making
 * `required` exhaustive changes nothing about what a valid answer looks like.
 */
export function toStrictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toStrictSchema);
  if (node === null || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYWORDS.includes(key)) continue;
    // additionalProperties must be a literal false, never a sub-schema.
    out[key] = key === 'additionalProperties' ? undefined : toStrictSchema(value);
  }

  if (out.properties && typeof out.properties === 'object') {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as Record<string, unknown>);
  }
  return out;
}

export async function runCodex(opts: EngineRunOptions): Promise<EngineResult> {
  const bin = codexBinary();
  const sandbox = opts.permissionMode === 'acceptEdits' ? 'workspace-write' : 'read-only';
  const outFile = path.join(os.tmpdir(), `agentlint-codex-out-${randomUUID()}.json`);
  const temps = [outFile];

  const args = [
    'exec',
    '--sandbox',
    sandbox,
    '--ephemeral',
    '--skip-git-repo-check',
    '--color',
    'never',
    '-o',
    outFile,
  ];
  if (opts.cwd) args.push('--cd', opts.cwd);
  if (opts.model) args.push('--model', opts.model);
  if (opts.jsonSchema) {
    const schemaFile = path.join(os.tmpdir(), `agentlint-codex-schema-${randomUUID()}.json`);
    // codex's --output-schema feeds OpenAI's *strict* structured-output
    // validator, which is far pickier than claude's --json-schema: every object
    // must forbid extra keys and list all its properties as required, and the
    // loose validation keywords our zod schema emits (minItems, etc.) are
    // rejected outright. Reshape the schema to satisfy it.
    await writeFile(schemaFile, JSON.stringify(toStrictSchema(opts.jsonSchema)), 'utf8');
    temps.push(schemaFile);
    args.push('--output-schema', schemaFile);
  }
  args.push('-'); // prompt via stdin

  // codex has no separate system-prompt channel: prepend it to the prompt.
  const prompt = opts.appendSystemPrompt
    ? `${opts.appendSystemPrompt}\n\n---\n\n${opts.prompt}`
    : opts.prompt;

  try {
    // Spawn with an argv array, never a shell — a repo's own config (a crafted
    // model name) must not be able to inject commands.
    const result = await execa(bin, args, {
      input: prompt,
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      reject: false as const,
    }).catch((e: unknown) => e as ExecaError);

    const err = result instanceof Error ? (result as ExecaError) : undefined;
    if (err?.timedOut) {
      throw new EngineError(
        `The codex CLI run timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s. ` +
          'Try a smaller change, or a profile with a longer timeout.',
      );
    }
    if (err && (err as { exitCode?: number }).exitCode === undefined) {
      throw new EngineError(
        `Could not run the codex CLI ("${bin}"). Is codex installed and on PATH?`,
        err.message,
      );
    }
    const exitCode = (result as { exitCode?: number }).exitCode;
    const stderr = (result as { stderr?: string }).stderr;
    if (exitCode !== 0) {
      throw new EngineError(`codex CLI exited with code ${exitCode}`, stderr);
    }

    let last = '';
    try {
      last = (await readFile(outFile, 'utf8')).trim();
    } catch {
      // No output file means codex produced no final message — treat as empty,
      // which the caller's prose-salvage path handles.
    }
    if (process.env.AGENTLINT_DEBUG) {
      console.error(`[agentlint debug] codex ${args.join(' ')}`);
      console.error(`[agentlint debug] last message: ${last}`);
    }

    let structured: unknown;
    if (opts.jsonSchema && last) {
      try {
        structured = JSON.parse(last);
      } catch {
        // --output-schema should keep it valid; if not, salvage handles it.
      }
    }
    return { result: last, structured_output: structured, total_cost_usd: undefined };
  } finally {
    await Promise.all(temps.map((f) => rm(f, { force: true })));
  }
}
