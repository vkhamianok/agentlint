import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { emitReports } from '../../src/report/write.js';
import type { ReviewResult } from '../../src/schema.js';

const result: ReviewResult = {
  verdict: 'pass',
  summary: 'Clean.',
  findings: [],
  questions: [],
};
const meta = { target: 'diff', costUsd: 0.1, durationMs: 1000 };

async function tmpFile(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlint-write-'));
  return path.join(dir, name);
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

describe('emitReports', () => {
  it('writes a JSON file and returns nothing for stdout', async () => {
    const file = await tmpFile('out.json');
    const stdout = await emitReports(result, meta, { report: file });

    expect(stdout).toBeUndefined();
    const written = JSON.parse(await readFile(file, 'utf8')) as { verdict: string };
    expect(written.verdict).toBe('pass');
  });

  it('returns the JSON for stdout and writes no file when report is "-"', async () => {
    const stdout = await emitReports(result, meta, { report: '-' });
    expect(stdout).toBeTruthy();
    expect(JSON.parse(stdout!).verdict).toBe('pass');
  });

  it('writes a Markdown file independently of the JSON report', async () => {
    const md = await tmpFile('out.md');
    await emitReports(result, meta, { reportMd: md });
    expect(await readFile(md, 'utf8')).toContain('agentlint review');
  });

  it('honors --report - AND --report-md together (the stdout branch must not skip the md file)', async () => {
    const md = await tmpFile('out.md');
    const stdout = await emitReports(result, meta, { report: '-', reportMd: md });

    expect(stdout).toBeTruthy(); // JSON still goes to stdout
    expect(await exists(md)).toBe(true); // and the md file is still written
  });

  it('does nothing when no destination is set', async () => {
    expect(await emitReports(result, meta, {})).toBeUndefined();
  });
});
