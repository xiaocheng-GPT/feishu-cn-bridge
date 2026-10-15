import { describe, expect, it } from 'vitest';
import type { AccountUsageBundle } from '../src/agent/types';
import {
  buildShareConfigCard,
  buildUsageCard,
  buildUsageShareCard,
  effortLabel,
  formatDurationZh,
  formatTokensZh,
  heatmapCells,
  heatmapChartEl,
  parseShareSections,
  planLabel,
  progressChartEl,
  resetLabel,
  SHARE_SECTIONS,
  windowLabel,
} from '../src/card/usage-cards';

// 固定「现在」：2026-06-07 19:00 本地时间（resetLabel 按宿主机本地时区渲染，
// 测试里 now 和 resetAt 都用本地 Date 构造，结果与运行测试的机器时区无关）。
const NOW = new Date(2026, 5, 7, 19, 0).getTime();
const at = (y: number, mo: number, d: number, h: number, mi: number): number =>
  Math.floor(new Date(y, mo - 1, d, h, mi).getTime() / 1000);

function bundle(over: Partial<AccountUsageBundle> = {}): AccountUsageBundle {
  return {
    profile: {
      displayName: 'Clay Zhang',
      lifetimeTokens: 4_271_434_092,
      peakDailyTokens: 258_804_367,
      currentStreakDays: 20,
      longestStreakDays: 31,
      longestTurnSec: 4529,
      totalThreads: 1432,
      fastModePct: 53.26,
      totalSkillsUsed: 1102,
      uniqueSkillsUsed: 95,
      mostUsedEffort: 'xhigh',
      mostUsedEffortPct: 62.37,
      topInvocations: [
        { name: 'superpowers', count: 438, kind: 'plugin' as const },
        { name: 'design-taste-frontend', count: 48, kind: 'skill' as const },
      ],
      dailyBuckets: [
        { date: '2026-03-25', tokens: 448_568 },
        { date: '2026-05-30', tokens: 12_000_000 },
        { date: '2026-06-06', tokens: 880_000 },
      ],
      statsAsOf: '2026-06-07',
    },
    usage: {
      planType: 'prolite',
      main: {
        primary: { usedPercent: 1, windowSeconds: 18000, resetAt: at(2026, 6, 8, 0, 28) },
        secondary: { usedPercent: 4, windowSeconds: 604800, resetAt: at(2026, 6, 11, 8, 41) },
      },
      extras: [
        {
          name: 'GPT-5.3-Codex-Spark',
          primary: { usedPercent: 0, windowSeconds: 18000, resetAt: at(2026, 6, 8, 0, 45) },
          secondary: { usedPercent: 0, windowSeconds: 604800, resetAt: at(2026, 6, 14, 0, 45) },
        },
      ],
      fetchedAt: NOW,
    },
    ...over,
  };
}

/** 收集卡片树里所有 callback behavior（分享卡必须为零）。 */
function collectCallbacks(card: object): unknown[] {
  const found: unknown[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>;
      if (o.type === 'callback') found.push(o);
      Object.values(o).forEach(walk);
    }
  };
  walk(card);
  return found;
}

/** 收集卡片树里所有 chart 元素。 */
function collectCharts(card: object): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>;
      if (o.tag === 'chart') found.push(o);
      Object.values(o).forEach(walk);
    }
  };
  walk(card);
  return found;
}

describe('formatTokensZh', () => {
  it('renders 亿/万 with one decimal, stripping trailing .0', () => {
    expect(formatTokensZh(4_271_434_092)).toBe('42.7亿');
    expect(formatTokensZh(258_804_367)).toBe('2.6亿');
    expect(formatTokensZh(100_000_000)).toBe('1亿');
    expect(formatTokensZh(448_568)).toBe('44.9万');
    expect(formatTokensZh(10_000)).toBe('1万');
  });
  it('keeps small numbers as grouped digits', () => {
    expect(formatTokensZh(9_530)).toBe('9,530');
    expect(formatTokensZh(0)).toBe('0');
  });
  it('rounds 万 up to 1亿 at the boundary instead of emitting 10000万', () => {
    expect(formatTokensZh(99_999_999)).toBe('1亿');
  });
  it('dashes for missing values', () => {
    expect(formatTokensZh(undefined)).toBe('—');
  });
});

