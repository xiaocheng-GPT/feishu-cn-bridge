import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Current git branch of `cwd`, or null if not a git repo / detached / error.
 * Lazy-read (design §3.2): called on inbound message / run end to refresh
 * the pinned banner.
 */
export async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeout: 3000,
      // Hide the console window: this runs on every inbound message, and the
      // Windows background service has no console of its own to inherit.
      windowsHide: true,
    });
    const b = stdout.trim();
    return b && b !== 'HEAD' ? b : null;
  } catch {
    return null;
  }
}
