import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Best-effort: open `url` in the user's default browser. Returns whether we
 * even attempted it. Never throws — a failed launch is silently swallowed and
 * the caller always also prints the URL so the user can open it by hand.
 *
 * We only auto-open on a TTY: a detached service (launchd) has no user present,
 * so it must never try to pop a browser — it just falls back to printing.
 */
export function openUrl(url: string): boolean {
  if (!process.stdout.isTTY) return false;

  let cmd: string;
  let args: string[];
  switch (platform()) {
    case 'darwin':
      cmd = 'open';
      args = [url];
      break;
    case 'win32':
      // `start` is a cmd built-in; the empty "" is its (ignored) window title.
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
      break;
    default:
      cmd = 'xdg-open';
      args = [url];
  }

  try {
    // windowsHide: `cmd /c start` would otherwise flash a console window; the
    // browser it launches is a separate process, so hiding cmd doesn't affect it.
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {}); // launcher missing (e.g. no xdg-open) — ignore
    child.unref();
    return true;
  } catch {
    return false;
  }
}
