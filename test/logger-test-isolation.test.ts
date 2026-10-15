import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { log, TEST_LOGS_DIR } from '../src/core/logger';

/** Concat every *.log under dir ('' when the dir doesn't exist). Reading the
 * whole dir (not just today's file) keeps the test immune to a UTC-midnight
 * date rollover between the write and the read. */
function readAllLogs(dir: string): string {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('');
  } catch {
    return '';
  }
}

describe('logger 测试环境隔离（问题4：vitest 不得污染生产日志）', () => {
  it('VITEST 下文件落盘改道临时目录，生产日志收不到测试条目', async () => {
    // vitest 自己保证这个 env；若有一天 runner 换了，这条先红，提醒补探测。
    expect(process.env.VITEST).toBeTruthy();

    const marker = `isolation-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    log.warn('logger', 'isolation-probe', { marker });

    // WriteStream 异步刷盘——轮询到出现为止（上限 2s，正常 <10ms）。
    let tmpContent = '';
    for (let i = 0; i < 40 && !tmpContent.includes(marker); i++) {
      await new Promise((r) => setTimeout(r, 50));
      tmpContent = readAllLogs(TEST_LOGS_DIR);
    }
    expect(tmpContent).toContain(marker);

    // 生产日志目录（若存在）绝不能出现这条测试日志。
    const prodContent = readAllLogs(join(homedir(), '.feishu-CN-bridge', 'logs'));
    expect(prodContent).not.toContain(marker);
  });
});
