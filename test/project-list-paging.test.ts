import { describe, expect, it } from 'vitest';
import { buildProjectListCard, DM } from '../src/card/dm-cards';
import type { Project } from '../src/project/registry';

function project(i: number): Project {
  return {
    name: `proj-${String(i).padStart(2, '0')}`,
    chatId: `oc_${i}`,
    cwd: `/work/proj-${i}`,
    blank: false,
    createdAt: 0,
    branch: 'main',
    kind: 'multi',
  };
}

function projects(n: number): Project[] {
  return Array.from({ length: n }, (_, i) => project(i));
}

/** Every component (anything with a `tag`) anywhere in the card tree — Feishu's
 * ~200-component cap counts these, and an over-cap card is silently dropped. */
function countComponents(card: object): number {
  let n = 0;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (typeof (v as { tag?: unknown }).tag === 'string') n++;
      Object.values(v as Record<string, unknown>).forEach(walk);
    }
  };
  walk(card);
  return n;
}

/** Action callbacks `{ a, p, ... }` carried by every button in the card. */
function callbacks(card: object): { a?: string; p?: unknown }[] {
  const out: { a?: string; p?: unknown }[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.type === 'callback' && o.value && typeof o.value === 'object') out.push(o.value as { a?: string });
      Object.values(o).forEach(walk);
    }
  };
  walk(card);
  return out;
}

/** Project names visible on a card (the bold `**name**` title element). */
function namesOn(card: object, all: Project[]): string[] {
  const json = JSON.stringify(card);
  return all.map((p) => p.name).filter((name) => json.includes(`**${name}**`));
}

describe('buildProjectListCard pagination', () => {
  it('caps each page at PROJECT_LIST_PAGE_SIZE projects regardless of total', () => {
    const all = projects(39);
    const card = buildProjectListCard(all, new Map(), 0);
    expect(namesOn(card, all)).toEqual(all.slice(0, 8).map((p) => p.name));
  });

  it('a full page is the same size no matter how many projects exist beyond it', () => {
    // The pre-fix list grew one ~8-component block per project and 39 of them
    // blew past Feishu's ~200 cap → the card was silently dropped. With paging,
    // a full page's footprint is bounded and INDEPENDENT of the total count, so
    // it can never grow back into the drop zone.
    const small = countComponents(buildProjectListCard(projects(24), new Map(), 0));
    const huge = countComponents(buildProjectListCard(projects(100), new Map(), 0));
    expect(huge).toBe(small);
  });

  it('first page has 下一页 but no 上一页', () => {
    const card = buildProjectListCard(projects(39), new Map(), 0);
    const json = JSON.stringify(card);
    expect(json).toContain('下一页');
    expect(json).not.toContain('上一页');
    expect(json).toContain('第 1/5 页');
    const next = callbacks(card).find((c) => c.a === DM.projects && c.p === 1);
    expect(next).toBeDefined();
  });

  it('a middle page has both 上一页 and 下一页 pointing to the neighbours', () => {
    const card = buildProjectListCard(projects(39), new Map(), 1);
    const cbs = callbacks(card).filter((c) => c.a === DM.projects);
    expect(cbs.map((c) => c.p).sort()).toEqual([0, 2]);
    expect(JSON.stringify(card)).toContain('第 2/5 页');
  });

  it('clamps an out-of-range page to the last page (stale click / shrunk list)', () => {
    const all = projects(39);
    const card = buildProjectListCard(all, new Map(), 99);
    expect(namesOn(card, all)).toEqual(all.slice(32).map((p) => p.name)); // last 7 (page 5 of 5)
    const json = JSON.stringify(card);
    expect(json).toContain('第 5/5 页');
    expect(json).toContain('上一页');
    expect(json).not.toContain('下一页');
  });

  it('a single-page list shows no pager and a plain count', () => {
    const card = buildProjectListCard(projects(5), new Map(), 0);
    const json = JSON.stringify(card);
    expect(json).not.toContain('上一页');
    expect(json).not.toContain('下一页');
    expect(json).not.toContain('页');
    expect(json).toContain('共 5 个项目');
  });
});
