import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGracefulInterrupt,
  INTERRUPT_DRAIN_TIMEOUT_MS,
  Semaphore,
  withIdleTimeout,
} from '../src/bot/watchdog';

async function* delayedValues<T>(values: Array<{ delayMs: number; value: T }>): AsyncGenerator<T> {
  for (const { delayMs, value } of values) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    yield value;
  }
}

async function* neverEnding<T>(first: T): AsyncGenerator<T> {
  yield first;
  await new Promise<never>(() => {});
}

describe('Semaphore', () => {
  it('blocks acquire calls beyond max until release is called', async () => {
    const sem = new Semaphore(2);
    const release1 = await sem.acquire();
    const release2 = await sem.acquire();

    let acquired = false;
    const third = sem.acquire().then((release) => {
      acquired = true;
      return release;
    });
    await Promise.resolve();
    expect(acquired).toBe(false);

    release1();
    const release3 = await third;
    expect(acquired).toBe(true);

    release2();
    release3();
  });

  it('releases waiters in FIFO order', async () => {
    const sem = new Semaphore(1);
    const release1 = await sem.acquire();
    const order: string[] = [];

    const second = sem.acquire().then((release) => {
      order.push('second');
      return release;
    });
    const third = sem.acquire().then((release) => {
      order.push('third');
      return release;
    });
    await Promise.resolve();
    expect(order).toEqual([]);

    release1();
    const release2 = await second;
    expect(order).toEqual(['second']);

    release2();
    const release3 = await third;
    expect(order).toEqual(['second', 'third']);
    release3();
  });
});

