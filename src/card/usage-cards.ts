import type {
  AccountProfileStats,
  AccountUsageBundle,
  DailyBucket,
  RateBucket,
  RateWindow,
  UsageErrorKind,
} from '../agent/types';
import { actions, button, card, hr, md, note, noteMd, submitButton, type CardElement, type CardObject } from './cards';
import { DM } from './dm-cards';

/**
 * Codex 用量卡：DM 控制台的「📊 用量」子卡（带刷新/分享按钮、原地更新）+
 * 可被用户原生转发的「战绩分享卡」（纯展示、零回调按钮、发后不更新——数据定格）。
 *
 * 渲染选型（方案 B，真机实测通过后采用）：
 *  - 热力图：chart 组件 + VChart `common`+`heatmap` 系列（GitHub 风格，PC 端 hover 可看
 *    每日 token 数）。heatmap 不在飞书官方列出的 13 种图表类型里，但实测渲染正常；
 *    chart spec 与实测卡逐字段一致，不引入未验证的变体。
 *  - 限额：chart `linearProgress`（官方列表内类型）。**关键数字同时以文本呈现**——
 *    万一某端图表降级，剩余 % 与重置时间仍在卡片上。
 *  - 统计行：column_set flow 布局，桌面一行四格、手机自动折行。
 */

// ── 纯格式化（导出供测试）────────────────────────────────────────────

/** 中文单位缩写：4271434092 → 42.7亿；258804367 → 2.6亿；448568 → 44.9万；9530 → 9,530。 */
export function formatTokensZh(n?: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  const fmt = (v: number): string => {
    const s = v.toFixed(1);
    return s.endsWith('.0') ? s.slice(0, -2) : s;
  };
  if (n >= 1e8) return `${fmt(n / 1e8)}亿`;
  if (n >= 1e4) {
    const s = fmt(n / 1e4);
    return s === '10000' ? '1亿' : `${s}万`; // 边界进位：99,999,999 → 1亿 而非 10000万
  }
  return n.toLocaleString('en-US');
}

/** 窗口时长标签：18000s → 5 小时；604800s → 7 天。 */
export function windowLabel(seconds?: number): string {
  if (!seconds) return '限额';
  if (seconds === 18000) return '5 小时';
  if (seconds === 604800) return '7 天';
  return seconds < 86400 ? `${Math.round(seconds / 3600)} 小时` : `${Math.round(seconds / 86400)} 天`;
}

