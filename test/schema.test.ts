import { describe, expect, it } from 'vitest';
import {
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getModelDisplay,
  getPendingPolicy,
  getRunIdleTimeoutMs,
  isAdmin,
  isChatAllowed,
  isUserAllowed,
  isUserAllowedInProject,
  resolveOwner,
  type AppConfig,
} from '../src/config/schema';

function cfg(preferences: AppConfig['preferences'] = {}): AppConfig {
  return {
    accounts: {
      app: {
        id: 'cli_xxx',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    preferences,
  };
}

describe('config schema helpers', () => {
  it('resolves model display: default running, explicit values, legacy boolean', () => {
    expect(getModelDisplay(cfg())).toBe('running'); // 默认：仅输出时
    expect(getModelDisplay(cfg({ showModel: 'off' }))).toBe('off');
    expect(getModelDisplay(cfg({ showModel: 'running' }))).toBe('running');
    expect(getModelDisplay(cfg({ showModel: 'always' }))).toBe('always');
    expect(getModelDisplay(cfg({ showModel: true }))).toBe('always'); // 历史布尔 → always
    expect(getModelDisplay(cfg({ showModel: false }))).toBe('off'); // 历史布尔 → off
  });

  it('resolves run idle timeout defaults, disabled value, and clamp bounds', () => {
    expect(getRunIdleTimeoutMs(cfg())).toBe(120_000);
    expect(getRunIdleTimeoutMs(cfg({ runIdleTimeoutSeconds: 0 }))).toBeUndefined();
    expect(getRunIdleTimeoutMs(cfg({ runIdleTimeoutSeconds: 1 }))).toBe(10_000);
    expect(getRunIdleTimeoutMs(cfg({ runIdleTimeoutSeconds: 2000 }))).toBe(2_000_000);
    expect(getRunIdleTimeoutMs(cfg({ runIdleTimeoutSeconds: 5000 }))).toBe(3_600_000);
    expect(getRunIdleTimeoutMs(cfg({ runIdleTimeoutSeconds: 12.9 }))).toBe(12_000);
    expect(getRunIdleTimeoutMs(cfg({ runIdleTimeoutSeconds: -1 }))).toBe(120_000);
  });

  it('resolves pending policy with steer as the default', () => {
    expect(getPendingPolicy(cfg())).toBe('steer');
    expect(getPendingPolicy(cfg({ pendingPolicy: 'queue' }))).toBe('queue');
    expect(getPendingPolicy(cfg({ pendingPolicy: 'steer' }))).toBe('steer');
  });

  it('clamps max concurrent runs to the supported range', () => {
    expect(getMaxConcurrentRuns(cfg())).toBe(10);
    expect(getMaxConcurrentRuns(cfg({ maxConcurrentRuns: 0 }))).toBe(10);
    expect(getMaxConcurrentRuns(cfg({ maxConcurrentRuns: 5.9 }))).toBe(5);
    expect(getMaxConcurrentRuns(cfg({ maxConcurrentRuns: 99 }))).toBe(50);
  });

  it('allows users and chats when allowlists are empty or omitted', () => {
    expect(isUserAllowed(cfg({ access: { allowedUsers: [] } }), 'ou_1')).toBe(true);
    expect(isChatAllowed(cfg({ access: { allowedChats: [] } }), 'oc_1')).toBe(true);
  });

  it('owner is always admin; admins 空时收紧为「仅 owner」', () => {
    // 空 config(无 owner 无 admins)→ 收紧:无人是 admin（不再 fail-open）
    expect(isAdmin(cfg(), 'ou_x')).toBe(false);
    // owner 恒为 admin，即使 admins 数组为空
    const ownerOnly = cfg({ access: { ownerOpenId: 'ou_owner', admins: [] } });
    expect(isAdmin(ownerOnly, 'ou_owner')).toBe(true);
    expect(isAdmin(ownerOnly, 'ou_other')).toBe(false);
    // owner + 额外 admin 都算 admin
    const withAdmin = cfg({ access: { ownerOpenId: 'ou_owner', admins: ['ou_a'] } });
    expect(isAdmin(withAdmin, 'ou_owner')).toBe(true);
    expect(isAdmin(withAdmin, 'ou_a')).toBe(true);
    expect(isAdmin(withAdmin, 'ou_b')).toBe(false);
  });

  it('resolveOwner: explicit ownerOpenId, else first admin (老 config 回退)', () => {
    expect(resolveOwner(cfg())).toBeUndefined();
    expect(resolveOwner(cfg({ access: { ownerOpenId: 'ou_owner' } }))).toBe('ou_owner');
    // 老 config 无 ownerOpenId → 回退首个 admin
    expect(resolveOwner(cfg({ access: { admins: ['ou_first', 'ou_second'] } }))).toBe('ou_first');
    // ownerOpenId 优先于 admins[0]
    expect(resolveOwner(cfg({ access: { ownerOpenId: 'ou_owner', admins: ['ou_first'] } }))).toBe('ou_owner');
  });

  it('isUserAllowedInProject: admin 豁免 / 空名单=所有人 / 命中或拒绝', () => {
    const c = cfg({ access: { ownerOpenId: 'ou_owner', admins: ['ou_admin'] } });
    // admin/owner 恒豁免，即使不在白名单
    expect(isUserAllowedInProject(c, { allowedUsers: ['ou_u'] }, 'ou_owner')).toBe(true);
    expect(isUserAllowedInProject(c, { allowedUsers: ['ou_u'] }, 'ou_admin')).toBe(true);
    // 空名单 / 缺省 = 所有人
    expect(isUserAllowedInProject(c, { allowedUsers: [] }, 'ou_x')).toBe(true);
    expect(isUserAllowedInProject(c, undefined, 'ou_x')).toBe(true);
    // 命中白名单
    expect(isUserAllowedInProject(c, { allowedUsers: ['ou_u'] }, 'ou_u')).toBe(true);
    // 非 admin 且不在白名单 → 拒绝
    expect(isUserAllowedInProject(c, { allowedUsers: ['ou_u'] }, 'ou_other')).toBe(false);
  });

  it('matches admins, users, and chats against configured allowlists', () => {
    const restricted = cfg({
      access: {
        admins: ['admin-1'],
        allowedUsers: ['user-1'],
        allowedChats: ['chat-1'],
      },
    });

    expect(isAdmin(restricted, 'admin-1')).toBe(true);
    expect(isAdmin(restricted, 'admin-2')).toBe(false);
    expect(isUserAllowed(restricted, 'user-1')).toBe(true);
    expect(isUserAllowed(restricted, 'user-2')).toBe(false);
    expect(isChatAllowed(restricted, 'chat-1')).toBe(true);
    expect(isChatAllowed(restricted, 'chat-2')).toBe(false);
  });

  it('resolves message reply mode with card as the default', () => {
    expect(getMessageReplyMode(cfg())).toBe('card');
    expect(getMessageReplyMode(cfg({ messageReply: 'markdown' }))).toBe('markdown');
    expect(getMessageReplyMode(cfg({ messageReply: 'text' }))).toBe('text');
    expect(getMessageReplyMode(cfg({ messageReply: 'card' }))).toBe('card');
    expect(getMessageReplyMode(cfg({ messageReply: 'bad' as never }))).toBe('card');
  });
});
