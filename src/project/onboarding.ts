import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';
import { buildWelcomeCard } from '../card/command-cards';
import { createBackend, catalogById } from '../agent';
import { defaultNoMention, type Project } from './registry';

/** 项目后端的能力位（用于欢迎卡按后端裁剪命令）。未知/手编 id 解析失败 ⇒ undefined
 * （= 全列，与 codex 一致），绝不因此让建项目/绑群失败。 */
function welcomeCaps(backend?: string): { goal?: boolean; compact?: boolean; resume?: boolean } | undefined {
  try {
    return createBackend(backend).capabilities;
  } catch {
    return undefined;
  }
}

/** 本群后端的展示名（Codex / Claude …），用于欢迎卡与群菜单文案按后端区分。
 * 未知/未设后端 ⇒ 'Codex'（历史默认）。 */
function welcomeAgentName(backend?: string): string {
  return (backend && catalogById(backend)?.displayName) || 'Codex';
}

/**
 * Public command manual — an internet-readable Feishu doc (full command guide +
 * product intro). Linked from the welcome card and surfaced as a chat tab.
 * Empty string = skip the tab + the manual button (no broken links). Set this
 * to the doc's share URL once it's published as "互联网获取链接的人可阅读".
 */
const HELP_DOC_URL: string = 'https://my.feishu.cn/wiki/PZ23wGr7JiKK5RkIG4rcZXzGn5g';

/**
 * PC 端深链：让群菜单的链接在飞书**侧边栏**打开而不是弹独立浏览器（官方
 * `applink … mode=sidebar-semi` 前缀，见群菜单概述文档）。仅用于 menu_tree 的
 * `pc_url`；移动端走 `common_url` 原链接。Exported for tests.
 */
export function sidebarPcUrl(url: string): string {
  return `https://applink.feishu.cn/client/web_url/open?mode=sidebar-semi&url=${encodeURIComponent(url)}`;
}

/**
 * Onboard a freshly-created project group (design: 项目=群): post a welcome card
 * listing every command this group supports, Pin it (so it lives in the chat's
 * Pins tab), and add a "👈 查看可使用的命令" url tab pointing at the public manual.
 *
 * This is distinct from the 群公告 top banner ({@link setAnnouncement}): the
 * banner is the always-on one-line project header, while the Pin'd card + tab
 * are the command cheat-sheet. Every step is best-effort — the group is still
 * usable if any of them fails (e.g. missing scope).
 */
export async function onboardGroup(channel: LarkChannel, project: Project): Promise<void> {
  const kind = project.kind ?? 'multi';
  const chatId = project.chatId;
  const agentName = welcomeAgentName(project.backend);
  // In a 'joined' group the bot is a plain member, not the owner: don't Pin or
  // add a chat tab (those mutate the group's structure and a member may lack the
  // permission anyway). The one-off welcome card is still sent — it's just a
  // message. Created groups keep the full treatment (welcome → Pin → tab).
  const decorate = (project.origin ?? 'created') !== 'joined';

  // 1. Welcome card. Raw interactive JSON (no callback buttons to mutate, just
  //    an open_url link), so it needn't be a CardKit entity. For created groups
  //    we capture the message_id and Pin it; joined groups skip the Pin.
  try {
    const noMention = project.noMention ?? defaultNoMention(project);
    const content = JSON.stringify(
      buildWelcomeCard(kind, HELP_DOC_URL || undefined, noMention, welcomeCaps(project.backend), agentName),
    );
    const sent = await channel.rawClient.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content },
    });
    const messageId = (sent as { data?: { message_id?: string } }).data?.message_id;
    if (messageId && decorate) {
      await channel.rawClient.im.v1.pin.create({ data: { message_id: messageId } });
      log.info('project', 'onboard-pin', { name: project.name });
    }
  } catch (err) {
    log.fail('project', err, { phase: 'onboard-welcome' });
  }

  // 2. Chat tab → public manual. Skipped for joined groups (don't mutate the
  //    group) and when no URL is configured (otherwise we'd pin a tab to an
  //    empty link). Sits to the right of the built-in Pins tab. Only doc/url
  //    tab types are allowed by the API.
  if (decorate && HELP_DOC_URL) {
    try {
      await channel.rawClient.im.v1.chatTab.create({
        path: { chat_id: chatId },
        data: {
          chat_tabs: [{ tab_name: '👈 使用说明', tab_type: 'url', tab_content: { url: HELP_DOC_URL } }],
        },
      });
      log.info('project', 'onboard-tab', { name: project.name });
    } catch (err) {
      log.fail('project', err, { phase: 'onboard-tab' });
    }
  }

  // 3. 群菜单「🤖 <后端名>」→ 命令手册（M-6 群内可发现性）。群菜单常驻输入框上方，
  //    可见性远高于群 Tab；动作只支持 REDIRECT_LINK —— PC 端加 applink
  //    sidebar-semi 前缀在侧边栏打开，移动端走原链接。需可选 scope
  //    im:chat.menu_tree:write_only：未开通时 create 报错 → log + 跳过，
  //    其余 onboarding 不受影响（与 Pin/Tab 一致的 best-effort 语义）。
  if (decorate && HELP_DOC_URL) {
    try {
      await channel.rawClient.im.v1.chatMenuTree.create({
        path: { chat_id: chatId },
        data: {
          menu_tree: {
            chat_menu_top_levels: [
              {
                chat_menu_item: {
                  action_type: 'REDIRECT_LINK',
                  name: `🤖 ${agentName}`,
                  redirect_link: { common_url: HELP_DOC_URL, pc_url: sidebarPcUrl(HELP_DOC_URL) },
                },
              },
            ],
          },
        },
      });
      log.info('project', 'onboard-menu', { name: project.name });
    } catch (err) {
      log.fail('project', err, { phase: 'onboard-menu' });
    }
  }
}
