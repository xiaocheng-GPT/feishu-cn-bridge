import type { ServiceStatus } from './common';
import {
  installLaunchd,
  isLoaded as launchdLoaded,
  restartLaunchd,
  statusLaunchd,
  tailLaunchdLogs,
  uninstallLaunchd,
} from './launchd';
import {
  installWinStartup,
  restartWinStartup,
  statusWinStartup,
  uninstallWinStartup,
  winStartupRunning,
} from './win-startup';
import {
  installSystemd,
  restartSystemd,
  statusSystemd,
  systemdActive,
  uninstallSystemd,
} from './systemd';
import { tailServiceLogs } from './common';

export type { ServiceStatus };

export interface ServiceAdapter {
  install(): Promise<ServiceStatus>;
  uninstall(): Promise<void>;
  status(): Promise<ServiceStatus>;
  restart(): Promise<ServiceStatus>;
  logs(follow: boolean): Promise<void>;
}

/**
 * The background-service adapter for the current platform: launchd on macOS,
 * Task Scheduler on Windows, systemd (user units) on Linux/WSL. Throws a
 * friendly error on any other platform — the foreground `run` command works
 * everywhere and is the supported fallback there.
 */
export function getServiceAdapter(): ServiceAdapter {
  if (process.platform === 'darwin') {
    return {
      install: installLaunchd,
      uninstall: uninstallLaunchd,
      status: async () => statusLaunchd(),
      restart: restartLaunchd,
      logs: tailLaunchdLogs,
    };
  }

  if (process.platform === 'win32') {
    return {
      install: installWinStartup,
      uninstall: uninstallWinStartup,
      status: async () => statusWinStartup(),
      restart: restartWinStartup,
      logs: tailServiceLogs,
    };
  }

  if (process.platform === 'linux') {
    return {
      install: installSystemd,
      uninstall: uninstallSystemd,
      status: async () => statusSystemd(),
      restart: restartSystemd,
      logs: tailServiceLogs,
    };
  }

  throw new Error(
    'service：当前平台暂不支持后台服务（仅 macOS launchd / Windows 计划任务 / Linux systemd）。' +
      '请用 `feishu-CN-bridge run` 前台运行。',
  );
}

/**
 * Sync check: is the OS background service currently running? Used by the update
 * flow to decide whether to restart the daemon. Returns false on platforms
 * without a service implementation (where there's nothing to restart).
 */
export function isServiceRunning(): boolean {
  try {
    if (process.platform === 'darwin') return launchdLoaded();
    if (process.platform === 'win32') return winStartupRunning();
    if (process.platform === 'linux') return systemdActive();
  } catch {
    /* service manager unavailable → treat as not running */
  }
  return false;
}
