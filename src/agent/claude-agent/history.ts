import type { SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HistoryTool, HistoryTurn, ThreadHistory, ThreadSummary } from '../types';
import { toolTitle } from './event-map';

/**
 * Pure mappers for the "/resume 历史会话" card, turning the Claude Agent SDK's
 * session-store reads (`listSessions` / `getSessionMessages`) into the backend's
 * normalized {@link ThreadSummary} / {@link ThreadHistory}. Kept pure (no SDK
 * calls) so they unit-test off synthetic fixtures.
 *
 * These read the SAME `~/.claude/projects/<cwd-hash>/*.jsonl` store the `claude`
 * CLI's own `claude -r` uses — so the bridge's /resume sees CLI sessions AND the
 * CLI sees bridge sessions (bidirectional, verified by spike).
 */

/** One SDKSessionInfo → a resume-picker row. ts fields are epoch ms → unix sec. */
export function mapSessionSummary(s: SDKSessionInfo): ThreadSummary {
  const preview = (s.customTitle || s.summary || s.firstPrompt || '').trim();
  return {
    sessionId: s.sessionId,
    preview,
    createdAt: msToSec(s.createdAt ?? s.lastModified),
    updatedAt: msToSec(s.lastModified),
    name: s.customTitle || undefined,
  };
}

function msToSec(ms: number | undefined): number {
  return ms && ms > 0 ? Math.floor(ms / 1000) : 0;
}

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

function blocksOf(message: unknown): Block[] {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content as Block[];
  return [];
}

/** codex 同款：跳过注入的环境样板，免得它显示成「用户消息」。 */
function isBoilerplateUserText(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('<environment_context>') ||
    t.startsWith('# AGENTS.md') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('Caveat:')
  );
}

function toolResultText(content: unknown): string | undefined {
  if (content == null) return undefined;
  if (typeof content === 'string') return content || undefined;
  if (Array.isArray(content)) {
    const text = content
      .map((b) => {
        const x = b as Block;
        return x?.type === 'text' && typeof x.text === 'string' ? x.text : '';
      })
      .join('')
      .trim();
    return text || undefined;
  }
  return undefined;
}

/**
 * Fold an ordered SessionMessage[] into renderable turns. A user message with
 * text starts a new turn; an assistant message contributes text/thinking/tool
 * calls to the current turn; a user message carrying tool_result blocks attaches
 * outputs back to the matching tool. Keeps the last `maxTurns` non-empty turns.
 */
export function foldSessionMessages(messages: SessionMessage[], maxTurns: number, cwd?: string): ThreadHistory {
  const turns: HistoryTurn[] = [];
  // index tool entries by tool_use id so a later tool_result can fill them in.
  const toolById = new Map<string, HistoryTool>();
  let cur: (HistoryTurn & { _hasContent: boolean }) | null = null;

  const flush = (): void => {
    if (cur && cur._hasContent) {
      const { _hasContent, ...turn } = cur;
      void _hasContent;
      turns.push(turn);
    }
    cur = null;
  };
  const ensure = (): HistoryTurn & { _hasContent: boolean } => {
    if (!cur) cur = { userText: '', assistantText: '', reasoning: '', tools: [], _hasContent: false };
    return cur;
  };

  for (const msg of messages) {
    const blocks = blocksOf(msg.message);
    if (msg.type === 'user') {
      const texts: string[] = [];
      let attachedResult = false;
      for (const b of blocks) {
        if (b.type === 'text' && b.text && !isBoilerplateUserText(b.text)) texts.push(b.text);
        else if (b.type === 'tool_result' && b.tool_use_id) {
          const tool = toolById.get(b.tool_use_id);
          if (tool) {
            tool.output = toolResultText(b.content);
            if (b.is_error) tool.failed = true;
            attachedResult = true;
          }
        }
      }
      const userText = texts.join('\n').trim();
      if (userText) {
        flush();
        const t = ensure();
        t.userText = userText;
        t._hasContent = true;
      } else if (attachedResult) {
        // tool_result-only message: belongs to the current turn, no new turn.
        ensure()._hasContent = true;
      }
    } else if (msg.type === 'assistant') {
      const t = ensure();
      for (const b of blocks) {
        if (b.type === 'text' && b.text) {
          t.assistantText = t.assistantText ? `${t.assistantText}\n\n${b.text}` : b.text;
          t._hasContent = true;
        } else if (b.type === 'thinking' && b.thinking) {
          t.reasoning = t.reasoning ? `${t.reasoning}\n\n${b.thinking}` : b.thinking;
          t._hasContent = true;
        } else if ((b.type === 'tool_use' || b.type === 'server_tool_use') && b.id) {
          const tool: HistoryTool = { title: toolTitle(b.name ?? '工具', b.input ?? {}, cwd) };
          t.tools.push(tool);
          toolById.set(b.id, tool);
          t._hasContent = true;
        }
      }
    }
    // system messages: ignored in the digest.
  }
  flush();

  const totalTurns = turns.length;
  const kept = totalTurns > maxTurns ? turns.slice(totalTurns - maxTurns) : turns;
  return { turns: kept, totalTurns };
}
