import pc from 'picocolors';

/**
 * Builds the label function and the runReview hooks that feed it. The label
 * grows in place: base → "· profile · model" once resolved → "· step" as the
 * reviewer works. Live steps only stream when stderr is a TTY, so agents and
 * hooks never trigger the streaming engine path.
 */
export function makeProgress(base: string): {
  label: () => string;
  hooks: {
    onStart: (i: { profile: string; model: string }) => void;
    onStep?: (step: string) => void;
  };
} {
  let meta = '';
  let step = '';
  const onStep = process.stderr.isTTY
    ? (s: string): void => {
        step = ` · ${s}`;
      }
    : undefined;
  return {
    label: () => `${base}${meta}${step}`,
    hooks: {
      onStart: (i) => {
        meta = ` · ${i.profile} · ${i.model}`;
        step = '';
      },
      onStep,
    },
  };
}

/**
 * A ticking status line for the humans staring at an otherwise silent
 * minute-long engine run. stderr-only and TTY-gated: agents, hooks with
 * captured output, and CI see nothing — their contract (stdout + exit
 * code) is untouched.
 *
 * The label is a function so it can grow while the run proceeds — the
 * profile and model land once the review resolves them, and a live step as
 * the reviewer works.
 */
export async function withProgress<T>(
  label: string | (() => string),
  work: () => Promise<T>,
): Promise<T> {
  if (!process.stderr.isTTY) return work();
  const render = typeof label === 'function' ? label : () => label;
  const startedAt = Date.now();
  const tick = (): boolean =>
    process.stderr.write(
      `\r\x1b[2K${pc.dim(`${render()} · ${Math.round((Date.now() - startedAt) / 1000)}s`)}`,
    );
  const timer = setInterval(tick, 1000);
  tick();
  try {
    return await work();
  } finally {
    clearInterval(timer);
    process.stderr.write('\r\x1b[2K'); // clear the whole line, whatever its length
  }
}