describe('withIdleTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes through every source value when each arrives before the idle timeout', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const out: string[] = [];
    const done = (async () => {
      for await (const value of withIdleTimeout(
        delayedValues([
          { delayMs: 10, value: 'a' },
          { delayMs: 10, value: 'b' },
        ]),
        50,
        onTimeout,
      )) {
        out.push(value);
      }
    })();

    await vi.advanceTimersByTimeAsync(10);
    expect(out).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(10);
    await done;

    expect(out).toEqual(['a', 'b']);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('calls onTimeout and ends the generator when the source goes idle', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const iter = withIdleTimeout(neverEnding('first'), 50, onTimeout)[Symbol.asyncIterator]();

    await expect(iter.next()).resolves.toEqual({ done: false, value: 'first' });
    const second = iter.next();
    await vi.advanceTimersByTimeAsync(50);

    await expect(second).resolves.toEqual({ done: true, value: undefined });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('directly passes through the source when idleMs is disabled', async () => {
    const onTimeout = vi.fn();
    const values: string[] = [];

    for await (const value of withIdleTimeout(delayedValues([{ delayMs: 1, value: 'a' }]), 0, onTimeout)) {
      values.push(value);
    }

    expect(values).toEqual(['a']);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('ends the generator when the stop signal resolves (⏹), without firing onTimeout', async () => {
    const onTimeout = vi.fn();
    let resolveStop!: () => void;
    const stop = new Promise<void>((res) => {
      resolveStop = res;
    });
    const out: string[] = [];
    const iter = withIdleTimeout(neverEnding('first'), 0, onTimeout, stop)[Symbol.asyncIterator]();

    await expect(iter.next()).resolves.toEqual({ done: false, value: 'first' });
    const second = iter.next();
    resolveStop();

    await expect(second).resolves.toEqual({ done: true, value: undefined });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  // QW-5: 活性与渲染解耦 — event-map 丢弃的原始通知（如命令输出 delta）也算活着。
  it('does not time out while raw activity continues, even with mapped events silent for 150s', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    let lastRaw = Date.now();
    let rawAlive = true; // 模拟原始通知持续到达（长命令输出），但没有可映射事件
    const heartbeat = setInterval(() => {
      if (rawAlive) lastRaw = Date.now();
    }, 1_000);
    const iter = withIdleTimeout(neverEnding('first'), 120_000, onTimeout, undefined, () => lastRaw)[
      Symbol.asyncIterator
    ]();

    await expect(iter.next()).resolves.toEqual({ done: false, value: 'first' });
    const second = iter.next();
    // 映射事件停了 150s（> 120s idle），但原始活动一直在 → 绝不超时
    await vi.advanceTimersByTimeAsync(150_000);
    expect(onTimeout).not.toHaveBeenCalled();

    // 原始活动也停了 → 距最后一次真实活动满 120s 才超时
    rawAlive = false;
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(second).resolves.toEqual({ done: true, value: undefined });
    expect(onTimeout).toHaveBeenCalledTimes(1);
    clearInterval(heartbeat);
  });

  it('re-arming keeps waiting on the same pending next() — a late value is not dropped', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    let lastRaw = Date.now();
    // 值在 80ms 后才到；idle 50ms 会先触发一次，但原始活动 30ms 时刷新过 → 重置后值必须照常产出
    async function* lateValue(): AsyncGenerator<string> {
      await new Promise<void>((res) => setTimeout(res, 80));
      yield 'late';
    }
    setTimeout(() => {
      lastRaw = Date.now();
    }, 30);
    const out: string[] = [];
    const done = (async () => {
      for await (const v of withIdleTimeout(lateValue(), 50, onTimeout, undefined, () => lastRaw)) out.push(v);
    })();

    await vi.advanceTimersByTimeAsync(80);
    await done;
    expect(out).toEqual(['late']);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('still passes through values when a stop signal is provided but unresolved', async () => {
    const onTimeout = vi.fn();
    const stop = new Promise<void>(() => {}); // never resolves
    const out: string[] = [];

    for await (const value of withIdleTimeout(
      delayedValues([
        { delayMs: 1, value: 'a' },
        { delayMs: 1, value: 'b' },
      ]),
      0,
      onTimeout,
      stop,
    )) {
      out.push(value);
    }

    expect(out).toEqual(['a', 'b']);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

// QW-15 ⏹ 优雅中断：interrupt → turn/interrupt → 等事件流自然 done（0.139+
// turn/completed(status:"interrupted") 干净收尾）→ 线程与进程留用；turnId 缺失
// 或超时没收尾才强停（forced → 调用方按旧样杀进程回收）。
describe('createGracefulInterrupt（QW-15 ⏹ 后进程留用）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('interrupt 发 abort（带 turnId），done 及时到达（dispose 先于超时）→ 不强停、不 forced（线程留用）', async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const forceStop = vi.fn();
    const stopper = createGracefulInterrupt({ turnId: () => 'turn_1', abort, forceStop });

    stopper.interrupt();
    expect(abort).toHaveBeenCalledWith('turn_1');
    expect(stopper.interrupted()).toBe(true);

    // 事件流在兜底窗口内自然收尾（消费循环结束后调 dispose）
    await vi.advanceTimersByTimeAsync(100);
    stopper.dispose();
    await vi.advanceTimersByTimeAsync(INTERRUPT_DRAIN_TIMEOUT_MS);

    expect(forceStop).not.toHaveBeenCalled();
    expect(stopper.forced()).toBe(false); // killed=false → sessions 保留、不 close
  });

  it('超时没收尾（旧版 codex / 挂死）→ 5s 强停本地循环，forced=true（杀进程恢复锤）', async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const forceStop = vi.fn();
    const stopper = createGracefulInterrupt({ turnId: () => 'turn_1', abort, forceStop });

    stopper.interrupt();
    expect(forceStop).not.toHaveBeenCalled(); // 先给自然收尾留窗口
    await vi.advanceTimersByTimeAsync(INTERRUPT_DRAIN_TIMEOUT_MS);

    expect(forceStop).toHaveBeenCalledTimes(1);
    expect(stopper.forced()).toBe(true); // killed=true → close()+sessions.delete
  });

  it('turnId 未到手（极早期点击）→ 立即强停（没法定向 interrupt，按旧路径杀进程）', () => {
    const abort = vi.fn();
    const forceStop = vi.fn();
    const stopper = createGracefulInterrupt({ turnId: () => undefined, abort, forceStop });

    stopper.interrupt();
    expect(abort).not.toHaveBeenCalled();
    expect(forceStop).toHaveBeenCalledTimes(1);
    expect(stopper.forced()).toBe(true);
  });

  it('幂等：连点 ⏹ 只发一次 abort', () => {
    const abort = vi.fn();
    const stopper = createGracefulInterrupt({ turnId: () => 'turn_1', abort, forceStop: vi.fn(), timeoutMs: 50 });
    stopper.interrupt();
    stopper.interrupt();
    expect(abort).toHaveBeenCalledTimes(1);
    stopper.dispose();
  });

  // 与 withIdleTimeout 的接线（launchRun 的真实组合）：abort 触发后端干净收尾 →
  // 消费循环吃到 done 自然结束，stop 信号全程未触发。
  it('integration: interrupt 后 done 及时到达 → 循环自然收尾（不经 stop 信号，线程留用）', async () => {
    let resolveStop!: () => void;
    const stopSignal = new Promise<void>((res) => {
      resolveStop = res;
    });
    let endSource!: () => void;
    const sourceEnd = new Promise<void>((res) => {
      endSource = res;
    });
    async function* source(): AsyncGenerator<string> {
      yield 'delta';
      await sourceEnd; // turn/interrupt → codex 发 turn/completed(interrupted)
      yield 'done';
    }
    const stopper = createGracefulInterrupt({
      turnId: () => 'turn_1',
      abort: () => endSource(), // 模拟 abort 让后端干净收尾
      forceStop: resolveStop,
    });
    const out: string[] = [];
    for await (const v of withIdleTimeout(source(), 0, () => {}, stopSignal)) {
      out.push(v);
      if (v === 'delta') stopper.interrupt();
    }
    stopper.dispose();
    expect(out).toEqual(['delta', 'done']); // done 正常流到渲染层
    expect(stopper.forced()).toBe(false);
  });

  it('integration: 流挂死 → 5s 后经 stop 信号强停循环（forced → 杀进程）', async () => {
    vi.useFakeTimers();
    let resolveStop!: () => void;
    const stopSignal = new Promise<void>((res) => {
      resolveStop = res;
    });
    async function* hung(): AsyncGenerator<string> {
      yield 'delta';
      await new Promise<never>(() => {}); // 旧版行为：interrupt 后流不收尾
    }
    const abort = vi.fn();
    const stopper = createGracefulInterrupt({ turnId: () => 'turn_1', abort, forceStop: () => resolveStop() });
    const out: string[] = [];
    const consume = (async () => {
      for await (const v of withIdleTimeout(hung(), 0, () => {}, stopSignal)) {
        out.push(v);
        stopper.interrupt();
      }
    })();
    await vi.advanceTimersByTimeAsync(INTERRUPT_DRAIN_TIMEOUT_MS);
    await consume;
    stopper.dispose();
    expect(abort).toHaveBeenCalledWith('turn_1');
    expect(out).toEqual(['delta']);
    expect(stopper.forced()).toBe(true);
  });
});

describe('Semaphore.hasFree', () => {
  it('reports free slots until max is reached, then again after release', async () => {
    const sem = new Semaphore(1);
    expect(sem.hasFree()).toBe(true);
    const release = await sem.acquire();
    expect(sem.hasFree()).toBe(false);
    release();
    expect(sem.hasFree()).toBe(true);
  });
});

// M-3: 排队可见（位置）+ 可取消（tryCancel waiter）。
describe('Semaphore.enqueue', () => {
  it('grants immediately (position 0) when a slot is free', async () => {
    const sem = new Semaphore(1);
    const q = sem.enqueue();
    expect(q.position()).toBe(0);
    const release = await q.acquired;
    expect(release).toBeTypeOf('function');
    release!();
  });

  it('exposes 1-based queue positions that advance as slots free up', async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    const q2 = sem.enqueue();
    const q3 = sem.enqueue();
    expect(q2.position()).toBe(1);
    expect(q3.position()).toBe(2);

    r1();
    const r2 = await q2.acquired;
    expect(q2.position()).toBe(0); // granted
    expect(q3.position()).toBe(1); // moved up

    r2!();
    const r3 = await q3.acquired;
    expect(r3).toBeTypeOf('function');
    r3!();
  });

  it('cancel removes the waiter: acquired resolves null and the slot skips it (FIFO preserved)', async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    const q2 = sem.enqueue();
    const q3 = sem.enqueue();

    expect(q2.cancel()).toBe(true);
    await expect(q2.acquired).resolves.toBeNull();
    expect(q2.cancel()).toBe(false); // already cancelled
    expect(q3.position()).toBe(1); // moved up past the cancelled waiter

    r1();
    const r3 = await q3.acquired;
    expect(r3).toBeTypeOf('function');
    r3!();
    expect(sem.hasFree()).toBe(true);
  });

  it('cancel after the slot was granted returns false (caller owns a normal release)', async () => {
    const sem = new Semaphore(1);
    const q1 = sem.enqueue();
    const release = await q1.acquired;
    expect(q1.cancel()).toBe(false);
    release!();
    expect(sem.hasFree()).toBe(true);
  });

  it('onAdvance fires with the new position when an earlier waiter is granted or cancelled', async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    const pos2: number[] = [];
    const pos3: number[] = [];
    const q2 = sem.enqueue((p) => pos2.push(p));
    const q3 = sem.enqueue((p) => pos3.push(p));

    q2.cancel(); // 前面的人取消 → q3 升到第 1 位
    expect(pos3).toEqual([1]);

    r1(); // 槽空出 → q3 直接拿到（不再有 onAdvance — 它已不在队列里）
    const r3 = await q3.acquired;
    expect(pos3).toEqual([1]);
    expect(pos2).toEqual([]); // 取消者自己不收通知
    r3!();
  });
});