/** 重置时刻 → 「今天 00:28 / 明天 08:41 / 6月11日 08:41」（宿主机本地时区）。 */
export function resetLabel(resetAtSec: number, nowMs = Date.now()): string {
  const d = new Date(resetAtSec * 1000);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const dayKey = (x: Date): string => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const now = new Date(nowMs);
  if (dayKey(d) === dayKey(now)) return `今天 ${hm}`;
  const tomorrow = new Date(nowMs + 86400_000);
  if (dayKey(d) === dayKey(tomorrow)) return `明天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 本地日期 YYYY-MM-DD（宿主机时区）。 */
export function localDateStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 热力图的日期运算全走 UTC 纪元日，规避 DST/时区坑；日期仅以 YYYY-MM-DD 字符串进出。
function toEpochDay(date: string): number {
  const [y = 1970, m = 1, d = 1] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400_000;
}
function fromEpochDay(day: number): string {
  const d = new Date(day * 86400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
/** 该日所在周的周一（epoch day）。 */
function mondayOf(day: number): number {
  const dow = new Date(day * 86400_000).getUTCDay(); // 0=Sun..6=Sat
  return day - ((dow + 6) % 7);
}

const DAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const;

export interface HeatmapCell {
  /** 列标签：该列周一的 M/D */
  week: string;
  /** 行标签：一~日 */
  day: string;
  /** 当日 token 数（缺失日补 0，作色阶输入） */
  value: number;
  /** 悬停展示用（官方口径）：「5月19日 使用了 2亿 Token」 */
  label: string;
}
export interface HeatmapData {
  values: HeatmapCell[];
  /** 网格覆盖的起止日期（YYYY-MM-DD） */
  startDate: string;
  endDate: string;
  weeks: number;
}

/**
 * 热力图数据：列=周（周一起始）、行=星期。buckets 是稀疏的（只含有用量的日期），
 * 缺失日补 0。窗口**固定 weeks 列**（默认 14：14 列 / 7 行 = 2:1，恰好等于图表的
 * aspect_ratio，格子是正方形——这是格子不变扁的关键，别随数据跨度自适应）。
 * today 之后的未来日不产格子（右下角短一截是「本周还没过完」的正常形态）。
 */
export function heatmapCells(buckets: DailyBucket[], today = localDateStr(), weeks = 14): HeatmapData {
  const todayDay = toEpochDay(today);
  const tokensByDay = new Map<number, number>();
  for (const b of buckets) tokensByDay.set(toEpochDay(b.date), b.tokens);

  const startMonday = mondayOf(todayDay) - (weeks - 1) * 7;

  const weekLabel = (c: number): string => {
    const d = new Date((startMonday + c * 7) * 86400_000);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  };
  const values: HeatmapCell[] = [];
  for (let c = 0; c < weeks; c++) {
    for (let r = 0; r < 7; r++) {
      const day = startMonday + c * 7 + r;
      if (day > todayDay) continue;
      const v = tokensByDay.get(day) ?? 0;
      const d = new Date(day * 86400_000);
      const date = `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
      const label = v > 0 ? `${date} 使用了 ${formatTokensZh(v)} Token` : `${date} 无用量`;
      values.push({ week: weekLabel(c), day: DAY_LABELS[r] ?? '', value: v, label });
    }
  }
  return { values, startDate: fromEpochDay(startMonday), endDate: today, weeks };
}

/** GitHub 蓝色系色带（浅→深）；0 值为浅灰。与真机实测卡同款。 */
const HEAT_RANGE = ['#ebedf0', '#bbdefb', '#64b5f6', '#1e88e5', '#0d47a1'];

/**
 * 圆角方块的自定义 symbol 路径（单位坐标，圆角 ≈ 边长 25%，对齐官方观感）。
 * 为什么不用 cornerRadius：VChart 的 heatmap cell 是 **symbol 图元**（默认
 * symbolType 'rect'，见 vchart/src/mark/cell.ts 的 createSymbol），矩形的
 * cornerRadius 样式对它无效；而 symbol 的 shape 支持自定义 SVG path——纯 JSON。
 */
const ROUNDED_CELL =
  'M -0.5 -0.25 Q -0.5 -0.5 -0.25 -0.5 L 0.25 -0.5 Q 0.5 -0.5 0.5 -0.25 L 0.5 0.25 Q 0.5 0.5 0.25 0.5 L -0.25 0.5 Q -0.5 0.5 -0.5 0.25 Z';

/**
 * 热力图 chart 元素。对齐官方资料页观感：正方形圆角小方块（14 列/7 行 + aspect 2:1
 * = 正方格）、留白间隙、无描边、无星期标签。
 *
 * tooltip 带单位的实现（飞书 chart_spec 是纯 JSON、不收函数，字符串函数表达式
 * 也只会被原样展示——已实测踩坑）：把 valueField 指到预格式化的 label 字段
 * （「5月19日 使用了 2亿 Token」），默认 tooltip 就会显示它；而色阶 fill 显式
 * 绑定数值 value 字段，不受影响。
 */
