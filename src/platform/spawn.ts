import type { ChildProcess, SpawnOptions, SpawnSyncOptions } from 'node:child_process';
import crossSpawn from 'cross-spawn';

/**
 * Cross-platform process spawn. **Use this instead of `node:child_process`
 * spawn/execFile for launching CLI binaries** (codex, lark-cli, …).
 *
 * On Windows an npm-installed bin is a `.cmd`/`.ps1` shim, and modern Node
 * (≥18.20 / 20.12) refuses to `spawn()` a `.cmd` directly — it throws `EINVAL`
 * (CVE-2024-27980 mitigation). `cross-spawn` transparently rewrites the call so
 * the shim runs, **without** `shell: true` (which would drag in cmd.exe quoting
 * and injection hazards). On macOS/Linux it's a near-transparent pass-through,
 * so existing POSIX behavior is unchanged.
 */
export function spawnProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  // windowsHide: the bridge spawns these as background helpers (codex app-server,
  // lark-cli). When the bridge itself runs with no console (the hidden Windows
  // background service), spawning a `.cmd`/console child would otherwise pop a
  // visible cmd.exe window — and closing it kills the whole codex tree. Hide it.
  return crossSpawn(command, [...args], { windowsHide: true, ...options });
}

type KillFn = (target: number, signal: NodeJS.Signals | 0) => void;

/** {@link killProcessGroup} 的可注入依赖（单测用，绝不真杀）。 */
export interface KillProcessGroupOpts {
  graceMs?: number;
  pollMs?: number;
  isWindows?: boolean;
  /** 注入 process.kill。 */
  kill?: KillFn;
  sleep?: (ms: number) => Promise<void>;
  /** Windows tree-kill（默认 taskkill /T /F）。 */
  taskkill?: (pid: number) => void;
}

/**
 * 杀掉一个 **detached 起的**子进程的**整个进程组**（连根拔起 npm/npx/tsx → node →
 * 孙子进程）。
 *
 * 【为什么需要】像用 `npx tsx` 起的 bin 类后端，spawn 出来的是
 * `npx → tsx → node` 一棵树；npm/npx **不转发信号给孙子**，所以 `child.kill('SIGTERM')`
 * 只打到外壳，node（及它经 PTY 拉起的子进程）会变孤儿。POSIX 上子进程以
 * `detached:true` 起即自成进程组（组长 pid = child.pid），`process.kill(-pid, …)`
 * 一次干掉整组。先 SIGTERM 给优雅窗口，超时 SIGKILL。Windows 无 POSIX 进程组 →
 * `taskkill /T /F` 杀进程树。绝不抛错。
 *
 * @param pid       child.pid（undefined ⇒ 没起来，直接返回）
 * @param hasExited 轮询判子进程是否已退（如 `() => child.exitCode !== null`）
 */
export async function killProcessGroup(
  pid: number | undefined,
  hasExited: () => boolean,
  opts: KillProcessGroupOpts = {},
): Promise<void> {
  if (pid === undefined) return;
  const isWin = opts.isWindows ?? process.platform === 'win32';
  const kill: KillFn = opts.kill ?? ((t, s) => void process.kill(t, s));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const graceMs = opts.graceMs ?? 4000;
  const pollMs = opts.pollMs ?? 200;

  if (isWin) {
    const taskkill =
      opts.taskkill ??
      ((p: number): void => {
        spawnProcess('taskkill', ['/pid', String(p), '/T', '/F'], { stdio: 'ignore' }).on('error', () => undefined);
      });
    try {
      taskkill(pid);
    } catch {
      /* ignore */
    }
    return;
  }

  // POSIX：负 pid = 进程组（child 须 detached 起才是组长）。
  const groupSignal = (signal: NodeJS.Signals): boolean => {
    try {
      kill(-pid, signal);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false; // 整组已没了 → 收手
      // 组不可用（child 没 detached / 权限）→ 回退单杀 child，至少别留外壳。
      try {
        kill(pid, signal);
      } catch {
        /* already dead */
      }
      return true;
    }
  };

  if (!groupSignal('SIGTERM')) return;
  for (let waited = 0; waited < graceMs; waited += pollMs) {
    await sleep(pollMs);
    if (hasExited()) return;
  }
  groupSignal('SIGKILL');
}

/** Synchronous counterpart of {@link spawnProcess} (same Windows `.cmd` + hide fix). */
export function spawnProcessSync(
  command: string,
  args: readonly string[] = [],
  options: SpawnSyncOptions = {},
) {
  return crossSpawn.sync(command, [...args], { windowsHide: true, ...options });
}

/**
 * Merge `overrides` into `base` (defaults to `process.env`) **case-insensitively**.
 * On Windows env keys are case-insensitive (`Path` ≡ `PATH`), so a naive spread
 * can leave two keys that disagree — child processes then read whichever the OS
 * picks. This dedupes by lowercased key, letting the override win.
 */
export function mergeProcessEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    for (const existing of Object.keys(out)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete out[existing];
    }
    if (value !== undefined) out[key] = value;
  }
  return out;
}
