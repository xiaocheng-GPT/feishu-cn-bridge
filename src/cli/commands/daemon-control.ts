import { spawnProcess } from '../../platform/spawn';
import { getServiceAdapter, isServiceRunning } from '../../service/adapter';
import { appendServiceErr } from '../../service/common';
import {
  acquireUpdateLock,
  currentVersion,
  installLatest,
  isDevSource,
  writeUpdateStatus,
  type InstallResult,
} from '../../service/update';
import { buildDaemonControlCommand, type DaemonControlAction } from '../../admin/host';
import { readWebConsole } from '../../web/discovery';
import { log } from '../../core/logger';

/**
 * detached helper：Web 控制台的「重启 daemon」/「升级」按钮的真正执行者。
 *
 * Web 控制台内嵌在 daemon 进程里——若在本进程直接 service stop→start，stop 会把
 * 自己（连同正响应这条 HTTP 的事件循环）杀掉，start 永远到不了。所以 server.ts
 * detached spawn 出一个**脱离本进程**的 helper（就是这里的 `__daemon-control`
 * 子命令）：它在 daemon 死后继续把 service 拉起来。
 *
 * - restart：service.restart()（launchd kickstart -k / systemd / 计划任务）。
 * - update：先 npm i -g <pkg>@latest，成功再 restart 让新代码生效。
 * 自身绝不 throw 出进程外（detached 没有调用方接错）；只落 service.err.log。
 */