describe('windowLabel / resetLabel', () => {
  it('labels the canonical 5h/7d windows', () => {
    expect(windowLabel(18000)).toBe('5 小时');
    expect(windowLabel(604800)).toBe('7 天');
  });
  it('falls back to rounded hours/days for unknown windows', () => {
    expect(windowLabel(3600)).toBe('1 小时');
    expect(windowLabel(172800)).toBe('2 天');
    expect(windowLabel(undefined)).toBe('限额');
  });
  it('renders 今天/明天/M月D日 against a fixed now', () => {
    expect(resetLabel(at(2026, 6, 7, 23, 28), NOW)).toBe('今天 23:28');
    expect(resetLabel(at(2026, 6, 8, 0, 28), NOW)).toBe('明天 00:28');
    expect(resetLabel(at(2026, 6, 11, 8, 41), NOW)).toBe('6月11日 08:41');
  });
});

describe('heatmapCells', () => {
  it('renders a FIXED 14-week window (14 列/7 行 = 2:1 = 正方格), regardless of data span', () => {
    const h = heatmapCells([{ date: '2026-03-25', tokens: 1 }], '2026-06-07');
    expect(h.weeks).toBe(14);
    expect(h.startDate).toBe('2026-03-02'); // 2026-06-01(一) 往前 13 周
    expect(h.endDate).toBe('2026-06-07');
    expect(h.values).toHaveLength(14 * 7); // 2026-06-07 是周日，末列完整
    const sparse = heatmapCells([], '2026-06-07');
    expect(sparse.weeks).toBe(14); // 没数据也不收窄——格子比例是固定的
  });
  it('emits no cells after today (mid-week cut)', () => {
    // 2026-06-03 是周三：末列只有 一/二/三 共 3 格
    const h = heatmapCells([{ date: '2026-06-01', tokens: 5 }], '2026-06-03', 2);
    expect(h.values).toHaveLength(7 + 3);
    const lastWeek = h.values.filter((v) => v.week === '6/1');
    expect(lastWeek.map((v) => v.day)).toEqual(['一', '二', '三']);
  });
  it('fills missing days with zero and keeps real values', () => {
    const h = heatmapCells([{ date: '2026-06-01', tokens: 5 }], '2026-06-07', 1);
    const monday = h.values.find((v) => v.week === '6/1' && v.day === '一');
    expect(monday?.value).toBe(5);
    expect(h.values.filter((v) => v.value === 0)).toHaveLength(h.values.length - 1);
  });
  it('labels columns with the Monday M/D and rows with 一~日', () => {
    const h = heatmapCells([], '2026-06-07', 2);
    expect(new Set(h.values.map((v) => v.week))).toEqual(new Set(['5/25', '6/1']));
    expect(h.values.slice(0, 7).map((v) => v.day)).toEqual(['一', '二', '三', '四', '五', '六', '日']);
  });
});

