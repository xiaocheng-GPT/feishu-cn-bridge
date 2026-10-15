import { log } from '../../core/logger';
import type {
  AgentBackend,
  AgentCapabilities,
  AgentThread,
  BackendProbe,
  ModelInfo,
  PermissionMode,
  ResumeThreadOptions,
  StartThreadOptions,
  ThreadHistory,
  ThreadSummary,
} from '../types';
import { AcpClient, type AcpConfigOption } from './acp-client';
import { dshVersionAsync, resolveDshBinary, type DshBinary } from './locate';
import { DshThread } from './thread';

/**
 * DshAdapter —— DeepSeek 官方 CLI（dsh，`--profile acp`）作为 Agent 后端。
 * ACP 是纯消息通道：Agent 在本机跑，飞书经本桥接器转发对话。能力面较 codex
 * 精简（无 goal/steer/compact/审批），resume 走 dsh 磁盘持久化的会话。
 */
export class DshAdapter implements AgentBackend {
  readonly id = 'dsh-acp';
  readonly displayName = 'DeepSeek (dsh)';
  readonly capabilities: AgentCapabilities = {
    goal: false,
    steer: false,
    compact: false,
    resume: true,
    approvals: false,
  };
  // dsh 没有 OS 沙箱概念，只会全权限跑本机命令——只开放 full 档，档外 fail-closed。
  readonly supportedModes: readonly PermissionMode[] = ['full'];

  private modelCache: ModelInfo[] | null = null;

  async isAvailable(): Promise<boolean> {
    return (await this.doctor()).ok;
  }

