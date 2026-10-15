import type { TenantBrand } from '../config/schema';
import { JOIN_GROUP_SCOPES, REQUIRED_SCOPES } from '../config/scopes';

const ENDPOINTS: Record<TenantBrand, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  botName?: string;
  botOpenId?: string;
  /**
   * Required scopes the app hasn't been granted yet (best-effort; undefined if
   * the scope list couldn't be fetched). Empty array = all granted.
   */
  missingScopes?: string[];
  /**
   * Opt-in "加入存量群" scopes ({@link JOIN_GROUP_SCOPES}) not yet granted. Same
   * 3-state semantics as {@link missingScopes} (undefined = couldn't check).
   * These aren't required for core messaging, so they never gate startup — the
   * doctor card surfaces them so existing users can discover + enable them.
   */
  missingJoinScopes?: string[];
}

interface TokenResp {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
}

interface BotInfoResp {
  code?: number;
  bot?: { activate_status?: number; app_name?: string; open_id?: string };
}

/** Validate app credentials by exchanging for a tenant_access_token. */
export async function validateAppCredentials(
  appId: string,
  appSecret: string,
  tenant: TenantBrand,
): Promise<ValidationResult> {
  const base = ENDPOINTS[tenant];
  let resp: Response;
  try {
    resp = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
  } catch (err) {
    return { ok: false, reason: `网络错误：${err instanceof Error ? err.message : String(err)}` };
  }
  if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
  let data: TokenResp;
  try {
    data = (await resp.json()) as TokenResp;
  } catch {
    return { ok: false, reason: '响应不是合法 JSON' };
  }
  if (data.code !== 0 || !data.tenant_access_token) {
    return { ok: false, reason: `code=${data.code ?? '?'} msg=${data.msg ?? '<no msg>'}` };
  }
  const token = data.tenant_access_token;
  const info = await fetchBotInfo(base, token).catch(() => undefined);
  const granted = await fetchGrantedScopes(base, token).catch(() => undefined);
  const missing = (list: readonly string[]): string[] | undefined =>
    granted ? list.filter((s) => !granted.has(s)) : undefined;
  return {
    ok: true,
    botName: info?.bot?.app_name,
    botOpenId: info?.bot?.open_id,
    missingScopes: missing(REQUIRED_SCOPES),
    missingJoinScopes: missing(JOIN_GROUP_SCOPES),
  };
}

async function fetchBotInfo(base: string, token: string): Promise<BotInfoResp | undefined> {
  const resp = await fetch(`${base}/open-apis/bot/v3/info`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return undefined;
  return (await resp.json()) as BotInfoResp;
}

interface ScopeListResp {
  data?: { scopes?: { scope_name: string; grant_status: number }[] };
}

/**
 * The set of scope names the app has actually been granted (`grant_status === 1`).
 * Returns undefined (not an empty set) on any failure so callers can tell "none
 * granted" from "couldn't check" — and compute missing-from-any-list themselves.
 */
async function fetchGrantedScopes(base: string, token: string): Promise<Set<string> | undefined> {
  const resp = await fetch(`${base}/open-apis/application/v6/scopes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return undefined;
  const body = (await resp.json()) as ScopeListResp;
  if (!body.data?.scopes) return undefined;
  return new Set(body.data.scopes.filter((s) => s.grant_status === 1).map((s) => s.scope_name));
}
