import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ReviewResult } from '../schema.js';
import { type ReportMeta, buildJsonReport } from './json.js';
import { renderMarkdownReport } from './markdown.js';

export interface ReportDest {
  /** A file path, or "-" for JSON on stdout. */
  report?: string;
  reportMd?: string;
}

/**
 * The single report-emission path, shared by a completed review and the
 * empty "nothing to review" case. `--report` and `--report-md` are
 * independent: either, both, or neither may be set, and "-" only ever routes
 * the JSON report to stdout. Returns the string to print to stdout (the
 * `--report -` payload), or undefined when nothing goes there.
 */
export async function emitReports(
  result: ReviewResult,
  meta: ReportMeta,
  dest: ReportDest,
): Promise<string | undefined> {
  let stdout: string | undefined;
  if (dest.report === '-') {
    stdout = JSON.stringify(buildJsonReport(result, meta));
  } else if (dest.report) {
    await writeReportFile(
      dest.report,
      JSON.stringify(buildJsonReport(result, meta), null, 2) + '\n',
    );
  }
  if (dest.reportMd) {
    await writeReportFile(dest.reportMd, renderMarkdownReport(result, meta));
  }
  return stdout;
}

async function writeReportFile(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, content);
}
