import { beforeEach, describe, expect, it, vi } from 'vitest';

import { collectAnswers, confirmFindings } from '../../src/commands/interactive.js';
import type { Finding } from '../../src/schema.js';

vi.mock('node:readline/promises', () => ({
  default: { createInterface: vi.fn() },
}));

const readline = (await import('node:readline/promises')).default;

const question = vi.fn<(q: string) => Promise<string>>();
const close = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readline.createInterface).mockReturnValue({ question, close } as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

function finding(title: string): Finding {
  return {
    file: 'a.js',
    line: 1,
    severity: 'blocker',
    title,
    what: 'w',
    why: 'y',
    fixes: ['f'],
    confidence: 'high',
  };
}

describe('collectAnswers', () => {
  it('returns nothing for an empty question list without touching readline', async () => {
    expect(await collectAnswers([])).toEqual([]);
    expect(readline.createInterface).not.toHaveBeenCalled();
  });

  it('collects trimmed answers and skips empty ones', async () => {
    question.mockResolvedValueOnce('  throw, do not clamp  ').mockResolvedValueOnce('   ');

    const answers = await collectAnswers(['Clamp or throw?', 'Rename the helper?']);

    expect(answers).toEqual([{ question: 'Clamp or throw?', answer: 'throw, do not clamp' }]);
    expect(close).toHaveBeenCalled();
  });
});

describe('confirmFindings', () => {
  it('confirms everything without prompting when yes is set', async () => {
    const findings = [finding('one'), finding('two')];
    expect(await confirmFindings(findings, true)).toEqual(findings);
    expect(readline.createInterface).not.toHaveBeenCalled();
  });

  it('treats empty, y, and yes as confirmation and anything else as decline', async () => {
    question
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('YES')
      .mockResolvedValueOnce('n')
      .mockResolvedValueOnce('whatever');

    const confirmed = await confirmFindings(
      [finding('a'), finding('b'), finding('c'), finding('d')],
      false,
    );

    expect(confirmed.map((f) => f.title)).toEqual(['a', 'b']);
    expect(close).toHaveBeenCalled();
  });
});
