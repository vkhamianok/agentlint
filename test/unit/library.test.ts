import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';

import { severities } from '../../src/schema.js';

/**
 * The format contract for every shipped rule file: valid severity in the
 * frontmatter, an H1 title, and Bad/Good examples. Prose sections stay free
 * form, but the skeleton is what makes rules predictable to read and tune.
 */
const LIBRARY_ROOT = path.join(import.meta.dirname, '..', '..', 'rules');

async function libraryFiles(): Promise<string[]> {
  const categories = (await readdir(LIBRARY_ROOT, { withFileTypes: true })).filter((e) =>
    e.isDirectory(),
  );
  const files: string[] = [];
  for (const category of categories) {
    const entries = await readdir(path.join(LIBRARY_ROOT, category.name));
    files.push(...entries.filter((f) => f.endsWith('.md')).map((f) => path.join(category.name, f)));
  }
  return files;
}

describe('rules library format', () => {
  it('has at least the six documented categories', async () => {
    const categories = (await readdir(LIBRARY_ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(categories).toEqual(
      expect.arrayContaining(['comments', 'errors', 'naming', 'prose', 'root-cause', 'structure']),
    );
  });

  it('every rule file follows the format contract', async () => {
    const files = await libraryFiles();
    expect(files.length).toBeGreaterThanOrEqual(15);

    for (const file of files) {
      const raw = await readFile(path.join(LIBRARY_ROOT, file), 'utf8');
      const { data, content } = matter(raw);

      expect(Object.keys(data), `${file}: frontmatter keys`).toEqual(['severity']);
      expect(severities, `${file}: severity value`).toContain(data.severity);
      expect(content, `${file}: H1 title`).toMatch(/^# .+/m);
      expect(content, `${file}: Flag section`).toContain('## Flag');
      expect(content, `${file}: Examples section`).toContain('## Examples');
      expect(content, `${file}: Bad example`).toContain('### Bad');
      expect(content, `${file}: Good example`).toContain('### Good');
    }
  });
});