export function heatmapChartEl(buckets: DailyBucket[], today?: string): CardElement {
  const h = heatmapCells(buckets, today);
  return {
    tag: 'chart',
    aspect_ratio: '2:1',
    chart_spec: {
      type: 'common',
      padding: 4,
      data: [{ id: 'usage', values: h.values }],
      series: [
        {
          type: 'heatmap',
          xField: 'week',
          yField: 'day',
          valueField: 'label',
          cell: { style: { fill: { field: 'value', scale: 'color' }, shape: ROUNDED_CELL } },
        },
      ],
      color: { type: 'linear', domain: [{ dataId: 'usage', fields: ['value'] }], range: HEAT_RANGE },
      axes: [
        {
          orient: 'bottom',
          type: 'band',
          bandPadding: 0.25,
          domainLine: { visible: false },
          tick: { visible: false },
        },
        {
          orient: 'left',
          type: 'band',
          bandPadding: 0.25,
          domainLine: { visible: false },
          tick: { visible: false },
          label: { visible: false },
        },
      ],
      legends: { visible: false },
      tooltip: { visible: true, mark: { title: { visible: false } } },
    },
  };
}

/** plan_type → 展示名（未知值原样首字母大写）。 */
export function planLabel(plan?: string): string | undefined {
  if (!plan) return undefined;
  const m: Record<string, string> = {
    free: 'Free',
    go: 'Go',
    plus: 'Plus',
    pro: 'Pro',
    prolite: 'Pro Lite',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    edu: 'Edu',
    education: 'Edu',
  };
  return m[plan] ?? plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** 秒 → 「1 小时 15 分 / 42 分」（对齐官方资料页「最长任务时长」的中文口径）。 */
export function formatDurationZh(seconds?: number): string {
  if (seconds === undefined || seconds === null || Number.isNaN(seconds) || seconds < 0) return '—';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} 分`;
  const h = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${h} 小时 ${rem} 分` : `${h} 小时`;
}

// ── 共享片段 ──────────────────────────────────────────────────────────

const remainingPct = (w: RateWindow): number => Math.max(0, 100 - w.usedPercent);

/**
 * 单条限额进度图（值=剩余比例，linearProgress 硬性要求 0~1）。坐标轴全部隐藏——
 * 窗口名/剩余 %/重置时间由上方的 markdown 标题行承载（天然左对齐、百分比常显）。
 * tooltip：默认只会显示 0.99 这种小数，而纯 JSON 没有格式化函数——但**本图只有
 * 一个数据点且数值构卡时已知**，所以 content 直接写常量字符串（「5 小时剩余 99%」）。
 */
export function progressChartEl(w: RateWindow): CardElement {
  const label = `${windowLabel(w.windowSeconds)}剩余`;
  return {
    tag: 'chart',
    height: '40px',
    chart_spec: {
      type: 'linearProgress',
      data: [{ id: 'p', values: [{ type: label, value: remainingPct(w) / 100 }] }],
      xField: 'value',
      yField: 'type',
      cornerRadius: 8,
      bandWidth: 12,
      axes: [
        { orient: 'left', type: 'band', visible: false },
        { orient: 'bottom', type: 'linear', visible: false },
      ],
      tooltip: {
        visible: true,
        mark: { title: { visible: false }, content: [{ key: label, value: `${remainingPct(w)}%` }] },
      },
    },
  };
}

/** 主限额（5h + 7d）元素组：每个窗口 = 标题行（名称+剩余%+重置时间）+ 进度条。 */
function rateLimitElements(bucket: RateBucket, nowMs: number): CardElement[] {
  const out: CardElement[] = [];
  const icons = ['⚡', '📅'];
  [bucket.primary, bucket.secondary].forEach((w, i) => {
    if (!w) return;
    const reset = w.resetAt ? `　<font color='grey'>${resetLabel(w.resetAt, nowMs)} 重置</font>` : '';
    out.push(md(`${icons[i]} **${windowLabel(w.windowSeconds)}限额**　剩余 ${remainingPct(w)}%${reset}`));
    out.push(progressChartEl(w));
  });
  if (!out.length) return [note('暂无限额数据')];
  return out;
}

