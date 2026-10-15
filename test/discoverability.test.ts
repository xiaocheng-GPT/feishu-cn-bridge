import { describe, expect, it } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { DISCOVERY_SCOPES, GRANT_SCOPES, REQUIRED_SCOPES, SCOPE_LABELS } from '../src/config/scopes';
import { OPTIONAL_EVENTS, REQUIRED_EVENTS } from '../src/utils/event-diagnosis';
import { classifyReaction, CONTINUE_EMOJIS, STOP_EMOJIS } from '../src/bot/handle-message';
import { onboardGroup, sidebarPcUrl } from '../src/project/onboarding';
import type { Project } from '../src/project/registry';

// ── M-6 群内可发现性三件套：scope / 事件清单 ─────────────────────────

describe('DISCOVERY_SCOPES（M-6 可选组）', () => {
  it('两个新 scope 进 GRANT_SCOPES（一键开通链接预勾选）', () => {
    expect(DISCOVERY_SCOPES).toEqual(['im:chat.menu_tree:write_only', 'im:message.reactions:read']);
    for (const s of DISCOVERY_SCOPES) expect(GRANT_SCOPES).toContain(s);
  });

  it('绝不进 REQUIRED_SCOPES —— 不卡安装门（缺权限只告知不阻塞）', () => {
    for (const s of DISCOVERY_SCOPES) expect(REQUIRED_SCOPES).not.toContain(s);
  });

  it('每个 GRANT scope 都有中文标签（doctor 卡可读化）', () => {
    for (const s of GRANT_SCOPES) expect(SCOPE_LABELS[s], s).toBeTruthy();
  });
});

describe('OPTIONAL_EVENTS（事件订阅诊断清单）', () => {
  it('reaction 入站事件进可选清单，必需清单不变', () => {
    expect(OPTIONAL_EVENTS).toContain('im.message.reaction.created_v1');
    expect(OPTIONAL_EVENTS).toContain('application.bot.menu_v6');
    expect(REQUIRED_EVENTS).toEqual(['im.message.receive_v1']);
  });
});

// ── reaction → 意图的纯决策 ──────────────────────────────────────────

describe('classifyReaction（运行中 OK/DONE=终止，终态 👍=继续）', () => {
  it('运行中卡片：STOP_EMOJIS → stop，👍/其他 → null', () => {
    for (const e of STOP_EMOJIS) expect(classifyReaction(e, true)).toBe('stop');
    expect(classifyReaction('THUMBSUP', true)).toBeNull();
    expect(classifyReaction('SMILE', true)).toBeNull();
  });

  it('终态卡片：CONTINUE_EMOJIS → continue，OK/DONE/其他 → null', () => {
    for (const e of CONTINUE_EMOJIS) expect(classifyReaction(e, false)).toBe('continue');
    for (const e of STOP_EMOJIS) expect(classifyReaction(e, false)).toBeNull();
    expect(classifyReaction('HEART', false)).toBeNull();
  });

  it('两个集合不相交（同一 emoji 不能既续轮又终止）', () => {
    for (const e of STOP_EMOJIS) expect(CONTINUE_EMOJIS.has(e)).toBe(false);
  });
});

// ── 群菜单 onboarding ────────────────────────────────────────────────

describe('sidebarPcUrl（PC 端 applink sidebar-semi 前缀）', () => {
  it('前缀正确且原 URL 被编码（含 & / # 不会污染外层 query）', () => {
    const url = 'https://my.feishu.cn/wiki/x?a=1&b=2#frag';
    const link = sidebarPcUrl(url);
    expect(link.startsWith('https://applink.feishu.cn/client/web_url/open?mode=sidebar-semi&url=')).toBe(true);
    expect(link).toContain(encodeURIComponent(url));
    expect(link).not.toContain('b=2#'); // 原样拼接会出现的形态
  });
});

interface FakeCalls {
  menuPayloads: unknown[];
  tabCount: number;
}

/** onboardGroup 所需的最小 rawClient 假件；menuFail 时 chatMenuTree.create 抛错。 */
function fakeChannel(calls: FakeCalls, menuFail = false): LarkChannel {
  return {
    rawClient: {
      im: {
        v1: {
          message: { create: async () => ({ data: { message_id: 'om_welcome' } }) },
          pin: { create: async () => ({}) },
          chatTab: {
            create: async () => {
              calls.tabCount++;
              return {};
            },
          },
          chatMenuTree: {
            create: async (payload: unknown) => {
              if (menuFail) throw new Error('99991672 no permission: im:chat.menu_tree:write_only');
              calls.menuPayloads.push(payload);
              return {};
            },
          },
        },
      },
    },
  } as unknown as LarkChannel;
}

function project(origin: 'created' | 'joined' = 'created'): Project {
  return { name: 'p', chatId: 'oc_x', cwd: '/tmp/p', blank: false, createdAt: 0, origin };
}

describe('onboardGroup 群菜单（M-6）', () => {
  it('created 群：挂「🤖 Codex」REDIRECT_LINK 菜单，PC 链接带 sidebar-semi 前缀', async () => {
    const calls: FakeCalls = { menuPayloads: [], tabCount: 0 };
    await onboardGroup(fakeChannel(calls), project());
    expect(calls.menuPayloads).toHaveLength(1);
    const p = calls.menuPayloads[0] as {
      path: { chat_id: string };
      data: {
        menu_tree: {
          chat_menu_top_levels: {
            chat_menu_item: {
              action_type: string;
              name: string;
              redirect_link: { common_url: string; pc_url: string };
            };
          }[];
        };
      };
    };
    expect(p.path.chat_id).toBe('oc_x');
    const item = p.data.menu_tree.chat_menu_top_levels[0]!.chat_menu_item;
    expect(item.action_type).toBe('REDIRECT_LINK');
    expect(item.name).toBe('🤖 Codex');
    expect(item.redirect_link.pc_url).toBe(sidebarPcUrl(item.redirect_link.common_url));
    expect(item.redirect_link.pc_url).toContain('mode=sidebar-semi');
  });

  it('claude-agent 群：菜单名按后端展示名 → 「🤖 Claude」', async () => {
    const calls: FakeCalls = { menuPayloads: [], tabCount: 0 };
    await onboardGroup(fakeChannel(calls), { ...project(), backend: 'claude-agent' });
    const item = (calls.menuPayloads[0] as { data: { menu_tree: { chat_menu_top_levels: { chat_menu_item: { name: string } }[] } } })
      .data.menu_tree.chat_menu_top_levels[0]!.chat_menu_item;
    expect(item.name).toBe('🤖 Claude');
  });

  it('joined 群（bot 是普通成员）不动群结构：不挂菜单也不加 Tab', async () => {
    const calls: FakeCalls = { menuPayloads: [], tabCount: 0 };
    await onboardGroup(fakeChannel(calls), project('joined'));
    expect(calls.menuPayloads).toHaveLength(0);
    expect(calls.tabCount).toBe(0);
  });

  it('缺 scope（create 抛错）优雅降级：不 throw，其余 onboarding 照常', async () => {
    const calls: FakeCalls = { menuPayloads: [], tabCount: 0 };
    await expect(onboardGroup(fakeChannel(calls, true), project())).resolves.toBeUndefined();
    expect(calls.tabCount).toBe(1); // 菜单失败不影响 Tab 已先行完成
  });
});
