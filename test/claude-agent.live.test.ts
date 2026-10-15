import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBackend } from '../src/agent';
import type { AgentEvent } from '../src/agent/types';
import { initialState, reduce, finalMessageText, type RunState } from '../src/card/run-state';

/**
 * LIVE 集成测试：真正起一个 Claude Agent SDK 会话，验证我们的 backend/thread/
 * event-map 接进 run-state 后整条链路正确（不只是 SDK 本身）。会真实计费 + 联网，
 * 故默认 SKIP，仅 `CLAUDE_LIVE=1 npx vitest run test/claude-agent.live.test.ts` 时跑。
 */
const LIVE = process.env.CLAUDE_LIVE === '1';

async function drain(events: AsyncIterable<AgentEvent>): Promise<{ state: RunState; types: string[] }> {
  let state = initialState;
  const types: string[] = [];
  for await (const ev of events) {
    types.push(ev.type);
    state = reduce(state, ev);
  }
  return { state, types };
}

describe.runIf(LIVE)('claude-agent 后端 LIVE 集成', () => {
  it('full 档：一轮问答 → 流式文本 + done，reduce 出终态', { timeout: 120_000 }, async () => {
    const be = createBackend('claude-agent');
    const thread = await be.startThread({ cwd: process.cwd(), mode: 'full' });
    expect(thread.sessionId).toMatch(/[0-9a-f-]{36}/);

    const run = thread.runStreamed({ text: '用一句话友好地打个招呼，不要调用任何工具。' });
    const { state, types } = await drain(run.events);

    expect(types[0]).toBe('turn_started');
    expect(types).toContain('text_delta'); // 真有 token 级流式
    expect(types).toContain('done');
    expect(state.terminal).toBe('done');
    expect(finalMessageText(state).length).toBeGreaterThan(0);
    // /context 修复：上下文窗口必须是已知值（非 null/未知），由 getContextUsage 提供。
    expect(types).toContain('context_usage');
    expect(state.usage?.window).toBeGreaterThan(0);
    expect(state.usage?.used).toBeGreaterThan(0);

    await thread.close();
  });

  it('/compact：调用不抛错，返回合法 CompactResult（短会话 compacted=false）', { timeout: 120_000 }, async () => {
    const be = createBackend('claude-agent');
    const thread = await be.startThread({ cwd: process.cwd(), mode: 'full' });
    await drain(thread.runStreamed({ text: '说一句话。' }).events);
    const res = await thread.compact();
    expect(typeof res.compacted).toBe('boolean'); // 短会话多半 false（Not enough messages）
    // usage 可能为 null（getContextUsage 失败）或带窗口；有则窗口为正。
    if (res.usage) expect(res.usage.contextWindow ?? 1).toBeGreaterThan(0);
    expect(thread.isAlive()).toBe(true); // 压缩后线程仍可用
    await thread.close();
  });

  it('多轮：同一常驻 query 记得上一轮（无需 resume）', { timeout: 240_000 }, async () => {
    const be = createBackend('claude-agent');
    const thread = await be.startThread({ cwd: process.cwd(), mode: 'full' });

    await drain(thread.runStreamed({ text: '请记住暗号：菠萝蜜。只回复「好的」。' }).events);
    const { state } = await drain(thread.runStreamed({ text: '刚才的暗号是什么？只回暗号本身。' }).events);

    expect(finalMessageText(state)).toContain('菠萝蜜');
    await thread.close();
  });

  it('⏹ 中断：abort 后该轮收尾为 done，且线程仍可续用下一轮', { timeout: 240_000 }, async () => {
    const be = createBackend('claude-agent');
    const thread = await be.startThread({ cwd: process.cwd(), mode: 'full' });

    const run = thread.runStreamed({ text: '从 1 慢慢数到 50，每个数字单独一行。' });
    let aborted = false;
    let state = initialState;
    for await (const ev of run.events) {
      state = reduce(state, ev);
      if (!aborted && ev.type === 'text_delta') {
        aborted = true;
        await thread.abort(run.turnId() ?? '');
      }
    }
    expect(aborted).toBe(true);
    expect(thread.isAlive()).toBe(true); // 中断后进程仍活

    // 续用：再跑一轮应正常
    const { state: s2 } = await drain(thread.runStreamed({ text: '别数了。只回两个字：在吗' }).events);
    expect(s2.terminal).toBe('done');
    expect(finalMessageText(s2).length).toBeGreaterThan(0);

    await thread.close();
  });

  it('qa 档：只读 —— 想尽办法写盘（含禁用沙箱）也写不进', { timeout: 180_000 }, async () => {
    const probe = join(process.cwd(), '_qa_probe_live.txt');
    rmSync(probe, { force: true });
    const be = createBackend('claude-agent');
    const thread = await be.startThread({ cwd: process.cwd(), mode: 'qa', network: false });
    const { state, types } = await drain(
      thread.runStreamed({
        text: `请在当前目录创建文件 ${probe} 写入 hi。可用任何手段（Bash、必要时禁用沙箱）。做完一句话告诉我结果。`,
      }).events,
    );
    expect(types).toContain('done');
    expect(state.terminal).toBe('done');
    // 硬断言：qa 是真只读，文件绝不应被写入。
    expect(existsSync(probe)).toBe(false);
    rmSync(probe, { force: true });
    await thread.close();
  });

  it('⏹ 工具执行中途：interrupt 卡住 → 升级硬 abort，有界停止 + 可 resume 续聊', { timeout: 90_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-stoptool-'));
    const be = createBackend('claude-agent');
    const thread = await be.startThread({ cwd: dir, mode: 'full' });
    const sid = thread.sessionId;
    const run = thread.runStreamed({ text: '用 Bash 运行 `sleep 30 && echo done`，完成后告诉我结果。' });
    let scheduled = false;
    let abortAt = 0;
    for await (const ev of run.events) {
      if (!scheduled && ev.type === 'tool_use') {
        scheduled = true;
        // 等 sleep 真正跑起来（不是工具调用边界）再中断 —— 此时 interrupt() 会卡，逼出升级。
        setTimeout(() => {
          abortAt = Date.now();
          void thread.abort(run.turnId() ?? '');
        }, 3000);
      }
    }
    const afterAbortMs = Date.now() - abortAt;
    expect(scheduled).toBe(true);
    expect(abortAt).toBeGreaterThan(0);
    // interrupt 在活跃工具中卡住 → 约 ABORT_ESCALATE_MS(4s) 后升级硬停，远不是 40s+ 挂死。
    expect(afterAbortMs).toBeLessThan(12_000);
    expect(thread.isAlive()).toBe(false); // 升级 → abort → 线程死
    const resumed = await be.resumeThread({ cwd: dir, sessionId: sid, mode: 'full' });
    const { state } = await drain(resumed.runStreamed({ text: '只回两个字：在吗' }).events);
    expect(state.terminal).toBe('done');
    await resumed.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('/goal：自主跑完一个多步目标 → goal_update active→complete + done', { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-goal-'));
    const probe = join(dir, 'goal_ok.txt');
    const be = createBackend('claude-agent');
    const thread = await be.startThread({ cwd: dir, mode: 'full' });
    const run = thread.runGoal(`创建文件 ${probe} 写入一行 ok，然后用 Bash 确认它存在。`);
    const statuses: string[] = [];
    const types: string[] = [];
    let state = initialState;
    for await (const ev of run.events) {
      types.push(ev.type);
      if (ev.type === 'goal_update') statuses.push(ev.status);
      else state = reduce(state, ev);
    }
    expect(statuses[0]).toBe('active'); // 起步 active
    expect(statuses).toContain('complete'); // 自然完成 → complete
    expect(types).toContain('turn_started');
    expect(types).toContain('done');
    expect(existsSync(probe)).toBe(true); // 目标被自主完成（真建了文件）
    await thread.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('/goal 终止：跑到一半 clearGoal 硬停 → 线程死，会话可 resume 续聊', { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-goalstop-'));
    const be = createBackend('claude-agent');
    const thread = await be.startThread({ cwd: dir, mode: 'full' });
    const sid = thread.sessionId;
    const run = thread.runGoal('逐个用单独 Bash 命令创建 z1.txt 到 z8.txt，一个一个慢慢来，每步之间确认。');
    let aborted = false;
    for await (const ev of run.events) {
      if (!aborted && ev.type === 'tool_use') {
        aborted = true;
        await thread.clearGoal(); // ⏹/🎯 → abort 硬停
      }
    }
    expect(aborted).toBe(true);
    expect(thread.isAlive()).toBe(false); // abort → 线程死（resolveThread 会 evict+resume）

    // 续聊：resume 同 session 跑一轮（abort 后会话仍可恢复）
    const resumed = await be.resumeThread({ cwd: dir, sessionId: sid, mode: 'full' });
    const { state } = await drain(resumed.runStreamed({ text: '别建了。只回两个字：在吗' }).events);
    expect(state.terminal).toBe('done');
    expect(finalMessageText(state).length).toBeGreaterThan(0);
    await resumed.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