/** 五格统计行（桌面一行、手机自动折行）。 */
function statColumns(items: { value: string; label: string }[]): CardElement {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: 'large',
    columns: items.map((it) => ({
      tag: 'column',
      width: 'auto',
      elements: [
        { tag: 'markdown', content: `**${it.value}**`, text_size: 'heading' },
        noteMd(it.label),
      ],
    })),
  };
}

/** 五格统计，标签对齐官方中文资料页口径。 */
function profileStatItems(p: AccountProfileStats): { value: string; label: string }[] {
  return [
    { value: formatTokensZh(p.lifetimeTokens), label: '累计 Token 数' },
    { value: formatTokensZh(p.peakDailyTokens), label: '峰值 Token 数' },
    { value: formatDurationZh(p.longestTurnSec), label: '最长任务时长' },
    { value: p.currentStreakDays !== undefined ? `${p.currentStreakDays} 天` : '—', label: '当前连续天数' },
    { value: p.longestStreakDays !== undefined ? `${p.longestStreakDays} 天` : '—', label: '最长连续天数' },
  ];
}

/** 热力图区块（标题 + chart）。 */
function heatmapElements(p: AccountProfileStats, today?: string): CardElement[] {
  return [md('📈 **每日 Token 用量**'), heatmapChartEl(p.dailyBuckets, today)];
}

/** 推理强度 → 官方中文口径。 */
export function effortLabel(effort: string): string {
  const m: Record<string, string> = {
    minimal: '极低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '超高',
    max: '最高',
    ultra: '超强',
  };
  return m[effort] ?? effort;
}

/**
 * 活动洞察双栏（对齐官方资料页「Activity insights / Most used plugins」）：
 * 左栏关键指标、右栏 top 插件/技能（@=插件、$=技能）。字段全部可缺省，空栏不渲染。
 */
function insightsElements(p: AccountProfileStats): CardElement[] {
  const left: string[] = [];
  if (p.fastModePct !== undefined) left.push(`Fast Mode　**${Math.round(p.fastModePct)}%**`);
  if (p.mostUsedEffort) {
    const pct = p.mostUsedEffortPct !== undefined ? ` · ${Math.round(p.mostUsedEffortPct)}%` : '';
    left.push(`最常用推理　**${effortLabel(p.mostUsedEffort)}${pct}**`);
  }
  if (p.uniqueSkillsUsed !== undefined) left.push(`使用过的技能　**${p.uniqueSkillsUsed}**`);
  if (p.totalSkillsUsed !== undefined) left.push(`技能调用总数　**${p.totalSkillsUsed.toLocaleString('en-US')}**`);
  if (p.totalThreads !== undefined) left.push(`会话总数　**${p.totalThreads.toLocaleString('en-US')}**`);
  const right = p.topInvocations
    .slice(0, 5)
    .map((t) => `${t.kind === 'plugin' ? '@' : '$'}${t.name}　**×${t.count}**`);
  const col = (title: string, lines: string[]): CardElement => ({
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [md(`**${title}**`), noteMd(lines.join('\n'))],
  });
  const columns: CardElement[] = [];
  if (left.length) columns.push(col('活动洞察', left));
  if (right.length) columns.push(col('常用插件 / 技能', right));
  if (!columns.length) return [];
  return [
    { tag: 'column_set', flex_mode: columns.length === 2 ? 'bisect' : 'stretch', horizontal_spacing: 'large', columns },
  ];
}

/** 用 hr 把存在的区块串起来——区块缺席时分隔线跟着消失，排版动态收紧。 */
function joinWithHr(blocks: CardElement[][]): CardElement[] {
  const present = blocks.filter((b) => b.length);
  const out: CardElement[] = [];
  present.forEach((b, i) => {
    if (i) out.push(hr());
    out.push(...b);
  });
  return out;
}

// ── DM 控制台用量卡 ───────────────────────────────────────────────────

export type UsageCardState =
  | { phase: 'loading' }
  | { phase: 'error'; kind: UsageErrorKind; message: string }
  | { phase: 'ready'; data: AccountUsageBundle; now?: number; today?: string };

