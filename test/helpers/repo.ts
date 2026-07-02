import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';

/** Creates a throwaway git repo with one committed file. */
export async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlint-test-'));
  await git(dir, 'init');
  await git(dir, 'config', 'user.email', 'test@agentlint.local');
  await git(dir, 'config', 'user.name', 'agentlint test');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(dir, 'hello.js'), 'export const hello = () => "hello";\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-m', 'initial');
  return dir;
}

export async function git(cwd: string, ...args: string[]): Promise<void> {
  await execa('git', args, { cwd });
}

export async function write(dir: string, file: string, content: string): Promise<void> {
  await writeFile(path.join(dir, file), content);
}
