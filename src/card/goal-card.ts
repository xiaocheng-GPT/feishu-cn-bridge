import { card, hr, md, note, type CardObject } from './cards';
import { isGoalSuccess } from '../agent/types';

/**
 * The terminal card posted AFTER a goal run finishes — separate from the
 * streaming run cards, it summarizes the whole goal (objective + run metadata).
 * Success → green "目标已完成"; any abnormal stop (budget/usage limit, blocked,
 * fatal error, or the bridge's wall-clock cap) → orange "目标已中止" with a reason.
 */
export interface GoalDoneCardData {
  objective: string;
  /** goal status, or 'timeout' (bridge cap) / 'error' (fatal) sentinels */
  status: string;
  tokensUsed: number;
  timeUsedSeconds: number;
  /** fatal error message, when the run died on an error rather than a status */
  errorMessage?: string;
}

function fmtTokens(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString('en-US');
}

/** "约 7 分 41 秒" / "约 45 秒" / "约 2 时 3 分" — matches the agreed format. */
function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `约 ${s} 秒`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `约 ${m} 分 ${rem} 秒` : `约 ${m} 分`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `约 ${h} 时 ${mm} 分` : `约 ${h} 时`;
}

const ABNORMAL_REASON: Record<string, string> = {
  budgetLimited: 'Token 预算用尽',
  usageLimited: '账号用量额度用尽',
  blocked: '被阻塞，需人工介入',
  paused: '已暂停',
  timeout: '运行超过时长上限被中止',
  error: '运行出错',
};

export function buildGoalDoneCard(d: GoalDoneCardData): CardObject {
  const ok = isGoalSuccess(d.status);
  const elements = [
    md(d.objective.trim() || '（无目标描述）'),
    hr(),
    note(`用量　${fmtTokens(d.tokensUsed)} tokens`),
    note(`耗时　${fmtDuration(d.timeUsedSeconds)}`),
  ];
  if (!ok) {
    const reason = d.errorMessage?.trim() || ABNORMAL_REASON[d.status] || `状态：${d.status}`;
    elements.push(note(`原因　${reason}`));
  }
  return card(elements, {
    header: ok
      ? { title: '🎯 目标已完成', template: 'green' }
      : { title: '🎯 目标已中止', template: 'orange' },
    summary: ok ? '目标已完成' : '目标已中止',
  });
}