const usageButtons = (): CardElement =>
  actions([
    button('🔄 刷新', { a: DM.usageRefresh }),
    button('📤 生成分享卡', { a: DM.usageShare }, 'primary'),
    button('⬅️ 菜单', { a: DM.menu }),
  ]);

const ERROR_COPY: Record<UsageErrorKind, { title: string; hint: string }> = {
  'no-auth': {
    title: '未找到 Codex 登录态',
    hint: '本机没有可读的 `~/.codex/auth.json`，请在宿主机终端运行 `codex login` 后重试。',
  },
  'api-key-mode': {
    title: '当前是 API-key 登录模式',
    hint: '用量统计与限额数据仅 **ChatGPT 登录**（`codex login`）可用，API-key 模式没有这份数据。',
  },
  'need-relogin': {
    title: 'Codex 登录态已失效',
    hint: '令牌已无法刷新（过期/被撤销），请在宿主机终端重新运行 `codex login`。',
  },
  transient: {
    title: '暂时拉不到数据',
    hint: '网络或 ChatGPT 服务波动，稍后点「🔄 刷新」重试。',
  },
};

/**
 * 控制台用量卡（CardKit 实体、原地更新）。`forward:false`——它带管理按钮，转出去
 * 按钮是死的徒增困惑；要分享请走「📤 生成分享卡」。
 */
export function buildUsageCard(state: UsageCardState): CardObject {
  if (state.phase === 'loading') {
    return card([md('⏳ 正在拉取 Codex 用量数据…'), note('查询 ChatGPT 后端，通常 1~3 秒。')], {
      header: { title: '📊 Codex 用量', template: 'wathet' },
      forward: false,
    });
  }

  if (state.phase === 'error') {
    const copy = ERROR_COPY[state.kind];
    return card(
      [
        md(`⚠️ **${copy.title}**`),
        md(copy.hint),
        ...(state.kind === 'transient' ? [note(state.message)] : []),
        usageButtons(),
      ],
      { header: { title: '📊 Codex 用量', template: 'orange' }, forward: false },
    );
  }

  const { profile, usage } = state.data;
  const nowMs = state.now ?? Date.now();
  const elements: CardElement[] = joinWithHr([
    rateLimitElements(usage.main, nowMs),
    [statColumns(profileStatItems(profile))],
    heatmapElements(profile, state.today),
    insightsElements(profile),
  ]);
  const plan = planLabel(usage.planType);
  elements.push(
    note(`统计截至 ${profile.statsAsOf ?? '—'}${plan ? ` · ${plan} 套餐` : ''} · 数据来自 Codex 个人资料`),
    usageButtons(),
  );
  return card(elements, {
    header: {
      title: '📊 Codex 用量',
      template: 'wathet',
      ...(profile.displayName ? { subtitle: profile.displayName } : {}),
    },
    forward: false,
  });
}

// ── 分享卡（内容可选 + 动态排版） ─────────────────────────────────────

export type ShareSectionKey = 'limits' | 'stats' | 'heatmap' | 'insights' | 'plan';

/** 分享卡可选区块（顺序即卡面顺序）。 */
export const SHARE_SECTIONS: { key: ShareSectionKey; label: string }[] = [
  { key: 'stats', label: '核心统计（累计 / 峰值 / 连续天数）' },
  { key: 'heatmap', label: '每日用量热力图' },
  { key: 'insights', label: '活动洞察与常用技能' },
  { key: 'limits', label: '限额进度（5 小时 / 7 天）' },
  { key: 'plan', label: '套餐信息' },
];

/**
 * 解析多选下拉提交值 → 区块集合。**不选 = 全部展示**（这样无需依赖多选组件的
 * 默认值语义）；提交值的形态（数组 / 逗号串）按运行时实际宽容处理，未知值丢弃。
 */
