import { emitKeypressEvents } from 'node:readline';

/**
 * Minimal interactive checkbox multi-select for the terminal — no dependency
 * (the package ships only commander/qrcode-terminal). Used by `bot use` to pick
 * the active set of bots: ↑/↓ (or j/k) move, Space toggles, a toggles all,
 * Enter confirms, q / Esc / Ctrl+C cancels.
 *
 * Renders on the terminal's **alternate screen buffer** and repaints the whole
 * frame (home + clear) every keypress. That sidesteps the brittle "move the
 * cursor up N lines" arithmetic of in-place redraws, which miscounts whenever a
 * line wraps (CJK is double-width, so the footer/labels wrap easily) and leaves
 * duplicated lines stacking down the screen. On exit the original screen is
 * restored, then the caller prints the result. (TTY only.)
 *
 * Returns the selected item indices, or `null` if the user cancelled. Callers
 * must check `process.stdin.isTTY` first and offer a non-interactive path
 * (e.g. `bot use <names...>`).
 */
export interface CheckboxItem {
  label: string;
  /** dimmed trailing detail (appId / tenant / bot name) */
  hint?: string;
  checked?: boolean;
}

const ESC = '\x1b';
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const HOME_AND_CLEAR = `${ESC}[H${ESC}[2J`;

export async function checkboxSelect(title: string, items: CheckboxItem[]): Promise<number[] | null> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY) throw new Error('checkboxSelect requires an interactive TTY');

  const checked = items.map((it) => Boolean(it.checked));
  let cursor = 0;

  const frame = (): string => {
    const lines: string[] = [title, ''];
    items.forEach((it, i) => {
      const box = checked[i] ? '\x1b[32m[x]\x1b[0m' : '[ ]';
      const pointer = i === cursor ? '\x1b[36m>\x1b[0m' : ' ';
      const label = i === cursor ? `\x1b[1m${it.label}\x1b[0m` : it.label;
      const hint = it.hint ? `  \x1b[2m${it.hint}\x1b[0m` : '';
      lines.push(`${pointer} ${box} ${label}${hint}`);
    });
    const n = checked.filter(Boolean).length;
    lines.push('');
    lines.push(`\x1b[2m${n} 个已勾选 · ↑↓ 移动 · 空格勾选 · a 全选 · 回车确认 · q 取消\x1b[0m`);
    return lines.join('\r\n');
  };

  const redraw = (): void => {
    output.write(HOME_AND_CLEAR + frame());
  };

  emitKeypressEvents(input);
  const wasRaw = Boolean(input.isRaw);
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    output.write(`${SHOW_CURSOR}${ALT_SCREEN_OFF}`);
  };

  input.setRawMode?.(true);
  input.resume();
  output.write(`${ALT_SCREEN_ON}${HIDE_CURSOR}`);
  // Safety net: if something throws past our handlers, don't leave the terminal
  // stuck on the alternate screen with a hidden cursor.
  process.once('exit', restore);
  redraw();

  return await new Promise<number[] | null>((resolve) => {
    const cleanup = (): void => {
      input.off('keypress', onKey);
      input.setRawMode?.(wasRaw);
      input.pause();
      process.off('exit', restore);
      restore();
    };

    const onKey = (_str: string, key: { name?: string; ctrl?: boolean; sequence?: string }): void => {
      const name = key?.name;
      if ((key?.ctrl && name === 'c') || name === 'escape' || name === 'q') {
        cleanup();
        resolve(null);
        return;
      }
      if (name === 'return' || name === 'enter') {
        cleanup();
        resolve(checked.flatMap((on, i) => (on ? [i] : [])));
        return;
      }
      if (name === 'up' || name === 'k') {
        cursor = (cursor - 1 + items.length) % items.length;
        redraw();
        return;
      }
      if (name === 'down' || name === 'j') {
        cursor = (cursor + 1) % items.length;
        redraw();
        return;
      }
      if (name === 'space') {
        checked[cursor] = !checked[cursor];
        redraw();
        return;
      }
      if (name === 'a') {
        const allOn = checked.every(Boolean);
        for (let i = 0; i < checked.length; i++) checked[i] = !allOn;
        redraw();
        return;
      }
    };

    input.on('keypress', onKey);
  });
}
