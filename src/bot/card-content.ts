import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

/**
 * Recover the real text of an `interactive` (card 2.0) message that Feishu
 * delivers to bots only as a downgraded placeholder.
 *
 * Why this exists: when a card 2.0 / CardKit interactive card is *received* by a
 * bot (e.g. a 多维表格「发送消息卡片」自动化, or any app-sent card), the push
 * event — and the default `im.v1.message.get` body — carry a degraded legacy
 * representation: `{"title":"…","elements":[[{"tag":"text","text":"请升级至最新
 * 版本客户端，以查看内容"}]]}`. The actual body (markdown, links, the Base record
 * URL) is NOT in it, so the SDK's converter walks it to nothing and yields the
 * `[interactive card]` fallback — codex then sees no usable content.
 *
 * The full card is only returned when the message is fetched with
 * `card_msg_content_type=raw_card_content`, which gives a `json_card` in the
 * property-wrapped card-builder schema (distinct from the send-format schema the
 * SDK's walkCard handles). We re-fetch that here and extract its text + links so
 * codex reads「请处理这条记录 [查看…](base链接)」and can follow the link.
 */

/** True when the normalized card content is a downgraded placeholder (no real
 * body), so a `raw_card_content` re-fetch is worth it. Covers the SDK's
 * `[interactive card]` fallback and the literal「请升级…」client placeholder. */
export function isDegradedCardContent(content: string): boolean {
  const t = content.trim();
  if (t === '' || t === '[interactive card]') return true;
  return /请升级至最新版本客户端|请使用新版本.*查看|client to view|upgrade .*client/i.test(t);
}

/** Unwrap the `card_msg_content_type=raw_card_content` body: the API returns
 * `{"json_card":"<stringified card>","json_attachment":{…}}`. Returns the parsed
 * `json_card` object, the parsed body itself if it isn't wrapped, or undefined on
 * malformed JSON. */
export function parseRawCardWrapper(bodyContent: string): unknown {
  try {
    const parsed = JSON.parse(bodyContent) as Record<string, unknown>;
    if (typeof parsed.json_card === 'string') return JSON.parse(parsed.json_card);
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Extract readable text + links from the `raw_card_content` (json_card) schema —
 * the property-wrapped card-builder format where text lives in
 * `property.content`, links pair it with `property.url.url`, and structure nests
 * under `property.elements / columns / actions / title / text`. A multilingual
 * footer (`property.i18nElements`) is rendered in one locale only (zh_cn first)
 * to avoid 5× duplication. Output lines are de-duplicated, order preserved.
 */
export function extractRawCardText(jsonCard: unknown): string {
  const out: string[] = [];
  visit(jsonCard, out);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const piece of out) {
    const key = piece.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    lines.push(key);
  }
  return lines.join('\n');
}

function visit(node: unknown, out: string[]): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const child of node) visit(child, out);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  // Top-level containers (header first so the card title leads the body).
  if (obj.header) visit(obj.header, out);
  if (obj.body) visit(obj.body, out);

  const prop = obj.property as Record<string, unknown> | undefined;
  if (!prop) return;

  // Leaf text: plain_text / link / markdown-leaf. A link pairs content with a URL.
  if (typeof prop.content === 'string' && prop.content.trim()) {
    const url = (prop.url as { url?: string } | undefined)?.url;
    out.push(url ? `[${prop.content.trim()}](${url})` : prop.content);
  }

  // Multilingual footer — keep one locale (else the「来自 …」line repeats ×5).
  const i18n = prop.i18nElements as Record<string, unknown> | undefined;
  if (i18n && typeof i18n === 'object') {
    visit(i18n.zh_cn ?? i18n.zh_hk ?? i18n.zh_tw ?? i18n.en_us ?? Object.values(i18n)[0], out);
  }

  // Nested structure: titles, button labels, rows/columns, action groups.
  visit(prop.title, out);
  visit(prop.text, out);
  visit(prop.elements, out);
  visit(prop.columns, out);
  visit(prop.actions, out);
}

/**
 * Re-fetch a received interactive card with `card_msg_content_type=raw_card_content`
 * and return its extracted text, or undefined if the fetch fails / yields nothing
 * (caller keeps the degraded content). Best-effort: needs the `im:message` read
 * scope the bot already uses to receive messages.
 */
export async function fetchInteractiveCardText(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  let body: string | undefined;
  try {
    const res = await channel.rawClient.im.v1.message.get({
      path: { message_id: messageId },
      params: { card_msg_content_type: 'raw_card_content' },
    });
    body = (res.data as { items?: { body?: { content?: string } }[] } | undefined)?.items?.[0]?.body?.content;
  } catch (err) {
    log.warn('intake', 'card-content-fetch-failed', { messageId, err: String(err) });
    return undefined;
  }
  if (!body) return undefined;
  const card = parseRawCardWrapper(body);
  if (card == null) return undefined;
  const text = extractRawCardText(card);
  return text.trim() ? text : undefined;
}
