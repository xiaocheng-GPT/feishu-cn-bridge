import { describe, expect, it } from 'vitest';
import { toolBodyMd, toolHeaderText, toolSummaryLine } from '../src/card/tool-render';
import type { ToolEntry } from '../src/card/run-state';

function tool(over: Partial<ToolEntry> = {}): ToolEntry {
  return { id: 't1', title: 'npm test', status: 'done', ...over };
}

describe('toolHeaderText', () => {
  it('prefixes the status icon and collapses whitespace', () => {
    expect(toolHeaderText(tool({ title: 'npm\n  test' }))).toBe('✅ **npm test**');
    expect(toolHeaderText(tool({ status: 'error' }))).toContain('❌');
    expect(toolHeaderText(tool({ status: 'running' }))).toContain('⏳');
  });
});

describe('toolBodyMd', () => {
  it('fences raw command output as ```bash (Error label on failure)', () => {
    expect(toolBodyMd(tool({ output: 'ok' }))).toBe('**Output**\n```bash\nok\n```');
    expect(toolBodyMd(tool({ output: 'boom', status: 'error' }))).toBe('**Error**\n```bash\nboom\n```');
  });

  it('passes pre-fenced output (fileChange ```diff blocks) through untouched', () => {
    const diff = '```diff\n+new\n-old\n```';
    expect(toolBodyMd(tool({ output: diff }))).toBe(`**Output**\n${diff}`);
  });

  it('truncates oversized raw output inside the fence, noting the full size (not "see the log")', () => {
    const body = toolBodyMd(tool({ output: 'y'.repeat(5000) }));
    expect(body.length).toBeLessThan(1400);
    expect(body.startsWith('**Output**\n```bash\n')).toBe(true);
    expect(body).toContain('已截断，完整输出 5000 字符');
    expect(body).not.toContain('见日志');
    // the fence is closed BEFORE the truncation note
    expect(body).toMatch(/```\n_（已截断/);
  });

  it('renders the running/empty placeholders without output', () => {
    expect(toolBodyMd(tool({ status: 'running' }))).toBe('_运行中…_');
    expect(toolBodyMd(tool())).toBe('');
  });
});

describe('toolBodyMd — full command visibility (kind=command)', () => {
  it('leads with the FULL command as a ```bash block + cwd, then the output', () => {
    const cmd = 'cd /repo && git log --oneline -50 --stat DISTINCTIVE_TAIL_PAST_HEADER';
    const body = toolBodyMd(tool({ kind: 'command', title: cmd, detail: '/repo', output: 'main' }));
    expect(body).toContain('```bash');
    expect(body).toContain(cmd); // whole command present, never clipped to the header's one line
    expect(body).toContain('`/repo`'); // secondary detail (cwd for codex) as a neutral muted line
    expect(body).toContain('**Output**');
    expect(body.indexOf('**命令**')).toBeLessThan(body.indexOf('**Output**')); // command before output
  });

  it('shows the running command before any output arrives', () => {
    const cmd = 'sleep 30 && echo RUNNING_TAIL';
    const body = toolBodyMd(tool({ kind: 'command', title: cmd, status: 'running' }));
    expect(body).toContain(cmd);
    expect(body).toContain('运行中');
  });

  it('does NOT bash-fence a label-titled (non-command) tool — its header already shows it', () => {
    const body = toolBodyMd(tool({ kind: 'file', title: '编辑 /a/b.ts', output: 'ok' }));
    expect(body).toBe('**Output**\n```bash\nok\n```');
  });

  it('a finished web search explains itself instead of showing 无输出 (codex returns no results)', () => {
    const body = toolBodyMd(tool({ kind: 'search', title: '联网搜索：x', status: 'done' }));
    expect(body).toContain('搜索结果已用于作答');
    expect(body).not.toBe('');
  });
});

describe('toolSummaryLine', () => {
  it('keeps the tool’s FULL command, not clipped to the one-line header', () => {
    const cmd = `cd /very/long/path && ${'x'.repeat(90)} SUMMARY_TAIL`;
    const line = toolSummaryLine(tool({ kind: 'command', title: cmd }));
    expect(line.startsWith('- ✅')).toBe(true);
    expect(line).toContain('SUMMARY_TAIL'); // > 80 chars in → the old header clip would have dropped it
  });

  it('collapses whitespace so a multi-line command stays on one summary line', () => {
    const line = toolSummaryLine(tool({ kind: 'command', title: 'a\n  b\n  c' }));
    expect(line).toBe('- ✅ 🔧 **a b c**'); // status + 🔧 command glyph + one-line command
  });
});
