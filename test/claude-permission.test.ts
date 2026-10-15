import { describe, expect, it } from 'vitest';
import { permissionOptions } from '../src/agent/claude-agent/permission';

/**
 * 锁定 claude-agent 三档权限 → SDK 选项的映射（安全关键，纯函数无网络）。
 * 这些不变量经 spike4/5/6 在 macOS 实证（写限 cwd / qa 只读 / 堵禁沙箱逃逸）。
 */
const CWD = '/Users/x/proj';

describe('permissionOptions —— 三档权限映射', () => {
  it('full：bypassPermissions + 无沙箱（= danger-full-access）', () => {
    const o = permissionOptions('full', true, CWD);
    expect(o.permissionMode).toBe('bypassPermissions');
    expect(o.allowDangerouslySkipPermissions).toBe(true);
    expect(o.sandbox).toBeUndefined();
    expect(o.disallowedTools).toBeUndefined();
  });

  it('undefined 档 → 当作 full（保留历史默认）', () => {
    const o = permissionOptions(undefined, undefined, CWD);
    expect(o.permissionMode).toBe('bypassPermissions');
    expect(o.sandbox).toBeUndefined();
  });

  it('write：沙箱开 + 堵逃逸 + fail-closed，但不禁写工具、不锁只读', () => {
    const o = permissionOptions('write', true, CWD);
    expect(o.permissionMode).toBe('bypassPermissions');
    expect(o.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false, // 关键：堵 dangerouslyDisableSandbox 逃逸
    });
    // write 不应把整个 cwd 设为只读
    expect((o.sandbox as { filesystem?: { denyWrite?: string[] } }).filesystem?.denyWrite).toBeUndefined();
    // network=on → 不禁联网工具
    expect(o.disallowedTools ?? []).not.toContain('WebFetch');
  });

  it('qa：在 write 基础上把 cwd 设只读 + 移除写工具', () => {
    const o = permissionOptions('qa', false, CWD);
    expect(o.permissionMode).toBe('bypassPermissions');
    expect((o.sandbox as { allowUnsandboxedCommands?: boolean }).allowUnsandboxedCommands).toBe(false);
    expect((o.sandbox as { filesystem?: { denyWrite?: string[] } }).filesystem?.denyWrite).toEqual([CWD]);
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['Write', 'Edit', 'NotebookEdit']));
  });

  it('network=off → 移除 WebFetch/WebSearch（离线）；on → 不移除', () => {
    const off = permissionOptions('write', false, CWD);
    expect(off.disallowedTools).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch']));
    const on = permissionOptions('write', true, CWD);
    expect(on.disallowedTools ?? []).not.toContain('WebFetch');
  });

  it('fail-closed：qa/write 永远带 failIfUnavailable（沙箱起不来即报错，绝不静默放行）', () => {
    for (const mode of ['qa', 'write'] as const) {
      const o = permissionOptions(mode, false, CWD);
      expect((o.sandbox as { failIfUnavailable?: boolean }).failIfUnavailable).toBe(true);
    }
  });
});
