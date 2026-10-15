import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { paths } from '../src/config/paths';
import { resolveProjectsRootDir } from '../src/project/lifecycle';

describe('resolveProjectsRootDir', () => {
  it('keeps the historical default when the setting is omitted or blank', () => {
    expect(resolveProjectsRootDir()).toBe(paths.projectsRootDir);
    expect(resolveProjectsRootDir('   ')).toBe(paths.projectsRootDir);
  });

  it('supports absolute paths and trims surrounding whitespace', () => {
    const customRoot = resolve(homedir(), 'custom-feishu-projects');
    expect(resolveProjectsRootDir(`  ${customRoot}  `)).toBe(customRoot);
  });

  it('expands ~ paths from the user home directory', () => {
    expect(resolveProjectsRootDir('~')).toBe(homedir());
    expect(resolveProjectsRootDir('~/code/feishu-projects')).toBe(join(homedir(), 'code', 'feishu-projects'));
  });

  it('rejects relative paths and invalid manually-edited values', () => {
    expect(() => resolveProjectsRootDir('relative/projects')).toThrow(/绝对路径/);
    expect(() => resolveProjectsRootDir(123)).toThrow(/必须是字符串/);
  });
});
