import { describe, expect, it } from 'vitest';
import { killProcessGroup } from '../src/platform/spawn';

// bug B：detached 子进程可能是多层进程树（如 npx→tsx→node→…），中间外壳不转发信号 →
// 单杀 child 会留孤儿。killProcessGroup 用负 pid 杀整组（child 须 detached 起）。注入
// kill/sleep，绝不真杀。

const noSleep = async (): Promise<void> => {};

function recorder() {
  const calls: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
  return {
    calls,
    kill: (target: number, signal: NodeJS.Signals | 0): void => {
      calls.push({ target, signal });
    },
  };
}

describe('killProcessGroup', () => {
  it('pid undefined（子进程没起来）→ no-op', async () => {
    const r = recorder();
    await killProcessGroup(undefined, () => true, { kill: r.kill, sleep: noSleep, isWindows: false });
    expect(r.calls).toEqual([]);
  });

  it('POSIX：SIGTERM 给负 pid（整组）；退出后不补 SIGKILL', async () => {
    const r = recorder();
    let exited = false;
    // 第一次 sleep 后视为已退
    const sleep = async (): Promise<void> => {
      exited = true;
    };
    await killProcessGroup(4321, () => exited, { kill: r.kill, sleep, isWindows: false, graceMs: 1000, pollMs: 100 });
    expect(r.calls).toEqual([{ target: -4321, signal: 'SIGTERM' }]); // 负 pid = 进程组，无 SIGKILL
  });

  it('POSIX：不退 → SIGTERM 后补 SIGKILL（都打负 pid）', async () => {
    const r = recorder();
    await killProcessGroup(4321, () => false, { kill: r.kill, sleep: noSleep, isWindows: false, graceMs: 5, pollMs: 1 });
    expect(r.calls[0]).toEqual({ target: -4321, signal: 'SIGTERM' });
    expect(r.calls.at(-1)).toEqual({ target: -4321, signal: 'SIGKILL' });
  });

  it('POSIX：整组已不存在（ESRCH）→ 收手，不补 SIGKILL', async () => {
    const calls: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
    const kill = (target: number, signal: NodeJS.Signals | 0): void => {
      calls.push({ target, signal });
      const e: NodeJS.ErrnoException = new Error('no such process');
      e.code = 'ESRCH';
      throw e;
    };
    await killProcessGroup(4321, () => false, { kill, sleep: noSleep, isWindows: false, graceMs: 5, pollMs: 1 });
    expect(calls).toEqual([{ target: -4321, signal: 'SIGTERM' }]); // 只试了一次，ESRCH 即停
  });

  it('POSIX：组不可用（非 ESRCH）→ 回退单杀 child 正 pid', async () => {
    const calls: Array<{ target: number; signal: NodeJS.Signals | 0 }> = [];
    const kill = (target: number, signal: NodeJS.Signals | 0): void => {
      if (target < 0) {
        const e: NodeJS.ErrnoException = new Error('perm');
        e.code = 'EPERM';
        throw e;
      }
      calls.push({ target, signal });
    };
    await killProcessGroup(4321, () => true, { kill, sleep: noSleep, isWindows: false, graceMs: 5, pollMs: 1 });
    expect(calls).toEqual([{ target: 4321, signal: 'SIGTERM' }]); // 回退到正 pid 单杀
  });

  it('Windows：走 taskkill /T 杀树，不用信号', async () => {
    const r = recorder();
    let killedPid: number | undefined;
    await killProcessGroup(4321, () => true, {
      kill: r.kill,
      sleep: noSleep,
      isWindows: true,
      taskkill: (p) => {
        killedPid = p;
      },
    });
    expect(killedPid).toBe(4321);
    expect(r.calls).toEqual([]); // 没用 POSIX 信号
  });
});
