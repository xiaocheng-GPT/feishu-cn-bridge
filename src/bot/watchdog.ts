/**
 * Wrap an async iterable with a per-event idle timeout and an optional external
 * stop signal. If no event arrives within `idleMs`, calls `onTimeout()` and
 * ends the stream (the caller's onTimeout should abort the underlying turn).
 * If `stop` resolves, the stream ends immediately — ⏹ 终止的**兜底**路径（见
 * {@link createGracefulInterrupt}：0.139+ 的正常路径是发 turn/interrupt 后等
 * 事件流自然 done；只有 turnId 未到手或超时没收尾才用 stop 强停本地循环）。
 * `idleMs <= 0` disables the idle timer.
 *
 * `lastActivity` decouples LIVENESS from RENDERING: the event map drops raw
 * notifications it doesn't surface (e.g. command output deltas), so a long
 * shell command can stream output for minutes while yielding nothing here.
 * When the idle timer fires we check the backend's real activity clock — if it
 * moved within `idleMs`, re-arm for the remainder instead of killing the turn.
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  idleMs: number,
  onTimeout: () => void,
  stop?: Promise<unknown>,
  lastActivity?: () => number,
): AsyncGenerator<T> {
  if ((!idleMs || idleMs <= 0) && !stop) {
    yield* source;
    return;
  }
  const iter = source[Symbol.asyncIterator]();
  const stopRace = stop?.then(() => '__stop__' as const);
  // Re-arming must keep waiting on the SAME pending next() — an async generator
  // queues a second next() behind the first, so racing a fresh one each lap
  // would silently drop the value the abandoned call eventually resolves with.
  let pendingNext: Promise<IteratorResult<T>> | undefined;
  let timerMs = idleMs;
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    pendingNext ??= iter.next();
    const races: Promise<IteratorResult<T> | '__idle__' | '__stop__'>[] = [pendingNext];
    if (idleMs && idleMs > 0) {
      races.push(new Promise<'__idle__'>((res) => {
        timer = setTimeout(() => res('__idle__'), timerMs);
      }));
    }
    if (stopRace) races.push(stopRace);
    const raced = await Promise.race(races);
    if (timer) clearTimeout(timer);
    if (raced === '__idle__') {
      const sinceActivity = lastActivity ? Date.now() - lastActivity() : Infinity;
      if (sinceActivity < idleMs) {
        timerMs = idleMs - sinceActivity; // real activity recently — re-arm for the remainder
        continue;
      }
      onTimeout();
      return;
    }
    if (raced === '__stop__') return;
    pendingNext = undefined;
    timerMs = idleMs;
    const r = raced as IteratorResult<T>;
    if (r.done) return;
    yield r.value;
  }
}

/** ⏹ 优雅中断的兜底窗口：turn/interrupt 发出后等不到事件流自然收尾（codex 旧版
 * 的「stream just hangs」行为 / 进程挂死）就强制结束本地循环、走杀进程恢复锤。
 * 0.139 实测收尾紧跟 interrupt 应答（同 tick 的 turn/completed），5s 是纯保险。 */
export const INTERRUPT_DRAIN_TIMEOUT_MS = 5_000;

/**
 * ⏹ 终止的优雅中断控制器（QW-15）。codex 0.139+ 在 turn/interrupt 后以
 * turn/completed(status:"interrupted") 干净收尾（08b-interrupt-probe 真机实测；
 * event-map 本就把 turn/completed 映射为 done）——所以 interrupt 先发 abort、让
 * 消费循环等事件流**自然结束**，线程与进程留用（同进程同 thread 可继续复用，
 * 下一条消息免 resume 冷启）。两条强停路径（`forced()` 为 true，调用方按旧样
 * 杀进程回收）：① turnId 还没到手（极早期点击，没法定向 interrupt）→ 立即强停；
 * ② abort 发出后 `timeoutMs` 内流没收尾（codex 版本旧 / 挂死）→ 超时强停。
 * `dispose()` 在循环结束后撤掉兜底定时器。幂等：重复点击只 abort 一次。
 */
