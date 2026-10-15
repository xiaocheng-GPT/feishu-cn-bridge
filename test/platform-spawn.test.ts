import { describe, expect, it } from 'vitest';
import { mergeProcessEnv } from '../src/platform/spawn';

describe('mergeProcessEnv', () => {
  it('overrides an existing key by value', () => {
    const out = mergeProcessEnv({ FOO: 'a', BAR: 'b' }, { FOO: 'z' });
    expect(out).toEqual({ FOO: 'z', BAR: 'b' });
  });

  it('dedupes case-insensitively so Windows PATH/Path never doubles up', () => {
    // On Windows env keys are case-insensitive: `Path` and `PATH` are one var.
    const out = mergeProcessEnv({ Path: 'C:\\old' }, { PATH: 'C:\\new' });
    const keys = Object.keys(out).filter((k) => k.toLowerCase() === 'path');
    expect(keys).toHaveLength(1);
    expect(out[keys[0]!]).toBe('C:\\new');
  });

  it('drops overrides whose value is undefined (does not inject empty keys)', () => {
    const out = mergeProcessEnv({ FOO: 'a' }, { BAR: undefined });
    expect(out).toEqual({ FOO: 'a' });
    expect('BAR' in out).toBe(false);
  });

  it('keeps base entries untouched when no overrides are given', () => {
    const base = { FOO: 'a', BAR: 'b' };
    expect(mergeProcessEnv(base)).toEqual(base);
  });
});
