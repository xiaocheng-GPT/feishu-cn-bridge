import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecentIdCache } from '../src/bot/handle-message';

describe('RecentIdCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flags a re-delivered id as duplicate within the TTL (only processed once)', () => {
    const cache = new RecentIdCache();
    expect(cache.seen('om_1')).toBe(false); // first delivery → process
    expect(cache.seen('om_1')).toBe(true); // WS-reconnect re-push → drop
    expect(cache.seen('om_1')).toBe(true);
    expect(cache.seen('om_2')).toBe(false); // distinct id unaffected
  });

  it('lets the same id through again after the TTL expires', () => {
    vi.useFakeTimers();
    const cache = new RecentIdCache(2048, 10 * 60_000);
    expect(cache.seen('om_1')).toBe(false);
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(cache.seen('om_1')).toBe(true); // still inside TTL
    vi.advanceTimersByTime(10 * 60_000);
    expect(cache.seen('om_1')).toBe(false); // expired → treated as fresh
    expect(cache.seen('om_1')).toBe(true); // …and re-recorded
  });

  it('evicts the oldest entry beyond maxEntries (LRU by insertion order)', () => {
    const cache = new RecentIdCache(2, 10 * 60_000);
    expect(cache.seen('a')).toBe(false);
    expect(cache.seen('b')).toBe(false);
    expect(cache.seen('c')).toBe(false); // evicts 'a'
    expect(cache.seen('a')).toBe(false); // 'a' was evicted → fresh again
    expect(cache.seen('c')).toBe(true); // 'c' survived
  });
});
