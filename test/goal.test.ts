import { describe, expect, it } from 'vitest';
import { parseGoalTrigger } from '../src/bot/handle-message';
import { buildGoalDoneCard } from '../src/card/goal-card';
import { isGoalSuccess, isGoalTerminal } from '../src/agent/types';

/** Collect every `content` string anywhere in a card object (titles, md, notes). */
function texts(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, acc));
  else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (typeof o.content === 'string') acc.push(o.content);
    for (const k of Object.keys(o)) texts(o[k], acc);
  }
  return acc;
}

describe('parseGoalTrigger', () => {
  it('extracts the objective with /goal at the start', () => {
    expect(parseGoalTrigger('/goal 把 services/ 迁到 v2')).toBe('把 services/ 迁到 v2');
  });

  it('extracts the objective with /goal at the end or middle (anywhere)', () => {
    expect(parseGoalTrigger('把 services/ 迁到 v2 /goal')).toBe('把 services/ 迁到 v2');
    expect(parseGoalTrigger('先看代码 /goal 然后迁移')).toBe('先看代码 然后迁移');
  });

  it('is case-insensitive', () => {
    expect(parseGoalTrigger('/GOAL ship it')).toBe('ship it');
  });

  it('does NOT trigger on /goal inside a path or URL (not whitespace-bounded)', () => {
    expect(parseGoalTrigger('看看 src/goal/x.ts')).toBeNull();
    expect(parseGoalTrigger('cmd/goal/main.go')).toBeNull();
    expect(parseGoalTrigger('https://example.com/goal')).toBeNull();
    expect(parseGoalTrigger('/goalkeeper 训练')).toBeNull();
  });

  it('returns null for a bare /goal with no objective, or a non-goal message', () => {
    expect(parseGoalTrigger('/goal')).toBeNull();
    expect(parseGoalTrigger('   /goal   ')).toBeNull();
    expect(parseGoalTrigger('普通消息，没有触发词')).toBeNull();
  });
});

describe('isGoalTerminal / isGoalSuccess', () => {
  it('treats the 6 runtime statuses correctly (defensive, open-string)', () => {
    expect(isGoalTerminal('active')).toBe(false);
    expect(isGoalTerminal('paused')).toBe(false);
    expect(isGoalTerminal('complete')).toBe(true);
    expect(isGoalTerminal('budgetLimited')).toBe(true);
    expect(isGoalTerminal('usageLimited')).toBe(true); // not in the vendored enum
    expect(isGoalTerminal('blocked')).toBe(true); // not in the vendored enum
    expect(isGoalSuccess('complete')).toBe(true);
    expect(isGoalSuccess('usageLimited')).toBe(false);
  });
});

describe('buildGoalDoneCard', () => {
  it('renders a green completion card with formatted tokens + duration', () => {
    const card = buildGoalDoneCard({
      objective: '把 services/ 迁到 v2',
      status: 'complete',
      tokensUsed: 290497,
      timeUsedSeconds: 461,
    }) as { header: { template: string; title: { content: string } } };
    expect(card.header.template).toBe('green');
    expect(card.header.title.content).toContain('目标已完成');
    const all = texts(card).join('\n');
    expect(all).toContain('把 services/ 迁到 v2');
    expect(all).toContain('290,497 tokens');
    expect(all).toContain('约 7 分 41 秒');
  });

  it('renders an orange abort card with a reason for an abnormal status', () => {
    const card = buildGoalDoneCard({
      objective: 'do the thing',
      status: 'usageLimited',
      tokensUsed: 1000,
      timeUsedSeconds: 45,
    }) as { header: { template: string; title: { content: string } } };
    expect(card.header.template).toBe('orange');
    expect(card.header.title.content).toContain('目标已中止');
    const all = texts(card).join('\n');
    expect(all).toContain('账号用量额度用尽');
    expect(all).toContain('约 45 秒'); // sub-minute duration format
  });

  it('prefers a fatal error message over the status reason', () => {
    const card = buildGoalDoneCard({
      objective: 'x',
      status: 'error',
      tokensUsed: 0,
      timeUsedSeconds: 0,
      errorMessage: 'boom',
    });
    expect(texts(card).join('\n')).toContain('boom');
  });

  it('formats durations across minute/hour boundaries', () => {
    const dur = (s: number): string =>
      texts(buildGoalDoneCard({ objective: 'x', status: 'complete', tokensUsed: 0, timeUsedSeconds: s }))
        .find((t) => t.includes('耗时')) ?? '';
    expect(dur(120)).toContain('约 2 分');
    expect(dur(3661)).toContain('约 1 时 1 分');
  });
});
