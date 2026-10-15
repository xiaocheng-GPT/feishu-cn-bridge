import { describe, expect, it } from 'vitest';
import { createBackend } from '../src/agent';

/**
 * claude-agent 的 /resume 历史发现：listThreads/readHistory 走 SDK 的本地会话存储
 * 读取（~/.claude/projects，纯文件系统、无 API 成本，与 `claude -r` 同源）。
 * 这里只做「不抛错 + 形状正确」的容错冒烟（真实数据随机器而变，故不断言条数）。
 */
describe('claude-agent /resume 历史发现（文件系统读，无网络）', () => {
  const be = createBackend('claude-agent');

  it('capabilities.resume=true（历史卡开启）', () => {
    expect(be.capabilities?.resume).toBe(true);
  });

  it('listThreads 永远返回数组、不抛错；条目形状正确（若有）', async () => {
    const list = await be.listThreads(process.cwd(), 5);
    expect(Array.isArray(list)).toBe(true);
    for (const t of list) {
      expect(typeof t.sessionId).toBe('string');
      expect(typeof t.preview).toBe('string');
      expect(typeof t.updatedAt).toBe('number');
    }
    // 按 updatedAt 倒序
    for (let i = 1; i < list.length; i++) expect(list[i - 1]!.updatedAt).toBeGreaterThanOrEqual(list[i]!.updatedAt);
  });

  it('readHistory 对不存在的会话返回空、不抛错', async () => {
    const h = await be.readHistory(process.cwd(), '00000000-0000-0000-0000-000000000000');
    expect(h).toEqual({ turns: [], totalTurns: 0 });
  });
});
