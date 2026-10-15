import type { AgentEvent } from '../types';
import type { AcpSessionUpdate } from './acp-client';

/**
 * ACP `session/update` → 归一化 AgentEvent 映射。
 * 映射规则（依据 dsh-acp 0.1.5-rc.1 服务端实现 + 本机探针验证）：
 *   agent_thought_chunk → thinking_delta（reasoning 增量）
 *   agent_message_chunk → text_delta（正文增量）
 *   tool_call            → tool_use（itemId=toolCallId）
 *   tool_call_update     → tool_result（completed 无 exitCode；failed → 1）
 *   usage_update         → context_usage（used/size）
 * 协议无 turn 概念：turn_started / done 由 AcpThread 装配，不在此映射。
 */
export function mapSessionUpdate(update: AcpSessionUpdate): AgentEvent | null {
  switch (update.sessionUpdate) {
    case 'agent_thought_chunk': {
      const delta = blockText(update.content);
      return delta ? { type: 'thinking_delta', itemId: update.messageId, delta } : null;
    }
    case 'agent_message_chunk': {
      const delta = blockText(update.content);
      return delta ? { type: 'text_delta', itemId: update.messageId, delta } : null;
    }
    case 'tool_call':
      return {
        type: 'tool_use',
        itemId: update.toolCallId,
        title: update.title || '工具调用',
        // dsh 的 title 是工具名/Bash 命令——卡片按 tool 渲染最稳妥
        kind: 'tool',
      };
    case 'tool_call_update':
      return {
        type: 'tool_result',
        itemId: update.toolCallId,
        output: extractToolOutput(update.content),
        exitCode: update.status === 'failed' ? 1 : undefined,
      };
    case 'usage_update':
      return {
        type: 'context_usage',
        usedTokens: update.used,
        contextWindow: update.size ?? null,
      };
    default:
      // config_option_update / 未知更新 —— 不 surface
      return null;
  }
}

/** content 块取 text（text 块可能是空/缺省）。 */
function blockText(content?: { type?: string; text?: string }): string {
  if (content?.type !== 'text') return '';
  return content.text ?? '';
}

/**
 * tool_call_update 的 content 形状（dsh-acp 实现）：
 *   content: [{ type:'content', content:{ type:'text', text } }, …]
 * 兼容 [{ type:'text', text }] 的直通形态，拼成单字符串。
 */
function extractToolOutput(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parts: string[] = [];
  for (const block of raw) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; content?: unknown; text?: string };
    if (b.type === 'content') {
      const inner = b.content as { type?: string; text?: string } | undefined;
      if (typeof inner?.text === 'string') parts.push(inner.text);
      continue;
    }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  const joined = parts.join('\n');
  return joined || undefined;
}