/** detached spawn 出 helper 进程（web 进程内调用，立刻返回，绝不等它）。 */
export function spawnDaemonControl(action: DaemonControlAction): void {
  const { command, args } = buildDaemonControlCommand(action);
  const child = spawnProcess(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  // 与父进程脱钩：父（被重启的 daemon）退出后 helper 仍存活，把 service 拉回来。
  child.unref();
}

/** helper 进程入口（`feishu-CN-bridge __daemon-control <action>`）。 */
export async function runDaemonControl(action: string): Promise<void> {
  try {
    if (action === 'update') {
      await doUpdate();
      return;
    }
    if (action === 'restart') {
      await doRestart('restart');
      return;
    }
    if (action === 'start') {
      await doStart();
      return;
    }
    if (action === 'stop') {
      await doStop();
      return;
    }
    log.warn('daemon-control', 'unknown-action', { action });
  } catch (err) {
    log.fail('daemon-control', err, { phase: action });
  }
}

/**
 * start：把后台服务装好并拉起（service install = launchd 写 plist + bootstrap）。
 * 由只读预览进程触发——预览本身没在跑 daemon，detached helper 把 service 装起来即可。
 * 已在跑就当幂等（install 内部 bootout+bootstrap 重建，等价重启）。
 */
async function doStart(): Promise<void> {
  await getServiceAdapter().install();
  log.info('daemon-control', 'start-issued', {});
}

/**
 * stop：停掉 daemon（两条路一起走，缺一不可）。在 web 进程里不能直停自己（会杀掉正
 * 响应这条 HTTP 的事件循环）→ 走 detached helper：daemon 被杀后 helper 仍存活把
 * 收尾走完。
 *
 * ① service manager 托管的 → uninstall（launchctl bootout + rm plist，连带移除自启）。
 *    判据用「**已安装**」（plist/unit 在盘上）而非「**在跑**」：launchd KeepAlive=true
 *    会在任何退出后立刻重启，若某个时刻 daemon 正被 SIGTERM、launchd 正重生它，
 *    `isServiceRunning()` 会瞬时读成 false——这时若只发裸 SIGTERM（走 ②），KeepAlive
 *    马上把它拉回来 →「停止不了」。只要服务定义还在就 uninstall（bootout 把它移出
 *    domain，KeepAlive 随之失效），才停得干净。
 * ② **自托管 daemon**（手动 `run` / nohup / 引导控制台 / 多 bot supervisor，全都不在
 *    service manager 里）→ 按 web-console.json 记的 pid 优雅停。**这是历史 bug：旧版
 *    doStop 在 `!isServiceRunning()` 时直接 return，对自托管 daemon 完全 no-op——用户
 *    在 Web 点「停止」毫无反应**。daemon 自己的 SIGTERM handler 会级联关闭所有 bot 子
 *    进程 + 后端 app-server/ACP（不留孤儿），所以发 SIGTERM 即可，超时再 SIGKILL。
 *
 * adapter 段整体兜在 try 里：不支持后台服务的平台 `getServiceAdapter()` 会抛——绝不能
 * 因此跳过 ② 的自托管兜底（否则那些平台上前台 run 的 daemon 永远停不掉）。
 */
async function doStop(): Promise<void> {
  let installed = false;
  try {
    const adapter = getServiceAdapter();
    installed = (await adapter.status()).installed;
    if (installed) {
      await adapter.uninstall();
      log.info('daemon-control', 'stop-issued', {});
    }
  } catch (err) {
    log.fail('daemon-control', err, { phase: 'stop-uninstall' });
  }
  const self = await stopSelfHostedDaemon();
  if (!installed && self === 'no-daemon') {
    // service manager 没托管、也没探到在跑的自托管 daemon → 真的没东西可停。
    log.info('daemon-control', 'stop-skipped-no-daemon', {});
  }
}

/** process.kill(pid,0) 活性探测：ESRCH=不存在；EPERM=存在但本进程无权 signal（仍算活）。 */
function pidAlive(pid: number, kill: KillFn): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const napDefault = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type KillFn = (pid: number, signal: NodeJS.Signals | 0) => void;

export interface StopSelfHostedDeps {
  /** 读出当前在跑的 daemon 进程 pid（默认 web-console.json 的 pid——内嵌 web 的
   *  daemon 就是 UI 显示「运行中」的那个，单 bot / supervisor / 引导态都写它）。 */
  readDaemonPid?: () => number | undefined;
  /** 注入 process.kill（测试用，绝不真杀）。 */
  kill?: KillFn;
  sleep?: (ms: number) => Promise<void>;
  selfPid?: number;
  /** SIGTERM 后等优雅退出的窗口（超时则 SIGKILL）。 */
  graceMs?: number;
  /** 活性轮询间隔。 */
  pollMs?: number;
}

export type StopSelfHostedResult = 'no-daemon' | 'stopped' | 'force-killed';

/**
 * 停掉「自托管」daemon——它们不在 service manager 里，`launchctl bootout` 对其是空
 * 操作（Web 点「停止」对这类 daemon no-op 的根因）。按 web-console.json 记的 pid 发
 * SIGTERM 触发 daemon 自身的优雅退出（级联关闭所有 bot 子进程 + 后端 app-server/ACP，
 * 不留孤儿），超时再 SIGKILL 兜底。依赖注入，便于单测，绝不真杀进程。
 */
export async function stopSelfHostedDaemon(deps: StopSelfHostedDeps = {}): Promise<StopSelfHostedResult> {
  const readDaemonPid = deps.readDaemonPid ?? ((): number | undefined => readWebConsole()?.pid);
  const kill: KillFn = deps.kill ?? ((p, s) => void process.kill(p, s));
  const nap = deps.sleep ?? napDefault;
  const selfPid = deps.selfPid ?? process.pid;
  const graceMs = deps.graceMs ?? 8_000;
  const pollMs = deps.pollMs ?? 250;

  const pid = readDaemonPid();
  // 没在跑、发现文件指向本 helper 自己（理论不会）、或那 pid 已死 → 没东西可停。
  if (pid === undefined || pid === selfPid || !pidAlive(pid, kill)) return 'no-daemon';

  try {
    kill(pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return 'no-daemon'; // 读到后、signal 前刚退
    throw err;
  }
  log.info('daemon-control', 'self-hosted-sigterm', { pid });

  for (let waited = 0; waited < graceMs; waited += pollMs) {
    await nap(pollMs);
    if (!pidAlive(pid, kill)) {
      log.info('daemon-control', 'self-hosted-stopped', { pid });
      return 'stopped';
    }
  }
  // 优雅窗口内没退（卡死 / 忽略 SIGTERM）→ 强杀。
  try {
    kill(pid, 'SIGKILL');
  } catch {
    /* 期间已退 */
  }
  log.warn('daemon-control', 'self-hosted-force-killed', { pid });
  return 'force-killed';
}

async function doUpdate(): Promise<void> {
  if (isDevSource()) {
    // 源码开发模式：npm i -g 不会更新工作副本——什么都不做（Web 端已提示走 git pull）。
    log.info('daemon-control', 'update-skipped-dev', {});
    return;
  }
  // 跨进程互斥（B）：Web「升级」与私聊「更新」可能并发，两个 `npm i -g` 同时改全局目录
  // 会把它装坏。拿不到锁＝已有更新在跑，报「进行中」并退出（不叠跑第二个安装）。
  const release = acquireUpdateLock();
  if (!release) {
    // 锁忙＝已有另一个 helper 在装（它才是真进度来源）。刻意**不**写 error 状态：
    // 否则 Web 轮询会误报「升级失败」；留白让前端继续追那个 helper 的 installing/done。
    log.info('daemon-control', 'update-skipped-in-progress', {});
    appendServiceErr('daemon-control', 'update already in progress (lock held by another trigger); skipped');
    return;
  }
  const from = currentVersion();
  writeUpdateStatus({ phase: 'installing', from, at: Date.now() });
  let res: InstallResult;
  try {
    res = await installLatest();
  } finally {
    release(); // npm 已跑完（无论成败）→ 立刻放锁；重启不需要持锁，且放早可避免被 relauncher 杀在锁里
  }
  log.info('daemon-control', 'update-installed', { ok: res.ok });
  // 同写 service.err.log：内置 `logs` 命令只 tail service.log/service.err.log，
  // 结构化事件在 logs/*.log 里用户不会去翻，更新/重启轨迹留这一份才查得到。
  appendServiceErr('daemon-control', `update-installed ok=${res.ok}`);
  if (!res.ok) {
    appendServiceErr('daemon-control', 'install failed — keeping old version, not restarting');
    // 失败落状态（D）：否则 detached helper 的失败对网页端完全静默，用户只看到「已发起」。
    writeUpdateStatus({ phase: 'error', ok: false, from, message: `安装失败：${res.message}`.slice(0, 300), at: Date.now() });
    return; // 装失败就不重启（旧版继续跑，比半装的烂摊子安全）
  }
  const to = currentVersion();
  writeUpdateStatus({ phase: 'restarting', ok: true, from, to, at: Date.now() });
  await doRestart('update');
  // restart 已发起（Windows 树外 relauncher / mac launchd）；daemon 即将被替换、Web 端
  // 会短暂断连并由版本变更流显示「已是最新版」。仍写一条 done 收尾（若本进程没先被杀）。
  writeUpdateStatus({ phase: 'done', ok: true, from, to, at: Date.now() });
}

async function doRestart(phase: string): Promise<void> {
  if (!isServiceRunning()) {
    // 服务没在跑（前台 run 的场景，或 service.pid 陈旧/对不上）→ 没有后台服务可重启。
    log.info('daemon-control', 'restart-skipped-no-service', { phase });
    appendServiceErr('daemon-control', `restart-skipped-no-service (phase=${phase}); service.pid 未指向在跑的 daemon`);
    return;
  }
  await getServiceAdapter().restart();
  log.info('daemon-control', 'restart-issued', { phase });
  appendServiceErr('daemon-control', `restart-issued (phase=${phase})`);
}
