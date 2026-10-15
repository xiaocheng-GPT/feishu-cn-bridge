import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 只需 appDir：更新锁 / 更新状态文件都落在这里。指到临时目录，绝不碰真 home。
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'update-lock-test-'));
  return { paths: { appDir } };
});

import { paths } from '../src/config/paths';
import { acquireUpdateLock, clearUpdateStatus, readUpdateStatus, writeUpdateStatus } from '../src/service/update';

const lockFile = (): string => join(paths.appDir, 'update.lock');

afterEach(() => {
  rmSync(lockFile(), { force: true });
  clearUpdateStatus();
});

// B（跨进程更新锁）：防止 Web「升级」与私聊「更新」并发跑两个 `npm i -g` 装坏全局目录。
// O_EXCL 原子占有 + 陈旧回收（持有者已死 / 超 10min）。纯 fs，mac 上可测。
describe('acquireUpdateLock（跨进程更新互斥）', () => {
  it('持锁期间第二次 acquire 返回 null；release 后可再拿', () => {
    const r1 = acquireUpdateLock();
    expect(typeof r1).toBe('function');
    expect(existsSync(lockFile())).toBe(true);

    // 活体、新鲜的持有者（就是本测试进程）→ 第二次判「进行中」，绝不并发 npm。
    expect(acquireUpdateLock()).toBeNull();

    r1!();
    expect(existsSync(lockFile())).toBe(false);

    const r3 = acquireUpdateLock(); // 已释放 → 能再拿
    expect(typeof r3).toBe('function');
    r3!();
  });

  it('陈旧锁（持有者已死）被回收', () => {
    // 一个几乎不可能存在的 pid：process.kill(pid,0) → ESRCH → 判死 → 回收。
    writeFileSync(lockFile(), JSON.stringify({ pid: 2147483000, at: Date.now() }), 'utf8');
    const r = acquireUpdateLock();
    expect(typeof r).toBe('function'); // 回收死锁并抢到
    r!();
  });

  it('陈旧锁（存活但超 30min 的旧时间戳，pid 复用兜底）被回收', () => {
    // pid 是自己（活着），但时间太旧 → 走「存活+超时」的 pid 复用兜底分支回收。
    writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, at: Date.now() - 31 * 60 * 1000 }), 'utf8');
    const r = acquireUpdateLock();
    expect(typeof r).toBe('function');
    r!();
  });

  it('release 只删属于自己的锁：文件被换成别的 pid 时不误删', () => {
    const r = acquireUpdateLock();
    expect(typeof r).toBe('function');
    // 模拟锁被回收后换了新主（另一个存活进程 = 本测试进程，但 pid 记成别的值）。
    writeFileSync(lockFile(), JSON.stringify({ pid: process.pid + 1, at: Date.now() }), 'utf8');
    r!(); // 我们的 release：发现 pid 不是自己 → 不动
    expect(existsSync(lockFile())).toBe(true); // 新主的锁仍在
  });
});

// D（更新结果状态）：给 detached helper 的结果一个 daemon 能读、Web 能轮询的落点。
describe('update status 读/写/清', () => {
  it('无记录返回 null；写后可读；清后又为 null', () => {
    expect(readUpdateStatus()).toBeNull();

    writeUpdateStatus({ phase: 'error', ok: false, from: '0.6.6', message: '安装失败：x', at: 123 });
    const s = readUpdateStatus();
    expect(s?.phase).toBe('error');
    expect(s?.from).toBe('0.6.6');
    expect(s?.message).toContain('安装失败');

    clearUpdateStatus();
    expect(readUpdateStatus()).toBeNull();
  });

  it('损坏的状态文件读成 null（不抛）', () => {
    writeFileSync(join(paths.appDir, 'update-status.json'), '{ not json', 'utf8');
    expect(readUpdateStatus()).toBeNull();
  });
});
