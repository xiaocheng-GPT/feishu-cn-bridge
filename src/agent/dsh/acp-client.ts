import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { UnsentRequestError } from '../types';
import { log } from '../../core/logger';
import { killProcessGroup, mergeProcessEnv, spawnProcess } from '../../platform/spawn';

/** ACP 协议版本（@agentclientprotocol/sdk PROTOCOL_VERSION）。 */
export const ACP_PROTOCOL_VERSION = 1;

/** ACP 文本内容块（prompt 输入用）。 */
export interface AcpTextBlock {
  type: 'text';
  text: string;
}

/** session/update 里 content 字段的形状（分块增量可能是空 text）。 */
export interface AcpContentBlock {
  type: string;
  text?: string;
  [k: string]: unknown;
}

/**
 * ACP `session/update` 通知（判别字段 sessionUpdate）。只声明本后端映射所需
 * 字段，其余（image/audio/…）形状不符时各 case 自行防御。
 * 注意：不要加「sessionUpdate: string」的宽泛兜底分支——它会破坏 TS 对判别
 * 联合的窄化（string 兼容所有字面量），导致字段全变 unknown。未知更新由
 * mapSessionUpdate 的 default 分支静默丢弃。
 */
export type AcpSessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; messageId: string; content?: AcpContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; messageId: string; content?: AcpContentBlock }
  | {
      sessionUpdate: 'tool_call';
      toolCallId: string;
      title: string;
      kind?: string;
      status: string;
    }
  | {
      sessionUpdate: 'tool_call_update';
      toolCallId: string;
      title?: string;
      status: string;
      content?: unknown;
    }
  | { sessionUpdate: 'usage_update'; used: number; size?: number }
  | { sessionUpdate: 'config_option_update'; configOptionId: string; value?: unknown };

export interface AcpSessionUpdateNotification {
  sessionId: string;
  update: AcpSessionUpdate;
}

/**
 * session/new|resume 返回的 configOptions 条目（select 型，目前 model 与
 * reasoning_effort）。模型下拉是「分组 → 扁平选项」两级结构（dsh-acp 实现）。
 */
export interface AcpConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  /** 当前选中值（config 写入时用选项.value）。 */
  currentValue?: string;
  options?: {
    name?: string;
    options?: { value?: string; name?: string; description?: string }[];
  }[];
}

export interface AcpClientOptions {
  /** dsh 入口（resolveDshBinary 的产物）。 */
  bin: string;
  /** true ⇒ spawn `node <bin> --profile <profile>`。 */
  isNodeScript?: boolean;
  /** dsh ACP profile 名，默认 'acp'。 */
  profile?: string;
  cwd: string;
  clientName?: string;
}

/** 简单异步队列（同 codex-appserver/app-server-client 的内部实现）。 */
class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((v: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined as never, done: true });
  }

  clear(): void {
    this.items.length = 0;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    let ended = false;
    const owned = new Set<(v: IteratorResult<T>) => void>();
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => {
        if (ended) return Promise.resolve({ value: undefined as never, done: true });
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve) => {
          const waiter = (v: IteratorResult<T>) => {
            owned.delete(waiter);
            resolve(v);
          };
          owned.add(waiter);
          this.waiters.push(waiter);
        });
      },
      return: async () => {
        ended = true;
        for (const waiter of owned) {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          waiter({ value: undefined as never, done: true });
        }
        return { value: undefined as never, done: true };
      },
    };
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/**
 * 一个 `dsh --profile acp` 子进程，speaking ACP（JSON-RPC 2.0 over ndjson）。
 * 同 AppServerClient 的会话模型：one client = one DshThread（dsh ACP 的会话
 * 是服务端 session 状态，子进程本身在 close 时才退出）。
 */
export class AcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly notifications = new AsyncQueue<AcpSessionUpdateNotification>();
  private closed = false;
  private hasExited = false;

  constructor(private readonly opts: AcpClientOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** true once the child process has exited / been closed —— 线程不可复用。 */
  get exited(): boolean {
    return this.hasExited || this.closed;
  }

  /** spawn + initialize 握手。失败抛错。 */
  async connect(): Promise<void> {
    const profile = this.opts.profile ?? 'acp';
    const command = this.opts.isNodeScript ? 'node' : this.opts.bin;
    const args = this.opts.isNodeScript
      ? [this.opts.bin, '--profile', profile]
      : ['--profile', profile];
    const child = spawnProcess(command, args, {
      cwd: this.opts.cwd,
      env: mergeProcessEnv(process.env, { FEISHU_CN_BRIDGE: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    log.info('agent', 'dsh spawn', { pid: child.pid ?? null, cwd: this.opts.cwd, profile });

    child.stdout.on('data', (d: Buffer) => this.onStdout(d));
    child.stderr.on('data', (d: Buffer) => {
      const line = d.toString('utf8').trim();
      if (line) log.warn('agent', 'dsh stderr', { line: line.slice(0, 200) });
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'dsh exit', { pid: child.pid ?? null, code, signal });
      this.hasExited = true;
      this.closed = true;
      this.failAllPending(new Error(`dsh exited (code=${code} signal=${signal})`));
      this.notifications.close();
    });
    child.on('error', (err) => this.failAllPending(err));
    child.stdin.on('error', (err) => {
      this.failAllPending(err);
      this.notifications.close();
      void this.close();
    });

    await this.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: { name: this.opts.clientName ?? 'feishu-CN-bridge', version: '0.0.1' },
      clientCapabilities: {},
    });
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed || !this.child) {
      return Promise.reject(new UnsentRequestError('dsh acp client closed'));
    }
    const id = ++this.nextId;
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`RPC ${method} response timed out; delivery unknown`));
            }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child!.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed || !this.child) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} })}\n`);
  }

  /** async-iterate `session/update` 通知（进程退出时关闭）。 */
  stream(): AsyncIterable<AcpSessionUpdateNotification> {
    return this.notifications;
  }

  /** 清掉积压未消费的通知（预热复用场景防护，dsh 暂不用但保持对称）。 */
  clearNotifications(): void {
    this.notifications.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await killProcessGroup(child.pid, () => child.exitCode !== null);
  }

  private onStdout(d: Buffer): void {
    this.buf += d.toString('utf8');
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      log.warn('agent', 'dsh nonjson', { line: line.slice(0, 120) });
      return;
    }

    // 对我们请求的应答
    if (
      typeof msg.id === 'number' &&
      (('result' in msg) || ('error' in msg)) &&
      !('method' in msg)
    ) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if ('error' in msg && msg.error) {
        const e = msg.error as { message?: string };
        p.reject(new Error(e.message ?? 'JSON-RPC error'));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // 服务端发起的请求（如 session/request_permission）——回 method-not-found
    // 防阻塞（协议要求收到后要么答要么拒；当前后端无审批流，直接拒）。
    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      this.child?.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not handled' } })}\n`,
      );
      return;
    }

    // 通知：只收 session/update（其余忽略）
    if (typeof msg.method === 'string' && msg.method === 'session/update') {
      this.notifications.push(msg.params as AcpSessionUpdateNotification);
    }
  }

  private failAllPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}