describe('heatmapChartEl / progressChartEl', () => {
  it('builds a common+heatmap chart spec (same shape as the field-tested card)', () => {
    const el = heatmapChartEl([{ date: '2026-06-01', tokens: 5 }], '2026-06-07') as {
      tag: string;
      aspect_ratio: string;
      chart_spec: { type: string; series: { type: string }[]; color: { range: string[] } };
    };
    expect(el.tag).toBe('chart');
    expect(el.aspect_ratio).toBe('2:1');
    expect(el.chart_spec.type).toBe('common');
    expect(el.chart_spec.series[0]!.type).toBe('heatmap');
    expect(el.chart_spec.color.range).toHaveLength(5);
  });

  it('polish: rounded square cells, no stroke, hidden weekday labels, label-as-valueField tooltip', () => {
    const json = JSON.stringify(heatmapChartEl([{ date: '2026-06-01', tokens: 5 }], '2026-06-07'));
    // 圆角靠自定义 symbol path（cell 是 symbol 图元，矩形 cornerRadius 对它无效）
    expect(json).toContain('"shape":"M -0.5 -0.25 Q');
    expect(json).not.toContain('cornerRadius');
    expect(json).not.toContain('stroke');
    expect(json).not.toContain('datum =>'); // 字符串函数飞书不 eval，已实测踩坑——绝不能再出现
    const el = heatmapChartEl([], '2026-06-07') as {
      chart_spec: {
        series: { valueField: string; cell: { style: { fill: { field: string } } } }[];
        axes: { orient: string; label?: { visible: boolean } }[];
      };
    };
    // tooltip 走 valueField=label（格式化串），色阶 fill 显式绑数值 value
    expect(el.chart_spec.series[0]!.valueField).toBe('label');
    expect(el.chart_spec.series[0]!.cell.style.fill.field).toBe('value');
    const left = el.chart_spec.axes.find((a) => a.orient === 'left');
    expect(left?.label?.visible).toBe(false); // 星期标签隐藏，对齐官方观感
  });
  it('builds one axis-less linearProgress per window with a constant-string percent tooltip', () => {
    const el = progressChartEl(bundle().usage.main.primary!) as {
      tag: string;
      chart_spec: {
        type: string;
        tooltip: { visible: boolean; mark: { content: { key: string; value: string }[] } };
        axes: { visible: boolean }[];
        data: { values: { type: string; value: number }[] }[];
      };
    };
    expect(el.tag).toBe('chart');
    expect(el.chart_spec.type).toBe('linearProgress');
    expect(el.chart_spec.data[0]!.values).toEqual([{ type: '5 小时剩余', value: 0.99 }]);
    // 标题行（markdown）承载名称/剩余%/重置时间 → 轴全隐藏，天然左对齐
    expect(el.chart_spec.axes.every((a) => a.visible === false)).toBe(true);
    // 单数据点 + 构卡时数值已知 → tooltip 用常量字符串显示百分比（纯 JSON 可行）
    expect(el.chart_spec.tooltip.visible).toBe(true);
    expect(el.chart_spec.tooltip.mark.content).toEqual([{ key: '5 小时剩余', value: '99%' }]);
  });
});

describe('heatmap cell labels', () => {
  it('carries an official-style formatted label per cell (tooltip 经 valueField 显示它)', () => {
    const h = heatmapCells([{ date: '2026-06-01', tokens: 214_924_384 }], '2026-06-07', 1);
    const cell = h.values.find((v) => v.day === '一' && v.week === '6/1');
    expect(cell?.label).toBe('6月1日 使用了 2.1亿 Token');
    const empty = h.values.find((v) => v.day === '二' && v.week === '6/1');
    expect(empty?.label).toBe('6月2日 无用量');
  });
});

describe('planLabel', () => {
  it('maps known plans and prettifies unknown ones', () => {
    expect(planLabel('prolite')).toBe('Pro Lite');
    expect(planLabel('plus')).toBe('Plus');
    expect(planLabel('quorum')).toBe('Quorum');
    expect(planLabel(undefined)).toBeUndefined();
  });
});

describe('effortLabel', () => {
  it('maps reasoning efforts to the official Chinese labels', () => {
    expect(effortLabel('xhigh')).toBe('超高');
    expect(effortLabel('high')).toBe('高');
    expect(effortLabel('max')).toBe('最高');
    expect(effortLabel('ultra')).toBe('超强');
    expect(effortLabel('unknown-tier')).toBe('unknown-tier');
  });
});

describe('formatDurationZh', () => {
  it('renders 小时/分 like the official Chinese profile page', () => {
    expect(formatDurationZh(4529)).toBe('1 小时 15 分'); // 75.48 分 → 75 分
    expect(formatDurationZh(2520)).toBe('42 分');
    expect(formatDurationZh(7200)).toBe('2 小时');
  });
  it('dashes for missing values', () => {
    expect(formatDurationZh(undefined)).toBe('—');
  });
});