export function parseShareSections(v: unknown): Set<ShareSectionKey> {
  const all = SHARE_SECTIONS.map((s) => s.key);
  const raw = Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',') : [];
  const picked = raw.filter((x): x is ShareSectionKey => (all as string[]).includes(String(x)));
  return new Set(picked.length ? picked : all);
}

/** 「选择分享内容」表单卡：多选下拉 + 提交。done 时附生成成功提示，可再次生成。 */
export function buildShareConfigCard(done = false): CardObject {
  return card(
    [
      md('选择要放进分享卡的内容（**不选 = 全部展示**），生成后长按 / 右键即可转发：'),
      {
        tag: 'form',
        name: 'shareCfg',
        elements: [
          {
            tag: 'multi_select_static',
            name: 'secs',
            placeholder: { tag: 'plain_text', content: '默认全部展示，可只挑部分区块' },
            options: SHARE_SECTIONS.map((s) => ({ text: { tag: 'plain_text', content: s.label }, value: s.key })),
          },
          submitButton('📤 生成分享卡', { a: DM.usageShareDo }),
        ],
      },
      ...(done ? [note('✅ 分享卡已生成（见下方新卡片）。换个组合可再次生成。')] : []),
      actions([button('⬅️ 返回用量', { a: DM.usage }), button('🏠 菜单', { a: DM.menu })]),
    ],
    { header: { title: '📤 分享内容选择', template: 'blue' }, forward: false },
  );
}

/**
 * 分享卡：纯展示、**零回调按钮**、非流式、发出后永不更新——数据定格在生成时刻，
 * 用户长按（移动端）/右键（PC）即可原生转发到任何人或群（enable_forward 默认 true）。
 * 标题用 display_name 纯文本而非 person 组件：跨租户查看者解析不了 open_id 时
 * person 会降级成「未知用户」，分享卡不冒这险。不带 email/account id。
 * 区块按 sections 取舍，joinWithHr 动态排版——缺席的区块连分隔线一起消失。
 */
export function buildUsageShareCard(
  data: AccountUsageBundle,
  opts: { now?: number; today?: string; sections?: Set<ShareSectionKey> } = {},
): CardObject {
  const { profile, usage } = data;
  const nowMs = opts.now ?? Date.now();
  const sec = opts.sections ?? new Set(SHARE_SECTIONS.map((s) => s.key));
  const who = profile.displayName ? `${profile.displayName} 的` : '我的';
  const plan = planLabel(usage.planType);
  const elements: CardElement[] = joinWithHr([
    sec.has('stats') ? [statColumns(profileStatItems(profile))] : [],
    sec.has('heatmap') ? heatmapElements(profile, opts.today) : [],
    sec.has('insights') ? insightsElements(profile) : [],
    sec.has('limits') ? rateLimitElements(usage.main, nowMs) : [],
    sec.has('plan') && plan ? [md(`💎 **套餐**　${plan}`)] : [],
  ]);
  // 页脚广告位（右对齐小字）：「由 项目名 于 几点 生成」——统计截止日已在头部副标题，
  // 页脚只留生成时刻。项目名是 markdown 链接（open_url 性质，转发后依然可点，按钮
  // 回调才会死）；链接指向项目的飞书介绍文档（飞书内打开零跳出，比 GitHub 转化好）。
  const stamp = new Date(nowMs);
  const stampStr = `${stamp.getMonth() + 1}月${stamp.getDate()}日 ${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`;
  elements.push({
    tag: 'markdown',
    content: `<font color='grey'>🤖 由 </font>[feishu-CN-bridge](https://my.feishu.cn/docx/AFKNdf4QaooL5OxSR8bc5H7vn7b)<font color='grey'> 于 ${stampStr} 生成</font>`,
    text_size: 'notation',
    text_align: 'right',
  });
  return card(elements, {
    header: {
      title: `📊 ${who} Codex 用量`,
      template: 'blue',
      ...(profile.statsAsOf ? { subtitle: `统计截至 ${profile.statsAsOf}` } : {}),
    },
  });
}
