import { describe, expect, it } from 'vitest';
import { stopSelfHostedDaemon } from '../src/cli/commands/daemon-control';

// 验「Web 点停止停不掉自托管 daemon」的修复：stopSelfHostedDaemon 按 web-console.json
// 的 pid 发 SIGTERM（触发 daemon 自身级联优雅停），超时 SIGKILL。全程依赖注入，绝不
// 真杀进程。kill 用模拟：signal 0 = 活性探测（死了抛 ESRCH），SIGTERM/SIGKILL 推进
// 状态机。

interface KillCfg {
  /** SIGTERM 前的活性（false = pid 已死，根本不会发 SIGTERM）。 */
  aliveBeforeTerm?: boolean;
  /** SIGTERM 后还「活」几次探测（Infinity = 忽略 SIGTERM 永不退 → 需 SIGKILL）。 */
  termGraceProbes?: number;
  /** SIGKILL 后还「活」几次探测（默认 0 = 立刻死）。 */
  killGraceProbes?: number;
  /** 让 SIGTERM 本身抛 ESRCH（读到 pid 后、signal 前进程刚退的竞态）。 */
  throwOnTerm?: NodeJS.ErrnoException['code'];
}

function makeKill(cfg: KillCfg) {
  const signals: Array<NodeJS.Signals | 0> = [];
  const aliveBeforeTerm = cfg.aliveBeforeTerm ?? true;
  const termGrace = cfg.termGraceProbes ?? 0;
  const killGrace = cfg.killGraceProbes ?? 0;
  let terminated = false;
  let killed = false;
  let probesSinceTerm = 0;
  let probesSinceKill = 0;

  const esrch = (): never => {
    const e: NodeJS.ErrnoException = new Error('kill ESRCH');
    e.code = 'ESRCH';
    throw e;
  };

  const kill = (_pid: number, signal: NodeJS.Signals | 0): void => {
    if (signal === 0) {
      let alive: boolean;
      if (killed) alive = probesSinceKill++ < killGrace;
      else if (terminated) alive = probesSinceTerm++ < termGrace;
      else alive = aliveBeforeTerm;
      if (!alive) esrch();
      return;
    }
    signals.push(signal);
    if (signal === 'SIGTERM') {
      if (cfg.throwOnTerm) {
        const e: NodeJS.ErrnoException = new Error('kill term');
        e.code = cfg.throwOnTerm;
        throw e;
      }
      terminated = true;
    }
    if (signal === 'SIGKILL') killed = true;
  };
  return { kill, signals };
}

const noSleep = async (): Promise<void> => {};

describe('stopSelfHostedDaemon · 修「Web 点停止停不掉」', () => {
  it('没有在跑的 daemon（发现文件无）→ no-daemon，不发任何信号', async () => {
    const { kill, signals } = makeKill({});
    const r = await stopSelfHostedDaemon({ readDaemonPid: () => undefined, kill, sleep: noSleep });
    expect(r).toBe('no-daemon');
    expect(signals).toEqual([]);
  });

  it('发现文件指向 helper 自己 → no-daemon（绝不自杀）', async () => {
    const { kill, signals } = makeKill({});
    const r = await stopSelfHostedDaemon({ readDaemonPid: () => 4242, kill, selfPid: 4242, sleep: noSleep });
    expect(r).toBe('no-daemon');
    expect(signals).toEqual([]);
  });

  it('pid 已死（崩溃残留）→ no-daemon，不发 SIGTERM', async () => {
    const { kill, signals } = makeKill({ aliveBeforeTerm: false });
    const r = await stopSelfHostedDaemon({ readDaemonPid: () => 9999, kill, sleep: noSleep });
    expect(r).toBe('no-daemon');
    expect(signals).toEqual([]);
  });

  it('优雅退出：SIGTERM 后窗口内退出 → stopped，只发 SIGTERM 不发 SIGKILL', async () => {
    const { kill, signals } = makeKill({ termGraceProbes: 2 });
    const r = await stopSelfHostedDaemon({
      readDaemonPid: () => 1234,
      kill,
      sleep: noSleep,
      graceMs: 10_000,
      pollMs: 100,
    });
    expect(r).toBe('stopped');
    expect(signals).toEqual(['SIGTERM']);
  });

  it('卡死忽略 SIGTERM：窗口内不退 → force-killed，SIGTERM 后再 SIGKILL', async () => {
    const { kill, signals } = makeKill({ termGraceProbes: Number.POSITIVE_INFINITY });
    const r = await stopSelfHostedDaemon({
      readDaemonPid: () => 1234,
      kill,
      sleep: noSleep,
      graceMs: 5,
      pollMs: 1,
    });
    expect(r).toBe('force-killed');
    expect(signals[0]).toBe('SIGTERM');
    expect(signals).toContain('SIGKILL');
  });

  it('读到 pid 后、SIGTERM 前进程刚退（ESRCH）→ no-daemon，不抛', async () => {
    const { kill, signals } = makeKill({ throwOnTerm: 'ESRCH' });
    const r = await stopSelfHostedDaemon({ readDaemonPid: () => 1234, kill, sleep: noSleep });
    expect(r).toBe('no-daemon');
    expect(signals).toEqual(['SIGTERM']); // 尝试发了，但 ESRCH 被吞
  });
});
