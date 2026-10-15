import { rm } from 'node:fs/promises';
import { ensureAnyAgent, registerNewBot } from '../../bot/onboarding';
import { loadBots, findBot, activeBots, setActiveBots, removeBot } from '../../config/bots';
import { removeSecret } from '../../config/keystore';
import { secretKeyForApp } from '../../config/schema';
import { botDir } from '../../config/paths';
import { checkboxSelect } from '../checkbox';

/** `bot init [name]` — register an additional feishu app via scan-QR + authorize. */
export async function runBotInit(name?: string): Promise<void> {
  // 任一 agent 可用即放行；都无也只告警不阻塞（Web 引导下载）。
  await ensureAnyAgent();
  const result = await registerNewBot(name);
  if (!result) {
    process.exitCode = 1;
    return;
  }
  console.log('\n下一步（飞书开放平台后台，需手动一次 https://open.feishu.cn/app ）：');
  console.log('  1) 事件与回调 → 长连接 → 订阅：im.message.receive_v1 / card.action.trigger / application.bot.menu_v6');
  console.log('     （可选）「加进已有群」功能再订阅：im.chat.member.bot.added_v1 / im.chat.member.bot.deleted_v1');
  console.log('     （可选）「表情回复驱动（👍 续轮 / OK 终止）」再订阅：im.message.reaction.created_v1');
  console.log('  2) 创建并发布应用版本');
  console.log('\n`bot list` 查看全部；`bot use` 勾选要同时连接的机器人；`run` 前台跑 / `start` 后台常驻。\n');
}

/** `bot list` — list registered bots, marking the active set. */
export async function runBotList(): Promise<void> {
  const reg = await loadBots();
  if (reg.bots.length === 0) {
    console.log('（还没有注册任何飞书机器人。运行 `feishu-CN-bridge bot init` 创建。）');
    return;
  }
  const active = new Set(activeBots(reg).map((b) => b.appId));
  console.log('\n已注册的飞书机器人：\n');
  for (const b of reg.bots) {
    const mark = active.has(b.appId) ? '✅' : '⬜';
    console.log(`${mark} ${b.name.padEnd(16)} ${b.appId}  [${b.tenant}]${b.botName ? `  ${b.botName}` : ''}`);
  }
  console.log('\n\x1b[2m`bot use` 勾选要同时连接的机器人，或 `bot use <名> [名…]` 直接指定。\x1b[0m\n');
}

/**
 * `bot use [names...]` — choose the active set (multi-select). With names, sets
 * the active set to exactly those bots (overwrite). With no args on a TTY, opens
 * an interactive checkbox preselected with the current active set.
 */
export async function runBotUse(names: string[]): Promise<void> {
  const reg = await loadBots();
  if (reg.bots.length === 0) {
    console.error('✗ 还没有注册任何飞书机器人。先 `feishu-CN-bridge bot init` 创建。');
    process.exitCode = 1;
    return;
  }

  let appIds: string[];
  if (names.length > 0) {
    const resolved: string[] = [];
    const unknown: string[] = [];
    for (const n of names) {
      const b = findBot(reg, n);
      if (!b) unknown.push(n);
      else if (!resolved.includes(b.appId)) resolved.push(b.appId);
    }
    if (unknown.length) {
      console.error(`✗ 找不到机器人：${unknown.join(', ')}。已注册：${botNames(reg.bots)}`);
      process.exitCode = 1;
      return;
    }
    appIds = resolved;
  } else {
    if (!process.stdin.isTTY) {
      const cur = activeBots(reg).map((b) => b.name).join(', ') || '（空）';
      console.log(`当前活跃机器人：${cur}`);
      console.log('（非交互式终端，无法弹勾选框。用 `bot use <名> [名…]` 直接指定要同时连接的机器人。）');
      return;
    }
    const activeSet = new Set(activeBots(reg).map((b) => b.appId));
    const items = reg.bots.map((b) => ({
      label: b.name,
      hint: `${b.appId}  [${b.tenant}]${b.botName ? `  ${b.botName}` : ''}`,
      checked: activeSet.has(b.appId),
    }));
    const picked = await checkboxSelect('选择要同时连接的机器人（空格勾选，回车确认）：', items);
    if (picked === null) {
      console.log('已取消，未改动。');
      return;
    }
    appIds = picked.map((i) => reg.bots[i]?.appId).filter((id): id is string => Boolean(id));
  }

  await setActiveBots(appIds);
  const chosen = appIds.map((id) => reg.bots.find((b) => b.appId === id)?.name ?? id);
  if (chosen.length === 0) {
    console.log('✓ 已清空活跃机器人——`run` / `start` 暂不连接任何 bot。`bot use` 重新勾选。');
    return;
  }
  console.log(
    `✓ 活跃机器人（${chosen.length} 个）→ ${chosen.join(', ')}。` +
      `前台重跑 \`run\` 生效${chosen.length > 1 ? '（多进程托管）' : ''}；后台请 \`restart\`。`,
  );
}

/** `bot rm <name>` — remove a bot's config: registry entry + keystore secret + state dir. */
export async function runBotRm(name: string): Promise<void> {
  const reg = await loadBots();
  const bot = findBot(reg, name);
  if (!bot) {
    console.error(`✗ 找不到机器人「${name}」。已注册：${botNames(reg.bots)}`);
    process.exitCode = 1;
    return;
  }
  const after = await removeBot(bot.appId);
  await removeSecret(secretKeyForApp(bot.appId));
  await rm(botDir(bot.appId), { recursive: true, force: true });
  console.log(`✓ 已移除机器人「${bot.name}」(${bot.appId})：注册表 + 密钥 + 状态目录(projects/sessions)。`);

  if (after.bots.length === 0) {
    console.log('  已无任何机器人，`bot init` 重新创建。');
  } else if (after.current) {
    const cur = after.bots.find((b) => b.appId === after.current);
    if (cur) console.log(`  当前机器人现为「${cur.name}」。`);
  } else {
    console.log('  当前机器人未设置，用 `bot use <名>` 选择。');
  }
}

function botNames(bots: { name: string }[]): string {
  return bots.map((b) => b.name).join(', ') || '（无）';
}
