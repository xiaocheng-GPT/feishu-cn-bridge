import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createTurnMapper } from '../src/agent/claude-agent/event-map';
import type { AgentEvent } from '../src/agent/types';

/**
 * 锁定 SDKMessage → AgentEvent 映射（纯函数无网络）。喂合成消息流，断言事件序列
 * 与 itemId 关联。真实消息形状由 spike1/2 实证（见 event-map.ts 顶注）。
 */
const m = (o: unknown): SDKMessage => o as SDKMessage;
const sysInit = (sid: string, model?: string) => m({ type: 'system', subtype: 'init', session_id: sid, model });
const blockStart = (index: number, type: string) => m({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type } } });
const delta = (index: number, d: Record<string, unknown>) => m({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: d } });
const blockStop = (index: number) => m({ type: 'stream_event', event: { type: 'content_block_stop', index } });
const assistantTool = (id: string, name: string, input: unknown) => m({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const userToolResult = (toolId: string, content: unknown, isErr = false) => m({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content, is_error: isErr }] } });

function mapAll(mapper: { map(msg: SDKMessage): AgentEvent[] }, msgs: SDKMessage[]): AgentEvent[] {
  return msgs.flatMap((x) => mapper.map(x));
}

describe('createTurnMapper —— SDKMessage → AgentEvent', () => {
  it('system/init → system 事件，且只发一次', () => {
    const mp = createTurnMapper();
    expect(mp.map(sysInit('sess-1'))).toEqual([{ type: 'system', threadId: 'sess-1' }]);
    expect(mp.map(sysInit('sess-1'))).toEqual([]); // 第二次 init 抑制
  });

  it('system/compact_boundary（自动压缩）→ context_compacted 通知', () => {
    const evs = createTurnMapper().map(m({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 9000 } }));
    expect(evs).toEqual([{ type: 'context_compacted' }]);
  });

  it('文本块：delta 累积 + stop 收尾，itemId 在 delta 与 text 间一致', () => {
    const mp = createTurnMapper();
    const evs = mapAll(mp, [
      blockStart(0, 'text'),
      delta(0, { type: 'text_delta', text: '你好' }),
      delta(0, { type: 'text_delta', text: '，世界' }),
      blockStop(0),
    ]);
    expect(evs).toEqual([
      { type: 'text_delta', itemId: 'b1', delta: '你好' },
      { type: 'text_delta', itemId: 'b1', delta: '，世界' },
      { type: 'text', itemId: 'b1', text: '你好，世界' },
    ]);
    // delta 与最终 text 同 itemId（run-state 据此替换而非重复）—— 上面 toEqual 已锁定，
    // 这里显式再断一次关联关系。
    const deltaEv = evs.find((e) => e.type === 'text_delta');
    const textEv = evs.find((e) => e.type === 'text');
    expect(deltaEv && textEv && 'itemId' in deltaEv && 'itemId' in textEv && deltaEv.itemId === textEv.itemId).toBe(true);
  });

  it('思考块：thinking_delta 累积 + thinking 收尾', () => {
    const mp = createTurnMapper();
    const evs = mapAll(mp, [
      blockStart(0, 'thinking'),
      delta(0, { type: 'thinking_delta', thinking: '让我想想' }),
      blockStop(0),
    ]);
    expect(evs).toEqual([
      { type: 'thinking_delta', itemId: 'b1', delta: '让我想想' },
      { type: 'thinking', itemId: 'b1', text: '让我想想' },
    ]);
  });

  it('工具：assistant tool_use → tool_use（itemId=工具id，Bash 标题=命令，kind=command）', () => {
    const mp = createTurnMapper();
    const evs = mp.map(assistantTool('tu_1', 'Bash', { command: 'ls -la', description: '列目录' }));
    expect(evs).toEqual([{ type: 'tool_use', itemId: 'tu_1', title: 'ls -la', detail: '列目录', kind: 'command' }]);
  });

  it('工具结果：user tool_result → tool_result（成功 exitCode=0，失败=1）', () => {
    const ok = createTurnMapper().map(userToolResult('tu_1', '输出内容', false));
    expect(ok).toEqual([{ type: 'tool_result', itemId: 'tu_1', output: '输出内容', exitCode: 0 }]);
    const bad = createTurnMapper().map(userToolResult('tu_2', '炸了', true));
    expect(bad).toEqual([{ type: 'tool_result', itemId: 'tu_2', output: '炸了', exitCode: 1 }]);
  });

  it('tool_result.content 为数组（{type:text}）也能拍平', () => {
    const evs = createTurnMapper().map(userToolResult('tu_1', [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]));
    expect(evs).toEqual([{ type: 'tool_result', itemId: 'tu_1', output: 'AB', exitCode: 0 }]);
  });

  it('result(success) → usage + 回退 context_usage（窗口取自 init 的 model，非 result.model）', () => {
    const mp = createTurnMapper();
    mp.map(sysInit('s', 'claude-opus-4-8[1m]')); // init 提供 model → 1M 窗口
    const evs = mp.map(
      m({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } }),
    );
    expect(evs).toContainEqual({ type: 'usage', inputTokens: 10, outputTokens: 5 });
    // used = 10+3+2 = 15；窗口来自 init model（[1m] → 1,000,000），不再是 result.model（缺失）
    expect(evs).toContainEqual({ type: 'context_usage', usedTokens: 15, contextWindow: 1_000_000 });
    expect(evs.some((e) => e.type === 'done')).toBe(false);
  });

  it('无 init model 时回退窗口为 null（而非崩溃）——thread 会用 getContextUsage 覆盖', () => {
    const evs = createTurnMapper().map(
      m({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 0 } }),
    );
    expect(evs).toContainEqual({ type: 'context_usage', usedTokens: 10, contextWindow: null });
  });

  it('多块顺序：思考→文本→工具，itemId 各自独立递增', () => {
    const mp = createTurnMapper();
    const evs = mapAll(mp, [
      blockStart(0, 'thinking'), delta(0, { type: 'thinking_delta', thinking: 'T' }), blockStop(0),
      blockStart(1, 'text'), delta(1, { type: 'text_delta', text: 'A' }), blockStop(1),
      assistantTool('tu_x', 'Read', { file_path: '/Users/x/proj/a.ts' }),
    ]);
    const ids = evs.filter((e) => 'itemId' in e).map((e) => (e as { itemId: string }).itemId);
    expect(new Set(ids).size).toBeGreaterThanOrEqual(3); // b1(思考) / b2(文本) / tu_x(工具) 互不相同
  });
});
