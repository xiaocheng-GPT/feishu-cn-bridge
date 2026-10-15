import { log } from '../../core/logger';
import type {
  AgentEvent,
  AgentInput,
  AgentRun,
  AgentThread,
  CompactResult,
} from '../types';
import type { AcpClient, AcpSessionUpdateNotification } from './acp-client';
import { mapSessionUpdate } from './event-map';

/** 每个 runStreamed 分配一个本地 turn id（合成 turn_started 用）。 */
let turnSeq = 0;

/**
 * DshThread —— 一个 dsh ACP 会话的对话线程。
 *
 * ACP 协议没有 turn 概念：一串 session/update 通知 + 一个 settle 的
 * session/prompt 请求即一轮。而 orchestrator（handle-message）依赖
 * `turn_started` 触发标题生成与卡片初始化，`done` 结束 turn——所以
 * runStreamed 自行装配这两个事件。
 *
 * 时序（探针验证）：dsh 保证 session/prompt 的 resolve 发生在该轮所有
 * session/update 通知**之后**，因此「等 prompt settle ⇒ 本轮事件消费完毕」。
 */
export class DshThread implements AgentThread {
  constructor(
    private readonly client: AcpClient,
    readonly sessionId: string,
    private model: string | undefined,
  ) {}

  runStreamed(input: AgentInput, turn?: { model?: string }): AgentRun {
    const self = this;
    if (turn?.model) this.model = turn.model;
    const turnId = `dsh-${++turnSeq}`;
    let activeTurnId: string | undefined;
    // Liveness 时钟：每个原始通知都刷新（即使映射被丢弃），供 idle watchdog 用。
    let lastActivityAt = Date.now();

    // 立即发出 session/prompt（不是惰性在首个 next() 时发）——模型推理并行于
    // 调用方的卡片初始化。通知在 client 内部队列缓冲，不会丢。
    const started = this.client
      .request<unknown>('session/prompt', {
        sessionId: self.sessionId,
        prompt: [{ type: 'text', text: input.text ?? '' }],
      })
      .then(
        () => ({ ok: true as const, error: undefined as undefined }),
        (err: unknown) => ({
          ok: false as const,
          error: err instanceof Error ? err : new Error(String(err)),
        }),
      );
    // settled 一旦 resolve，说明本轮事件已全部送达（dsh 的 resolve 在最后一条
    // update 之后）——它的职责就是当「回合结束」信号，成败由 started 再取。
    const settled: Promise<'started'> = started.then(() => 'started', () => 'started');

    async function* gen(): AsyncGenerator<AgentEvent> {
      try {
        yield { type: 'turn_started', turnId };
        activeTurnId = turnId;
        const iterator = self.client.stream()[Symbol.asyncIterator]();
        try {
          while (true) {
            const step = await Promise.race([settled, iterator.next()]);
            if (step === 'started') break; // prompt 已 settle ⇒ 本轮消费完毕
            if (step.done) break; // 子进程退出/连接关闭
            const n = step.value as AcpSessionUpdateNotification;
            lastActivityAt = Date.now();
            if (n.sessionId !== self.sessionId) continue; // 其它会话的通知（不应出现）
            const ev = mapSessionUpdate(n.update);
            if (ev) yield ev;
          }
        } finally {
          // 清掉 race 输掉的悬空读，避免污染下一轮的 stream。
          await iterator.return?.();
        }
        const outcome = await started;
        activeTurnId = undefined;
        if (outcome.ok) {
          yield { type: 'done', turnId };
        } else {
          log.fail('agent', outcome.error, { phase: 'session/prompt' });
          yield { type: 'error', message: outcome.error.message, willRetry: false };
        }
      } finally {
        activeTurnId = undefined;
      }
    }
    return {
      events: gen(),
      turnId: () => activeTurnId,
      lastActivity: () => lastActivityAt,
    };
  }

  // ── 能力位 goal/steer/compact 均为 false —— 接口要求方法存在，调用即抛错 ──
  // （types.ts：flag 为 false 的后端 MUST 让对应方法抛清晰错误，绝不静默。）

  runGoal(_objective: string): AgentRun {
    throw new Error('dsh ACP 后端不支持自治目标（/goal）');
  }

  async clearGoal(): Promise<void> {
    throw new Error('dsh ACP 后端不支持自治目标（/goal）');
  }

  async steer(): Promise<void> {
    throw new Error('dsh ACP 后端不支持中途引导（/steer）');
  }

  async compact(): Promise<CompactResult> {
    throw new Error('dsh ACP 后端不支持手动压缩（/compact）');
  }

  /** 中断 in-flight turn：ACP 的 session/cancel 是通知（服务端主动取消继续生成）。 */
  async abort(_turnId: string): Promise<void> {
    this.client.notify('session/cancel', { sessionId: this.sessionId });
  }

  isAlive(): boolean {
    return !this.client.exited;
  }

  async close(): Promise<void> {
    // 会话落盘（session/close 让 dsh 持久化当前会话，供日后 resume）再杀进程。
    await this.client.request('session/close', { sessionId: this.sessionId }).catch((err: unknown) => {
      log.fail('agent', err, { phase: 'session/close' });
    });
    await this.client.close();
  }
}