export function createGracefulInterrupt(opts: {
  /** current turn id（turn_started 事件消费后才有） */
  turnId: () => string | undefined;
  /** send turn/interrupt to the backend（fire-and-forget，错误调用方自吞） */
  abort: (turnId: string) => void;
  /** end the local consume loop NOW（接 withIdleTimeout stop 信号的 resolve） */
  forceStop: () => void;
  /** 兜底窗口，默认 {@link INTERRUPT_DRAIN_TIMEOUT_MS} */
  timeoutMs?: number;
}): {
  /** ⏹ 入口（接 ActiveState.interrupt） */
  interrupt: () => void;
  /** ⏹ 被点过 */
  interrupted: () => boolean;
  /** 走了强停（杀进程恢复锤）而非自然收尾 —— killed 判定的输入 */
  forced: () => boolean;
  /** 事件流收尾后清掉兜底定时器（无论哪条路径结束都要调） */
  dispose: () => void;
} {
  let interrupted = false;
  let forced = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    interrupt: (): void => {
      if (interrupted) return;
      interrupted = true;
      const tid = opts.turnId();
      if (!tid) {
        forced = true;
        opts.forceStop();
        return;
      }
      opts.abort(tid);
      timer = setTimeout(() => {
        forced = true;
        opts.forceStop();
      }, opts.timeoutMs ?? INTERRUPT_DRAIN_TIMEOUT_MS);
    },
    interrupted: (): boolean => interrupted,
    forced: (): boolean => forced,
    dispose: (): void => {
      if (timer) clearTimeout(timer);
    },
  };
}

/** A queued slot request from {@link Semaphore.enqueue} (M-3 排队可见可取消). */
export interface QueuedAcquire {
  /** Resolves with the release fn once a slot is granted — or `null` if the
   * waiter was cancelled while still queued. */
  acquired: Promise<(() => void) | null>;
  /** 1-based position in the wait queue; 0 once granted (or cancelled). */
  position(): number;
  /** Remove the waiter before its slot is granted (排队取消). True if removed
   * (`acquired` resolves `null`, the reservation is gone); false if the slot
   * was already granted / already cancelled — the caller then owns a normal
   * release and must route the cancel to the running turn instead. */
  cancel(): boolean;
}

type Waiter = { grant: () => void; onAdvance?: (pos: number) => void };

/** Minimal FIFO semaphore for the global concurrent-run cap. */
export class Semaphore {
  private active = 0;
  private waiters: Waiter[] = [];
  constructor(private readonly max: number) {}

  /** True if acquire() would grant a slot without queueing. */
  hasFree(): boolean {
    return this.active < this.max;
  }

  async acquire(): Promise<() => void> {
    // acquire() exposes no cancel handle, so `acquired` always grants.
    return (await this.enqueue().acquired) as () => void;
  }

  /**
   * Acquire with queue visibility + cancellation: when the pool is full the
   * returned handle exposes the waiter's live 1-based queue position
   * (`onAdvance` fires on every change) and `cancel()` to leave the queue —
   * the entry ahead-of/behind semantics stay strictly FIFO.
   */
  enqueue(onAdvance?: (pos: number) => void): QueuedAcquire {
    let settle!: (r: (() => void) | null) => void;
    const acquired = new Promise<(() => void) | null>((res) => {
      settle = res;
    });
    let settled = false; // granted or cancelled — guards double-settling
    const grant = (): void => {
      settled = true;
      this.active++;
      let released = false;
      settle(() => {
        if (released) return;
        released = true;
        this.active--;
        const next = this.waiters.shift();
        if (next) {
          next.grant();
          this.notifyAdvance();
        }
      });
    };
    const entry: Waiter = { grant, onAdvance };
    if (this.active < this.max) grant();
    else this.waiters.push(entry);
    return {
      acquired,
      position: (): number => {
        const i = this.waiters.indexOf(entry);
        return i >= 0 ? i + 1 : 0;
      },
      cancel: (): boolean => {
        if (settled) return false;
        const i = this.waiters.indexOf(entry);
        if (i < 0) return false;
        this.waiters.splice(i, 1);
        settled = true;
        settle(null);
        this.notifyAdvance(i);
        return true;
      },
    };
  }

  /** Tell every waiter at/after `fromIndex` its new 1-based position. */
  private notifyAdvance(fromIndex = 0): void {
    for (let i = fromIndex; i < this.waiters.length; i++) this.waiters[i]?.onAdvance?.(i + 1);
  }
}
