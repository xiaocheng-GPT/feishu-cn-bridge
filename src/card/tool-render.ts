import type { ToolEntry } from './run-state';

const HEADER_TITLE_MAX = 120;
const OUTPUT_MAX = 1200;
/** Full command shown in a panel body (```bash) — generous so a long/multi-line
 * command stays readable, but still bounded so one tool can't blow the body. */
const CMD_BLOCK_MAX = 1000;
/** Per-line cap for the batched「N 个工具调用」summary. Far larger than the
 * one-line header cap: the summary is the ONLY place a batched tool's command is
 * shown, so clipping it to 80 (the old behavior) is exactly the「看不全脚本」pain. */
const SUMMARY_LINE_MAX = 400;
/**
 * Cumulative cap on a tool's body markdown. Output blocks can stack to
 * multi-KB which, across many panels, pushes the card past Feishu's
 * per-element size limit (~30KB) and 400s the whole stream. Last belt.
 */
const BODY_TOTAL_MAX = 2500;

function statusIcon(status: ToolEntry['status']): string {
  return status === 'done' ? '✅' : status === 'error' ? '❌' : '⏳';
}

/** A type glyph so the process reads like a COT step list at a glance — command
 * / file / search get a distinct icon; generic (mcp) & untyped tools get none
 * (keeps them clean and preserves the plain `status + title` for label tools). */
function kindGlyph(kind: ToolEntry['kind']): string {
  switch (kind) {
    case 'command':
      return '🔧';
    case 'file':
      return '📄';
    case 'search':
      return '🔍';
    default:
      return '';
  }
}

/** `status ⚡ **title**` — the leading glyphs (run/done/fail + type) give the
 * step-list, COT-like feel. */
function leadGlyphs(tool: ToolEntry): string {
  const glyph = kindGlyph(tool.kind);
  return glyph ? `${statusIcon(tool.status)} ${glyph}` : statusIcon(tool.status);
}

/** One-line panel header: status + type glyph + title (the command, for shell).
 * Clipped to one line — the FULL command lives in the body (see
 * {@link toolBodyMd}), so this staying short doesn't hide anything. */
export function toolHeaderText(tool: ToolEntry): string {
  return `${leadGlyphs(tool)} **${escapeInline(truncate(tool.title, HEADER_TITLE_MAX))}**`;
}

/**
 * One list line for the batched「N 个工具调用」summary: status + type glyph + the
 * tool's command/label, kept nearly whole ({@link SUMMARY_LINE_MAX}) so a batched
 * shell command is actually readable instead of clipped to a one-line header.
 * Used when a group degrades to a single summary panel (too many tools / over
 * budget).
 */
export function toolSummaryLine(tool: ToolEntry): string {
  return `- ${leadGlyphs(tool)} **${escapeInline(truncate(tool.title, SUMMARY_LINE_MAX))}**`;
}

/**
 * Panel body: for a shell command, lead with the FULL command as a ```bash block
 * (+ cwd) so expanding the panel shows exactly what ran — the header's one-line
 * clip never hides the script. Then the command's output as a ```bash block
 * (Error on non-zero exit). Pre-fenced output (the fileChange ```diff block)
 * passes through untouched. Non-command tools carry a short label title that the
 * header already shows in full, so they get no lead.
 */
export function toolBodyMd(tool: ToolEntry): string {
  const lead = invocationMd(tool);
  const outputPart = tool.output
    ? outputBlock(tool)
    : tool.status === 'running'
      ? '_运行中…_'
      : tool.kind === 'search'
        ? '_（搜索结果已用于作答，不单独回传）_'
        : '';
  const body = [lead, outputPart].filter(Boolean).join('\n\n');
  if (body.length <= BODY_TOTAL_MAX) return body;
  return `${body.slice(0, BODY_TOTAL_MAX)}…\n\n_（内容过长，已截断）_`;
}

/** Full command (```bash) + its secondary detail for a shell tool; '' for
 * label-titled tools. `detail` is backend-defined (codex → cwd, Claude → the
 * command's description), so it's rendered as a neutral muted line, not labeled
 * as a cwd. */
function invocationMd(tool: ToolEntry): string {
  if (tool.kind !== 'command') return '';
  const cmd = tool.title.trim();
  if (!cmd) return '';
  const detail = tool.detail ? `\n\`${escapeInline(tool.detail)}\`` : '';
  return `**命令**\n\`\`\`bash\n${truncate(cmd, CMD_BLOCK_MAX)}\n\`\`\`${detail}`;
}

/** The output/error block for a tool with output. */
function outputBlock(tool: ToolEntry): string {
  const label = tool.status === 'error' ? 'Error' : 'Output';
  const block = tool.output!.startsWith('```') ? tool.output! : bashBlock(tool.output!);
  return `**${label}**\n${block}`;
}

/** Raw output in a ```bash fence; over OUTPUT_MAX it's cut with a size note.
 * The note states the full size, NOT "see the log" — full tool output never
 * reaches the bridge log, and group members have no log access anyway. */
function bashBlock(output: string): string {
  const note = output.length > OUTPUT_MAX ? `\n_（已截断，完整输出 ${output.length} 字符）_` : '';
  return `\`\`\`bash\n${truncate(output, OUTPUT_MAX)}\n\`\`\`${note}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Collapse whitespace so a multi-line command stays on the header's one line. */
function escapeInline(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
