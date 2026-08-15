/**
 * open-external.ts — hand a file or URL to whatever the desktop uses to open it.
 *
 * Separate from `launch.ts` because the two are different questions. `launch` needs a TERMINAL, and
 * which terminal is a matter of taste, so it is configurable. This needs the *default handler*, which
 * the OS already knows and the operator already chose — there is nothing here to configure.
 *
 * Detached and unref'd: a page the operator reads for ten minutes must not hold ayin's event loop
 * open, and closing ayin must not close their browser tab.
 */

import { spawn } from 'node:child_process';

export function openExternal(target: string): boolean {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [target]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
    : ['xdg-open', [target]];
  try {
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' });
    child.unref();
    // spawn reports a missing binary asynchronously, so `false` here means "definitely failed"
    // rather than "succeeded" — the caller always prints the path as well.
    child.on('error', () => {});
    return true;
  } catch {
    return false;
  }
}
