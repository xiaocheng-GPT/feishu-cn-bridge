import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { paths, useBotDir } from '../../config/paths';
import { ensureRegistry, currentBot } from '../../config/bots';
import { loadConfig } from '../../config/store';
import { isComplete } from '../../config/schema';
import { resolveAppSecret } from '../../config/secret-resolver';
import { buildEventConfigUrl } from '../../config/scopes';
import { diagnoseEventSubscription, summarizeEventDiagnosis } from '../../utils/event-diagnosis';
import { createBackend } from '../../agent';
import { spawnProcessSync } from '../../platform/spawn';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** true = 降级告警（⚠️，不计入失败数）——如缺可选 scope 导致事件订阅查不了。 */
  warn?: boolean;
}

/**
 * `feishu-CN-bridge doctor` — local self-check.
 * M0 scope: codex CLI + login, lark-cli, config presence. Connection/session
 * checks come online once the bridge runs (M1+).
 */
export async function runDoctor(): Promise<void> {
  const checks: Check[] = [];

  // codex CLI — 经默认后端的 doctor() 探测（M-8：不再深 import codex 探测）
  const probe = await createBackend().doctor();
  if (probe.ok) {
    checks.push({ name: 'codex CLI', ok: true, detail: `${probe.version ?? 'unknown'} (${probe.location ?? '?'})` });
  } else {
    checks.push({
      name: 'codex CLI',
      ok: false,
      detail: probe.hint ?? '未找到。设置 CODEX_BIN，或安装 @openai/codex，或装 Codex.app',
    });
  }

  // codex login (auth file presence — heuristic)
  const codexAuth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  checks.push(
    existsSync(codexAuth)
      ? { name: 'codex 登录', ok: true, detail: codexAuth }
      : { name: 'codex 登录', ok: false, detail: '未登录，运行 `codex login`' },
  );

  // lark-cli
  const larkVer = tryExec('lark-cli', ['--version']);
  checks.push(
    larkVer
      ? { name: 'lark-cli', ok: true, detail: larkVer }
      : { name: 'lark-cli', ok: false, detail: '未找到（onboarding 会装到私有目录）' },
  );

  // bridge config — resolve the current bot (migrating a legacy flat install)
  // and check ITS config dir, not the top-level one.
  const reg = await ensureRegistry();
  const cur = currentBot(reg);
  if (cur) useBotDir(cur.appId);
  if (cur && existsSync(paths.configFile)) {
    checks.push({
      name: 'bridge 配置',
      ok: true,
      detail: `当前机器人「${cur.name}」(${cur.appId})  共 ${reg.bots.length} 个`,
    });
  } else if (cur) {
    checks.push({ name: 'bridge 配置', ok: false, detail: `配置文件缺失：${paths.configFile}` });
  } else {
    checks.push({
      name: 'bridge 配置',
      ok: false,
      detail: '未配置，运行 `feishu-CN-bridge run`（或 `bot init`）扫码创建',
    });
  }

  // 事件订阅 — 版本信息 API 三态诊断（从未发布版本 / 缺 im.message.receive_v1 /
  // 配置齐全）。缺 scope / 网络不通 → warn 降级（⚠️，不计失败、不挡 exit code）。
  if (cur && existsSync(paths.configFile)) {
    checks.push(await checkEventSubscription());
  }

  // render
  console.log('\n🩺 feishu-CN-bridge 自检\n');
  for (const c of checks) {
    console.log(`  ${c.ok ? (c.warn ? '⚠️' : '✅') : '❌'} ${c.name.padEnd(12)} ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${failed === 0 ? '全部通过 ✓' : `${failed} 项需处理`}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

/** 当前机器人的事件订阅诊断（useBotDir 已切到该 bot 的配置目录）。 */
async function checkEventSubscription(): Promise<Check> {
  const name = '事件订阅';
  try {
    const cfg = await loadConfig();
    if (!isComplete(cfg)) return { name, ok: true, warn: true, detail: '配置缺失，跳过检测' };
    const { app } = cfg.accounts;
    const secret = await resolveAppSecret(cfg);
    const d = await diagnoseEventSubscription(app.id, secret, app.tenant);
    const summary = summarizeEventDiagnosis(d);
    switch (d.state) {
      case 'ok': {
        const opt = d.missingOptional?.length ? `（可选事件未订阅：${d.missingOptional.join('、')}）` : '';
        return { name, ok: true, detail: `${summary}${opt}` };
      }
      case 'unchecked':
        // 优雅降级：多半是没开通「获取应用版本信息」scope —— 提示但不算失败。
        return { name, ok: true, warn: true, detail: `${summary}；开通 application:application.app_version:readonly 后可自动检测` };
      default:
        return { name, ok: false, detail: `${summary}；去 ${buildEventConfigUrl(app.id, app.tenant)} 配置后发布版本` };
    }
  } catch (err) {
    return { name, ok: true, warn: true, detail: `未能检测（${err instanceof Error ? err.message : String(err)}）` };
  }
}

function tryExec(cmd: string, args: string[]): string | null {
  try {
    // cross-spawn so a Windows `.cmd` shim (e.g. lark-cli.cmd) resolves instead
    // of being reported as "not found".
    const res = spawnProcessSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (res.status !== 0 || typeof res.stdout !== 'string') return null;
    return res.stdout.trim();
  } catch {
    return null;
  }
}
