import { describe, expect, it } from 'vitest';
import { getCommentsConfig, type AppConfig } from '../src/config/schema';

function cfg(preferences: AppConfig['preferences'] = {}): AppConfig {
  return {
    accounts: { app: { id: 'cli_app', secret: 'secret', tenant: 'feishu' } },
    preferences,
  };
}

describe('getCommentsConfig', () => {
  it('returns an empty object when comments is omitted (consumers apply their own fallbacks)', () => {
    expect(getCommentsConfig(cfg())).toEqual({});
  });

  it('returns an empty object when preferences itself is absent', () => {
    expect(getCommentsConfig({ accounts: { app: { id: 'x', secret: 's', tenant: 'feishu' } } })).toEqual({});
  });

  it('passes through the configured backend/model/effort verbatim', () => {
    const c = getCommentsConfig(cfg({ comments: { backend: 'claude-agent', model: 'claude-opus-4-8', effort: 'high' } }));
    expect(c.backend).toBe('claude-agent');
    expect(c.model).toBe('claude-opus-4-8');
    expect(c.effort).toBe('high');
  });

  it('allows a partial config (only one field set)', () => {
    expect(getCommentsConfig(cfg({ comments: { effort: 'low' } }))).toEqual({ effort: 'low' });
  });
});