describe('buildUsageCard', () => {
  it('renders a loading phase', () => {
    const json = JSON.stringify(buildUsageCard({ phase: 'loading' }));
    expect(json).toContain('正在拉取');
  });

  it('renders the ready card: charts + text fallbacks + stats + buttons', () => {
    const card = buildUsageCard({ phase: 'ready', data: bundle(), now: NOW, today: '2026-06-07' });
    const json = JSON.stringify(card);
    // 限额：每窗口一行标题（名称+剩余%+重置）+ 一条进度图；5 小时在 7 天之前
    expect(collectCharts(card)).toHaveLength(3); // 2×linearProgress + heatmap
    expect(json).toContain('剩余 99%');
    expect(json).toContain('剩余 96%');
    expect(json).toContain('明天 00:28 重置');
    expect(json).toContain('6月11日 08:41 重置');
    expect(json.indexOf('5 小时限额')).toBeLessThan(json.indexOf('7 天限额'));
    // 统计（中文标签，对齐官方资料页）
    expect(json).toContain('42.7亿');
    expect(json).toContain('累计 Token 数');
    expect(json).toContain('2.6亿');
    expect(json).toContain('峰值 Token 数');
    expect(json).toContain('1 小时 15 分');
    expect(json).toContain('最长任务时长');
    expect(json).toContain('20 天');
    expect(json).toContain('当前连续天数');
    expect(json).toContain('31 天');
    expect(json).toContain('最长连续天数');
    // 套餐展示在注脚；其他模型限额不展示
    expect(json).toContain('Pro Lite 套餐');
    expect(json).not.toContain('GPT-5.3-Codex-Spark');
    expect(json).toContain('每日 Token 用量');
    expect(json).not.toContain('色深'); // 不要色阶说明注脚
    expect(json).toContain('生成分享卡');
    // 活动洞察双栏（官方口径）
    expect(json).toContain('活动洞察');
    expect(json).toContain('常用插件 / 技能');
    expect(json).toContain('超高 · 62%');
    expect(json).toContain('@superpowers');
    expect(json).toContain('$design-taste-frontend');
    expect(json).toContain('1,102');
    // 副标题挂 display_name
    expect(JSON.stringify((card as { header: unknown }).header)).toContain('Clay Zhang');
  });

  it('disables forwarding on the console card (buttons would be dead in a copy)', () => {
    const card = buildUsageCard({ phase: 'ready', data: bundle(), now: NOW, today: '2026-06-07' });
    expect((card as { config: { enable_forward?: boolean } }).config.enable_forward).toBe(false);
  });

  it('renders error phases with kind-specific copy', () => {
    expect(JSON.stringify(buildUsageCard({ phase: 'error', kind: 'need-relogin', message: 'x' }))).toContain(
      'codex login',
    );
    expect(JSON.stringify(buildUsageCard({ phase: 'error', kind: 'api-key-mode', message: 'x' }))).toContain(
      'ChatGPT 登录',
    );
    const transient = buildUsageCard({ phase: 'error', kind: 'transient', message: 'HTTP 503' });
    expect(JSON.stringify(transient)).toContain('HTTP 503');
  });

  it('survives missing windows / empty profile fields', () => {
    const data = bundle();
    data.usage = { main: {}, extras: [], fetchedAt: NOW };
    data.profile = { topInvocations: [], dailyBuckets: [] };
    const json = JSON.stringify(buildUsageCard({ phase: 'ready', data, now: NOW, today: '2026-06-07' }));
    expect(json).toContain('暂无限额数据');
    expect(json).toContain('—');
  });
});