  async doctor(opts?: { force?: boolean }): Promise<BackendProbe> {
    const probe = opts?.force ? { force: true as const } : undefined;
    const bin = resolveDshBinary(probe);
    if (!bin) {
      return {
        ok: false,
        version: null,
        hint: '未找到 dsh CLI（npm i -g @deepseek-ai/dsh，或设 DSH_BIN）',
      };
    }
    const version = await dshVersionAsync(bin, probe);
    if (!version) {
      return { ok: false, version: null, location: bin.bin, hint: `dsh --version 执行失败（${bin.bin}）` };
    }
    return { ok: true, version, location: bin.bin };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelCache) return this.modelCache;
    const bin = resolveDshBinary();
    if (!bin) {
      this.modelCache = [];
      return this.modelCache;
    }
    let client: AcpClient | null = null;
    try {
      // session/new 返回 configOptions（含模型下拉），等价于「该进程可用模型」。
      // mcpServers 必填（dsh 服务端校验），空数组即无 MCP。
      client = await this.spawnProbe(bin);
      const res = await client.request<{ configOptions?: AcpConfigOption[] }>('session/new', {
        cwd: process.cwd(),
        mcpServers: [],
      });
      const models = parseModels(res.configOptions);
      this.modelCache = models.length ? models : [];
      return this.modelCache;
    } catch (err) {
      log.fail('agent', err, { phase: 'dsh listModels' });
      this.modelCache = [];
      return this.modelCache;
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  async listThreads(cwd: string, limit = 15): Promise<ThreadSummary[]> {
    const bin = resolveDshBinary();
    if (!bin) return [];
    let client: AcpClient | null = null;
    try {
      // session/list 是连接级方法，无需先建会话；返回 dsh 磁盘持久化的会话。
      client = await this.spawnProbe(bin);
      const res = await client.request<{ sessions?: { sessionId: string; cwd?: string }[] }>(
        'session/list',
        { cwd },
      );
      // dsh 不暴露时间戳/preview，用空 preview + 0 时间（resume 卡可显示但无摘要）。
      // 注意 session/list 只列「当前进程外」的持久化会话，进程退出即全部可见。
      return (res.sessions ?? []).slice(0, limit).map((s) => ({
        sessionId: s.sessionId,
        preview: '',
        createdAt: 0,
        updatedAt: 0,
      }));
    } catch (err) {
      log.fail('agent', err, { phase: 'dsh listThreads' });
      return [];
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  async readHistory(_cwd: string, _sessionId: string, _maxTurns = 10): Promise<ThreadHistory> {
    // ACP 协议无「读历史」方法（dsh 不提供 transcript 通道）——resume 卡无回顾。
    return { turns: [], totalTurns: 0 };
  }

  async startThread(opts: StartThreadOptions): Promise<AgentThread> {
    if (opts.mode && opts.mode !== 'full') {
      throw new Error('dsh 后端不支持权限档配置（仅 full）；请在项目设置中切换。');
    }
    const client = await this.spawn(opts.cwd);
    try {
      const res = await client.request<{ sessionId?: string }>('session/new', {
        cwd: opts.cwd,
        mcpServers: [],
      });
      const sessionId = res.sessionId;
      if (!sessionId) throw new Error('session/new 返回缺少 sessionId');
      await this.applyModel(client, sessionId, opts.model);
      return new DshThread(client, sessionId, opts.model);
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
  }

  async resumeThread(opts: ResumeThreadOptions): Promise<AgentThread> {
    if (opts.mode && opts.mode !== 'full') {
      throw new Error('dsh 后端不支持权限档配置（仅 full）；请在项目设置中切换。');
    }
    const client = await this.spawn(opts.cwd);
    try {
      await client.request('session/resume', {
        sessionId: opts.sessionId,
        cwd: opts.cwd,
        mcpServers: [],
      });
      await this.applyModel(client, opts.sessionId, opts.model);
      return new DshThread(client, opts.sessionId, opts.model);
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
  }

  /**
   * 用户选了模型时，经 session/set_config_option 应用到会话（best-effort，失败用默认）。
   * 注意 ACP 方法名是全小写下划线（schema.AGENT_METHODS.session_set_config_option），
   * 不是驼峰——写错服务端直接回 "Method not found"，模型选择静默失效。
   */
  private async applyModel(
    client: AcpClient,
    sessionId: string,
    model: string | undefined,
  ): Promise<void> {
    if (!model) return;
    try {
      await client.request('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: model,
      });
    } catch (err) {
      log.fail('agent', err, { phase: 'dsh set_config_option', model });
    }
  }

  /** 新会话线程专属连接。 */
  private async spawn(cwd: string): Promise<AcpClient> {
    const bin = resolveDshBinary();
    if (!bin) throw new Error('dsh CLI not found (npm i -g @deepseek-ai/dsh or set DSH_BIN)');
    const client = new AcpClient({ bin: bin.bin, isNodeScript: bin.isNodeScript, cwd });
    await client.connect();
    return client;
  }

  /** 短时探测连接（listModels/listThreads 用，用完即关）。 */
  private async spawnProbe(bin: DshBinary): Promise<AcpClient> {
    const client = new AcpClient({
      bin: bin.bin,
      isNodeScript: bin.isNodeScript,
      cwd: process.cwd(),
      clientName: 'feishu-CN-bridge-probe',
    });
    await client.connect();
    return client;
  }
}

/** ACP configOptions → ModelInfo[]。模型下拉是分组扁平结构，i18n 仅取 value/name。 */
function parseModels(configOptions: AcpConfigOption[] | undefined): ModelInfo[] {
  const modelOpt = (configOptions ?? []).find((o) => o.id === 'model');
  if (!modelOpt?.options?.length) return [];
  const current = modelOpt.currentValue;
  return modelOpt.options
    .flatMap((group) => (group.options ?? []).map((c) => ({ ...c, group: group.name })))
    .filter((c) => c.value && c.name)
    .map((c) => ({
      id: c.value as string,
      displayName: c.name as string,
      description: c.description ?? '',
      supportedEfforts: [],
      defaultEffort: 'medium' as const,
      isDefault: c.value === current,
      hidden: false,
    }));
}