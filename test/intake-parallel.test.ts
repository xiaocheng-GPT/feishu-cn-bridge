import { describe, expect, it } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { fetchThreadContext, filterHistorySince } from '../src/bot/context-weave';

// M-1 入站并行化的正确性关键：话题上文与 resolveThread 并行时拿不到 codexEmpty，
// 于是投机按全量（sinceTime:0）拉取、汇合后用 filterHistorySince 收敛成增量。
// 这组测试钉死「投机全量 + 本地过滤 ≡ 串行按水位拉取」的逐字节等价 —— 等价的
// 前提是 fetchThreadContext 的 API 调用对任何 sinceTime 完全相同（单页拉取，
// sinceTime 只是本地 filter），一旦实现改成服务端过滤/分页，这里会先红。

function fakeChannel(items: unknown[]): LarkChannel {
  return {
    rawClient: {
      im: { v1: { message: { list: async () => ({ data: { items } }) } } },
    },
  } as unknown as LarkChannel;
}

function userMsg(id: string, createTime: number, text = `m-${id}`): Record<string, unknown> {
  return {
    message_id: id,
    msg_type: 'text',
    create_time: String(createTime),
    sender: { id: 'ou_u', sender_type: 'user', sender_name: 'U' },
    body: { content: JSON.stringify({ text }) },
  };
}

/** 串行版（按水位拉）与投机版（全量拉 + 本地过滤）必须产出同一结果。 */
async function expectEquivalent(items: unknown[], sinceTime: number, limit?: number): Promise<void> {
  const ch = fakeChannel(items);
  const serial = await fetchThreadContext(ch, 'omt_x', { sinceTime, limit });
  const speculative = filterHistorySince(await fetchThreadContext(ch, 'omt_x', { limit }), sinceTime);
  expect(speculative).toEqual(serial);
}

describe('filterHistorySince（投机全量拉取 ≡ 串行按水位拉取）', () => {
  // newest-first，混入 bot 消息与撤回消息（fetchThreadContext 内部会滤掉）
  const items = [
    userMsg('om_5', 5000),
    { message_id: 'om_bot', msg_type: 'text', create_time: '4500', sender: { id: 'cli_b', sender_type: 'app', sender_name: 'Bot' }, body: { content: JSON.stringify({ text: 'bot 回复' }) } },
    userMsg('om_4', 4000),
    { ...userMsg('om_del', 3500), deleted: true },
    userMsg('om_3', 3000),
    userMsg('om_2', 2000),
    userMsg('om_1', 1000),
  ];

  it('水位在中间：只留水位之后的增量（严格大于，恰等于水位的被滤掉）', async () => {
    const full = await fetchThreadContext(fakeChannel(items), 'omt_x', {});
    expect(filterHistorySince(full, 3000).map((m) => m.messageId)).toEqual(['om_4', 'om_5']);
    await expectEquivalent(items, 3000);
  });

  it('sinceTime 0（codexEmpty 全量场景）原样返回', async () => {
    const full = await fetchThreadContext(fakeChannel(items), 'omt_x', {});
    expect(filterHistorySince(full, 0)).toEqual(full);
    await expectEquivalent(items, 0);
  });

  it('水位之后超过 limit 条：两条路径同样收敛到最新的 limit 条', async () => {
    const many = Array.from({ length: 30 }, (_, i) => userMsg(`om_${i}`, 1000 + i)).reverse();
    await expectEquivalent(many, 1005, 10); // 24 条新于水位 > limit 10
    const full = await fetchThreadContext(fakeChannel(many), 'omt_x', { limit: 10 });
    expect(filterHistorySince(full, 1005)).toHaveLength(10);
  });

  it('全量切片混入 createTime=0 的噪音消息也不破坏等价', async () => {
    const noisy = [userMsg('om_new', 9000), { ...userMsg('om_zero', 0), create_time: undefined }, userMsg('om_old', 1000)];
    await expectEquivalent(noisy, 5000);
    await expectEquivalent(noisy, 500);
  });

  it('水位之后为空（最常见的热路径）：收敛为空数组，不织任何块', async () => {
    const full = await fetchThreadContext(fakeChannel(items), 'omt_x', {});
    expect(filterHistorySince(full, 99999)).toEqual([]);
    await expectEquivalent(items, 99999);
  });
});
