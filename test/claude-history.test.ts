import { describe, expect, it } from 'vitest';
import type { SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { foldSessionMessages, mapSessionSummary } from '../src/agent/claude-agent/history';

/**
 * 锁定 /resume 历史卡的纯映射：listSessions → ThreadSummary、getSessionMessages →
 * turns。形状由 spike9 实证（user/assistant 的 message.content[] 块）。
 */
const sess = (o: Partial<SDKSessionInfo>): SDKSessionInfo =>
  ({ sessionId: 'x', summary: '', lastModified: 0, ...o }) as SDKSessionInfo;
const um = (content: unknown): SessionMessage => ({ type: 'user', uuid: 'u', session_id: 's', parent_tool_use_id: null, message: { role: 'user', content } });
const am = (content: unknown): SessionMessage => ({ type: 'assistant', uuid: 'a', session_id: 's', parent_tool_use_id: null, message: { role: 'assistant', content } });

describe('mapSessionSummary', () => {
  it('epoch ms → unix 秒；customTitle 优先于 summary/firstPrompt', () => {
    const r = mapSessionSummary(sess({ sessionId: 's1', summary: '摘要', firstPrompt: '第一句', customTitle: '我的标题', createdAt: 2_000_000, lastModified: 5_000_000 }));
    expect(r).toEqual({ sessionId: 's1', preview: '我的标题', createdAt: 2000, updatedAt: 5000, name: '我的标题' });
  });
  it('无 customTitle → 用 summary；无 summary → firstPrompt；createdAt 缺省回退 lastModified', () => {
    expect(mapSessionSummary(sess({ summary: 'S', lastModified: 9000 }))).toMatchObject({ preview: 'S', createdAt: 9, updatedAt: 9, name: undefined });
    expect(mapSessionSummary(sess({ summary: '', firstPrompt: 'FP', lastModified: 1000 })).preview).toBe('FP');
  });
});

describe('foldSessionMessages', () => {
  it('user(文本)→assistant(文本+思考) 折成一个 turn', () => {
    const h = foldSessionMessages([
      um([{ type: 'text', text: '你好' }]),
      am([{ type: 'thinking', thinking: '想一下' }, { type: 'text', text: '你也好' }]),
    ], 10);
    expect(h.totalTurns).toBe(1);
    expect(h.turns[0]).toMatchObject({ userText: '你好', assistantText: '你也好', reasoning: '想一下', tools: [] });
  });

  it('工具：assistant tool_use + 随后 user tool_result 关联到同一工具（输出/失败回填）', () => {
    const h = foldSessionMessages([
      um([{ type: 'text', text: '跑个命令' }]),
      am([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }]),
      um([{ type: 'tool_result', tool_use_id: 'tu1', content: '文件列表', is_error: false }]),
      am([{ type: 'text', text: '完成' }]),
    ], 10);
    expect(h.totalTurns).toBe(1);
    expect(h.turns[0]!.tools).toEqual([{ title: 'ls', output: '文件列表' }]);
    expect(h.turns[0]!.assistantText).toBe('完成');
  });

  it('多轮：每个含文本的 user 开新 turn；保留最后 maxTurns 个', () => {
    const msgs: SessionMessage[] = [];
    for (let i = 1; i <= 5; i++) { msgs.push(um([{ type: 'text', text: `问题${i}` }]), am([{ type: 'text', text: `答${i}` }])); }
    const h = foldSessionMessages(msgs, 2);
    expect(h.totalTurns).toBe(5);
    expect(h.turns).toHaveLength(2); // 只留最后 2
    expect(h.turns[0]!.userText).toBe('问题4');
    expect(h.turns[1]!.userText).toBe('问题5');
  });

  it('跳过环境样板 user 文本（不算一个 turn）', () => {
    const h = foldSessionMessages([
      um([{ type: 'text', text: '<environment_context>cwd=...</environment_context>' }]),
      um([{ type: 'text', text: '真问题' }]),
      am([{ type: 'text', text: '真答案' }]),
    ], 10);
    expect(h.totalTurns).toBe(1);
    expect(h.turns[0]!.userText).toBe('真问题');
  });

  it('content 为字符串（非数组）也能处理', () => {
    const h = foldSessionMessages([um('纯文本问题'), am('纯文本答案')], 10);
    expect(h.turns[0]).toMatchObject({ userText: '纯文本问题', assistantText: '纯文本答案' });
  });
});
