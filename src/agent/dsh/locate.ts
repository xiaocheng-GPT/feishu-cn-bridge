import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnProcess, spawnProcessSync } from '../../platform/spawn';

const IS_WIN = process.platform === 'win32';

/**
 * dsh CLI 探测结果。npm 全局装的 dsh 入口是 node 脚本（lib/bin.js），Windows
 * 上不能直接 spawn（会 EINVAL）——必须 `node <entry>` 起；PATH 里命中的是
 * npm 包装脚本（dsh.cmd），cross-spawn 可直接跑。isNodeScript 区分两者。
 */
export interface DshBinary {
  /** 可直接交给 cross-spawn 的入口路径。 */
  bin: string;
  /** true ⇒ spawn `node <bin>`；false ⇒ spawn `<bin>`。 */
  isNodeScript: boolean;
}

// 模块级缓存：路径/版本在 daemon 生命周期内几乎不变（同 codex-appserver/locate）。
let binCache: DshBinary | null = null;
const versionCache = new Map<string, string>();

/**
 * Resolve the dsh CLI, in priority order:
 *   1. $DSH_BIN（显式覆盖）
 *   2. PATH（`where dsh` / `which dsh`）
 *   3. npm 全局 node_modules/@deepseek-ai/dsh（win: %APPDATA%\npm；posix: npm root -g）
 * 未找到返回 null。
 */
export function resolveDshBinary(opts?: { force?: boolean }): DshBinary | null {
  if (!opts?.force && binCache && existsSync(binCache.bin)) return binCache;
  binCache = locateDsh();
  return binCache;
}

function isNodeScript(p: string): boolean {
  return /\.[mc]?js$/i.test(p);
}

function locateDsh(): DshBinary | null {
  const env = process.env.DSH_BIN;
  if (env && existsSync(env)) return { bin: env, isNodeScript: isNodeScript(env) };

  const onPath = which('dsh');
  if (onPath) return { bin: onPath, isNodeScript: isNodeScript(onPath) };

  const root = IS_WIN
    ? join(process.env.APPDATA ?? '', 'npm', 'node_modules')
    : globalNpmRoot();
  if (root) {
    const entry = join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (existsSync(entry)) return { bin: entry, isNodeScript: true };
  }
  return null;
}

function globalNpmRoot(): string {
  try {
    const res = spawnProcessSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return typeof res.stdout === 'string' ? res.stdout.trim() : '';
  } catch {
    return '';
  }
}

function which(cmd: string): string | null {
  try {
    const res = spawnProcessSync(IS_WIN ? 'where' : 'which', [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.status !== 0 || typeof res.stdout !== 'string') return null;
    const first = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean);
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

/** Async 版本探测（复用缓存；卡片回调等事件循环上下文请用此异步版）。 */
export async function dshVersionAsync(
  bin: DshBinary,
  opts?: { force?: boolean },
): Promise<string | null> {
  const key = bin.bin;
  if (!opts?.force) {
    const hit = versionCache.get(key);
    if (hit !== undefined) return hit;
  }
  const command = bin.isNodeScript ? 'node' : bin.bin;
  const args = bin.isNodeScript ? [bin.bin, '--version'] : ['--version'];
  const out = await new Promise<string | null>((resolve) => {
    let child;
    try {
      child = spawnProcess(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      stdout += d;
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? stdout.trim() : null));
  });
  if (out !== null) versionCache.set(key, out);
  return out;
}