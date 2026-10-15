import { describe, expect, it } from 'vitest';
import { buildHelpCard, type HelpScope } from '../src/card/command-cards';

// /help 按会话后端能力裁剪命令清单：不支持某命令的后端把对应 capability 显式标 false
// → 速查卡不列该命令，避免「列了点了才发现不支持」。codex（capabilities undefined ⇒
// 全 true）保持全列。caps 用泛化假对象表达，不绑定具体后端名。

const noCaps = { goal: false, compact: false, resume: false };
const scopes: HelpScope[] = ['single', 'topic', 'main'];

describe('buildHelpCard 后端能力裁剪', () => {
  it('默认（不传 caps，=codex caps undefined）→ 三 scope 仍列 /goal', () => {
    for (const s of scopes) expect(JSON.stringify(buildHelpCard(s, true, true))).toContain('/goal');
  });

  it('能力全 false（goal/compact/resume）→ 三 scope 都不列 /goal', () => {
    for (const s of scopes) {
      expect(JSON.stringify(buildHelpCard(s, true, true, noCaps))).not.toContain('/goal');
    }
  });

  it('compact=false：single/topic 不列 /compact（但仍列 /model、/context）', () => {
    for (const s of ['single', 'topic'] as HelpScope[]) {
      const j = JSON.stringify(buildHelpCard(s, true, true, noCaps));
      expect(j).not.toContain('/compact');
      expect(j).toContain('/model'); // 共享能力仍在
      expect(j).toContain('/context');
    }
  });

  it('resume=false：主群区（管理员）→ 不列 /resume，但 /settings 仍在', () => {
    const j = JSON.stringify(buildHelpCard('main', true, true, noCaps));
    expect(j).not.toContain('/resume');
    expect(j).toContain('/settings');
  });

  it('codex 主群区（管理员，无 caps）→ 仍列 /resume', () => {
    const j = JSON.stringify(buildHelpCard('main', true, true)); // 无 caps = codex
    expect(j).toContain('/resume');
  });

  it('部分能力：goal 支持但 compact 不支持 → 列 /goal 不列 /compact', () => {
    const j = JSON.stringify(buildHelpCard('single', true, true, { goal: true, compact: false }));
    expect(j).toContain('/goal');
    expect(j).not.toContain('/compact');
  });
});