describe('buildUsageShareCard', () => {
  it('is pure display: zero callback behaviors, forwardable', () => {
    const card = buildUsageShareCard(bundle(), { now: NOW, today: '2026-06-07' });
    expect(collectCallbacks(card)).toHaveLength(0);
    // 不显式禁转发（飞书默认可转发）
    expect((card as { config: { enable_forward?: boolean } }).config.enable_forward).toBeUndefined();
    expect((card as { config: { streaming_mode?: boolean } }).config.streaming_mode).toBeUndefined();
  });

  it('carries the display name as plain text (never a person element), no 浮夸 wording', () => {
    const card = buildUsageShareCard(bundle(), { now: NOW, today: '2026-06-07' });
    const json = JSON.stringify(card);
    expect(json).toContain('Clay Zhang 的 Codex 用量');
    expect(json).not.toContain('战绩');
    expect(json).not.toContain('"person"');
  });

  it('shows 统计 + 洞察 + 限额（图+文本）+ footer, without leaking identifiers or plan', () => {
    const card = buildUsageShareCard(bundle(), { now: NOW, today: '2026-06-07' });
    const json = JSON.stringify(card);
    expect(collectCharts(card)).toHaveLength(3); // heatmap + 2×linearProgress
    expect(json).toContain('42.7亿');
    expect(json).toContain('活动洞察');
    expect(json).toContain('剩余 99%');
    // 头部副标题带统计截止日；页脚右对齐「由 项目名 于 几点 生成」，项目名链到飞书介绍文档
    expect(json).toContain('统计截至 2026-06-07');
    expect(json).toContain('[feishu-CN-bridge](https://my.feishu.cn/docx/AFKNdf4QaooL5OxSR8bc5H7vn7b)');
    expect(json).toContain('于 6月7日 19:00 生成');
    expect(json).toContain('"text_align":"right"');
    expect(json).toContain('💎 **套餐**　Pro Lite'); // 全选时套餐区块在
    expect(json).not.toContain('GPT-5.3-Codex-Spark'); // 其他模型限额不展示
    expect(json).not.toMatch(/@(?!superpowers)/); // 除 @插件名 外没有 @（无 email）
  });

  it('honors section selection with dynamic layout (absent blocks drop their hr too)', () => {
    const countHr = (c: object): number => JSON.stringify(c).split('"tag":"hr"').length - 1;
    const full = buildUsageShareCard(bundle(), { now: NOW, today: '2026-06-07' });
    expect(countHr(full)).toBe(4); // 5 区块 → 4 条分隔线
    const partial = buildUsageShareCard(bundle(), {
      now: NOW,
      today: '2026-06-07',
      sections: new Set(['stats', 'heatmap'] as const),
    });
    const json = JSON.stringify(partial);
    expect(json).toContain('42.7亿');
    expect(json).toContain('每日 Token 用量');
    expect(json).not.toContain('活动洞察');
    expect(json).not.toContain('限额');
    expect(json).not.toContain('套餐'); // 没选套餐就不出现
    expect(countHr(partial)).toBe(1); // 2 区块 → 1 条分隔线
    expect(collectCharts(partial)).toHaveLength(1); // 只剩热力图
    const single = buildUsageShareCard(bundle(), {
      now: NOW,
      today: '2026-06-07',
      sections: new Set(['heatmap'] as const),
    });
    expect(countHr(single)).toBe(0); // 单区块零分隔线
  });

  it('falls back to 我的 when display name is missing', () => {
    const data = bundle();
    data.profile = { ...data.profile, displayName: undefined };
    expect(JSON.stringify(buildUsageShareCard(data, { now: NOW, today: '2026-06-07' }))).toContain(
      '我的 Codex 用量',
    );
  });
});

describe('parseShareSections', () => {
  it('treats empty selection as ALL sections', () => {
    expect(parseShareSections(undefined)).toEqual(new Set(SHARE_SECTIONS.map((s) => s.key)));
    expect(parseShareSections([])).toEqual(new Set(SHARE_SECTIONS.map((s) => s.key)));
    expect(parseShareSections('')).toEqual(new Set(SHARE_SECTIONS.map((s) => s.key)));
  });
  it('accepts array and comma-string forms, dropping unknown keys', () => {
    expect(parseShareSections(['heatmap', 'bogus'])).toEqual(new Set(['heatmap']));
    expect(parseShareSections('stats,limits')).toEqual(new Set(['stats', 'limits']));
  });
});

describe('buildShareConfigCard', () => {
  it('renders a multi-select form with all sections and a submit button', () => {
    const card = buildShareConfigCard();
    const json = JSON.stringify(card);
    expect(json).toContain('multi_select_static');
    for (const s of SHARE_SECTIONS) expect(json).toContain(s.label);
    expect(json).toContain('dm.usage.share.do');
    expect(json).toContain('不选 = 全部展示');
    expect((card as { config: { enable_forward?: boolean } }).config.enable_forward).toBe(false);
  });
  it('appends a done note after generation', () => {
    expect(JSON.stringify(buildShareConfigCard(true))).toContain('已生成');
  });
});
