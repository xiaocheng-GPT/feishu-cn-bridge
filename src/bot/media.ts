import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { paths } from '../config/paths';
import { log } from '../core/logger';

/**
 * Inbound image handling: download the images a user sends to (or forwards to)
 * the bot so they can be shown to the agent — codex reads the local file directly
 * as a `localImage` input; the claude backend base64-encodes it into an image
 * content block (both consume {@link AgentInput.images} / see `toUserMessage`).
 *
 * The SDK normalizer already surfaces a message's images two ways:
 *   - `msg.resources` (type 'image') — for plain image messages AND rich-text
 *     (post) images. `fileKey` is the Feishu `image_key`, in the bot's chat.
 *   - merge_forward (合并转发) content embeds `![image](key)` per sub-message but
 *     leaves `msg.resources` EMPTY (convertMergeForward returns no resources),
 *     so forwarded images must be recovered by walking the sub-messages.
 *
 * User-sent images can ONLY be downloaded via `im.v1.messageResource.get`
 * (message-resource/get); the standalone `im.v1.image.get` (what the SDK's
 * `channel.downloadResource` uses) is limited to images the BOT itself
 * uploaded. Per Feishu, message-resource/get needs the bot to share the
 * resource's chat and "暂不支持获取合并转发消息中的子消息的资源文件" — so forwarded
 * sub-message images are attempted best-effort and skipped (logged, not
 * thrown) when Feishu rejects them.
 */

/** Cap per message so a flood of images can't wedge a turn or fill the disk. */
const MAX_IMAGES = 9;
/** Downloaded files live this long; codex reads them within the turn (seconds),
 * so an hour is generous. Pruned lazily on the next download. */
const MEDIA_TTL_MS = 60 * 60_000;

interface ImageRef {
  /** the message that DIRECTLY holds the resource — `msg.messageId` for a plain
   * image, the sub-message id for a forwarded one. */
  messageId: string;
  /** Feishu image_key (img_v3_…). */
  fileKey: string;
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/tiff': 'tiff',
};

/** Cheap synchronous check: does this message carry images worth downloading?
 * Lets the hot path skip the async resource walk entirely. */
export function messageHasImages(msg: NormalizedMessage): boolean {
  if ((msg.resources ?? []).some((r) => r.type === 'image')) return true;
  // merge_forward never lists resources; its sub-messages may still hold images.
  return msg.rawContentType === 'merge_forward';
}

/**
 * Download every image in `msg` to local files and return their absolute paths
 * (codex reads them directly). Best-effort end to end: a failed gather or a
 * single failed download is logged and skipped, never thrown — a missing image
 * must not break the turn.
 */
export async function collectInboundImages(channel: LarkChannel, msg: NormalizedMessage): Promise<string[]> {
  let refs: ImageRef[];
  try {
    refs = await gatherRefs(channel, msg);
  } catch (err) {
    log.warn('intake', 'image-gather-failed', { err: String(err) });
    return [];
  }
  if (refs.length === 0) return [];

  await pruneOldMedia(paths.mediaDir);
  try {
    await mkdir(paths.mediaDir, { recursive: true });
  } catch {
    /* mkdir failure surfaces on writeFile below */
  }

  const out: string[] = [];
  let index = 0;
  for (const ref of refs.slice(0, MAX_IMAGES)) {
    const path = await downloadOne(channel, ref, index++);
    if (path) out.push(path);
  }
  log.info('intake', 'images', { found: refs.length, downloaded: out.length });
  return out;
}

/** Collect (messageId, fileKey) pairs for every image: direct resources first,
 * then any inside a forwarded message. Deduped by fileKey. */
async function gatherRefs(channel: LarkChannel, msg: NormalizedMessage): Promise<ImageRef[]> {
  const refs: ImageRef[] = [];
  const seen = new Set<string>();
  const add = (messageId: string, fileKey: string | undefined): void => {
    if (!fileKey || seen.has(fileKey)) return;
    seen.add(fileKey);
    refs.push({ messageId, fileKey });
  };

  for (const r of msg.resources ?? []) {
    if (r.type === 'image') add(msg.messageId, r.fileKey);
  }

  if (msg.rawContentType === 'merge_forward') {
    // `im.v1.message.get` on a merge_forward returns a FLAT list: the parent
    // first, then every descendant (the same shape the SDK's converter walks).
    const items = await fetchSubMessages(channel, msg.messageId);
    for (const sub of items) {
      if (!sub.message_id || sub.message_id === msg.messageId) continue;
      for (const key of imageKeysFromContent(sub.msg_type, sub.body?.content)) {
        add(sub.message_id, key);
      }
    }
  }

  return refs;
}

interface SubMessageItem {
  message_id?: string;
  msg_type?: string;
  body?: { content?: string };
}

async function fetchSubMessages(channel: LarkChannel, messageId: string): Promise<SubMessageItem[]> {
  try {
    const res = await channel.rawClient.im.v1.message.get({ path: { message_id: messageId } });
    return (res.data as { items?: SubMessageItem[] } | undefined)?.items ?? [];
  } catch (err) {
    log.warn('intake', 'submessages-failed', { messageId, err: String(err) });
    return [];
  }
}

/** Pull image_keys out of one sub-message's raw body content. Plain `image`
 * carries `image_key` at the top; `post` (rich text) nests `{tag:'img'}` nodes.
 * A generic walk covers both plus any other img-bearing shape. Exported for
 * testing — the forwarded-message parsing is the bug-prone part. */
export function imageKeysFromContent(msgType: string | undefined, content: string | undefined): string[] {
  if (!content) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (msgType === 'image') {
    const key = (parsed as { image_key?: string } | null)?.image_key;
    return key ? [key] : [];
  }
  const keys: string[] = [];
  walkForImageKeys(parsed, keys);
  return keys;
}

function walkForImageKeys(node: unknown, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkForImageKeys(child, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.tag === 'img' && typeof obj.image_key === 'string') out.push(obj.image_key);
  for (const k of Object.keys(obj)) walkForImageKeys(obj[k], out);
}

async function downloadOne(channel: LarkChannel, ref: ImageRef, index: number): Promise<string | undefined> {
  try {
    const res = await channel.rawClient.im.v1.messageResource.get({
      path: { message_id: ref.messageId, file_key: ref.fileKey },
      params: { type: 'image' },
    });
    const ext = extFromHeaders(res.headers);
    const file = join(paths.mediaDir, `${safeName(ref.fileKey)}-${index}.${ext}`);
    await res.writeFile(file);
    return file;
  } catch (err) {
    // Forwarded sub-message images land here (Feishu rejects message-resource
    // for merge_forward children) — info, not error: the turn still proceeds.
    log.warn('intake', 'image-download-failed', { fileKey: ref.fileKey.slice(0, 24), err: String(err) });
    return undefined;
  }
}

function extFromHeaders(headers: unknown): string {
  const ct = readHeader(headers, 'content-type');
  if (ct) {
    const base = ct.split(';')[0]?.trim().toLowerCase();
    if (base && EXT_BY_CONTENT_TYPE[base]) return EXT_BY_CONTENT_TYPE[base];
  }
  return 'png';
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const h = headers as { get?: (n: string) => unknown } & Record<string, unknown>;
  const raw = typeof h.get === 'function' ? h.get(name) : (h[name] ?? h[name.toLowerCase()]);
  return typeof raw === 'string' ? raw : Array.isArray(raw) ? String(raw[0]) : undefined;
}

/** Feishu image_keys are filename-safe already; sanitize defensively + clamp. */
function safeName(fileKey: string): string {
  return fileKey.replace(/[^a-zA-Z0-9_-]/g, '').slice(-40) || 'img';
}

async function pruneOldMedia(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // dir not created yet — nothing to prune
  }
  const cutoff = Date.now() - MEDIA_TTL_MS;
  for (const name of entries) {
    const file = join(dir, name);
    try {
      const st = await stat(file);
      if (st.mtimeMs < cutoff) await rm(file, { force: true });
    } catch {
      /* skip files that vanish or can't be stat'd */
    }
  }
}

/**
 * Inbound FILE attachments (logs, PDFs, code, …) — distinct from images.
 *
 * codex's input only carries `text` + `localImage` (no native file/document
 * input — see toUserInput / ContentItem), so a user-sent file can't be "shown"
 * to codex the way an image can. Instead we download it to a local path and
 * fold that path into the prompt text ({@link weaveFileManifest}); codex then
 * opens it with its shell / read tools.
 *
 * Files land in {@link paths.inboundDir} (a global temp dir, TTL-pruned). That
 * dir is OUTSIDE any project cwd, so codex can read these files ONLY under the
 * 'full' tier — qa/write sandboxes confine reads to cwd. That's an accepted
 * limitation: file intake targets the full-access bots (the common case).
 *
 * Scope: DIRECT uploads only. Feishu does not serve merge_forward sub-message
 * resources ("暂不支持获取合并转发消息中的子消息的资源文件"), so a forwarded file is
 * never downloadable — we don't even attempt it (unlike images, which try
 * best-effort), keeping the forwarded transcript untouched.
 */

/** Cap per message so a flood of files can't wedge a turn or fill the disk. */
const MAX_FILES = 9;
/** Skip files larger than this — codex reads them within the turn; a giant
 * upload just stalls the download and fills the disk. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** A downloaded inbound file: absolute local path + the original name the user
 * sent (shown in the prompt manifest so codex can refer to it naturally). */
export interface InboundFile {
  path: string;
  name: string;
}

interface FileRef {
  messageId: string;
  fileKey: string;
  fileName?: string;
}

/** Cheap synchronous check: does this message carry a downloadable file
 * attachment? Mirrors {@link messageHasImages}; merge_forward is excluded — its
 * sub-message files are never servable by Feishu (see module note). */
export function messageHasFiles(msg: NormalizedMessage): boolean {
  return (msg.resources ?? []).some((r) => r.type === 'file');
}

/**
 * Download every file attachment in `msg` to {@link paths.inboundDir} and
 * return their local paths + original names. Best-effort end to end: a failed
 * download is logged and skipped, never thrown — a missing file must not break
 * the turn.
 */
export async function collectInboundFiles(channel: LarkChannel, msg: NormalizedMessage): Promise<InboundFile[]> {
  const refs: FileRef[] = [];
  const seen = new Set<string>();
  for (const r of msg.resources ?? []) {
    if (r.type === 'file' && r.fileKey && !seen.has(r.fileKey)) {
      seen.add(r.fileKey);
      refs.push({ messageId: msg.messageId, fileKey: r.fileKey, fileName: r.fileName });
    }
  }
  if (refs.length === 0) return [];

  await pruneOldMedia(paths.inboundDir);
  try {
    await mkdir(paths.inboundDir, { recursive: true });
  } catch {
    /* mkdir failure surfaces on writeFile below */
  }

  const out: InboundFile[] = [];
  for (const ref of refs.slice(0, MAX_FILES)) {
    const f = await downloadOneFile(channel, ref);
    if (f) out.push(f);
  }
  log.info('intake', 'files', { found: refs.length, downloaded: out.length });
  return out;
}

async function downloadOneFile(channel: LarkChannel, ref: FileRef): Promise<InboundFile | undefined> {
  try {
    const res = await channel.rawClient.im.v1.messageResource.get({
      path: { message_id: ref.messageId, file_key: ref.fileKey },
      params: { type: 'file' },
    });
    const declared = Number(readHeader(res.headers, 'content-length'));
    if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
      log.warn('intake', 'file-too-large', { fileKey: ref.fileKey.slice(0, 24), bytes: declared });
      return undefined;
    }
    const name = cleanFileName(ref.fileName) || 'attachment';
    // file_key is globally unique per resource — prefix the (sanitized, ≤40-char)
    // key so two uploads sharing a name never clash in the shared inboundDir.
    const onDisk = `${safeName(ref.fileKey)}-${name}`;
    const file = join(paths.inboundDir, onDisk);
    await res.writeFile(file);
    // Backstop the cap when content-length was absent: stat + drop if oversized.
    try {
      const st = await stat(file);
      if (st.size > MAX_FILE_BYTES) {
        await rm(file, { force: true });
        log.warn('intake', 'file-too-large', { fileKey: ref.fileKey.slice(0, 24), bytes: st.size });
        return undefined;
      }
    } catch {
      /* stat failed — keep the file rather than lose it */
    }
    // Display name is the SANITIZED `name` (not raw fileName): it is woven into
    // the prompt verbatim, so a newline / control char in an uploader-controlled
    // fileName would otherwise inject fake manifest lines (cleanFileName collapses
    // those). Disk path stays inside inboundDir regardless.
    return { path: file, name };
  } catch (err) {
    log.warn('intake', 'file-download-failed', { fileKey: ref.fileKey.slice(0, 24), err: String(err) });
    return undefined;
  }
}

/** Sanitize a user filename into something safe to write AND to weave into the
 * prompt: drop any path segment, replace path-breaking / control chars, collapse
 * whitespace (so an embedded newline can't inject a fake manifest line), clamp
 * length. Keeps the extension so codex/tools recognize the type. '' if unusable
 * (caller falls back to a generic name). Exported for testing — it is the
 * single sanitization boundary for uploader-controlled filenames. */
export function cleanFileName(name: string | undefined): string {
  if (!name) return '';
  const base = name.split(/[/\\]/).pop() ?? name; // strip any directory part
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return cleaned === '.' || cleaned === '..' ? '' : cleaned;
}

/** Strip the SDK's `<file .../>` placeholder tokens from message text. codex
 * can't act on a Feishu file_key — we replace these with a path-bearing
 * manifest ({@link weaveFileManifest}). `[^<]*` (greedy) spans the whole tag up
 * to its closing `/>`, so an unescaped `>` OR `/>` inside a filename can't
 * truncate it (escapeAttr only escapes `"`); only a literal `<` in a filename —
 * which would already make the SDK content ambiguous — is not handled. */
export function stripFileTokens(text: string): string {
  return text
    .replace(/<file\b[^<]*\/>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/**
 * Fold downloaded attachments into the user's prompt: strip the raw `<file/>`
 * placeholders, then append a manifest mapping each original filename to its
 * absolute local path so codex can open it with its shell / read tools. When
 * nothing downloaded, just return the stripped text (never a bogus path).
 */
export function weaveFileManifest(text: string, files: InboundFile[]): string {
  const stripped = stripFileTokens(text);
  if (files.length === 0) return stripped;
  const lines = files.map((f) => `- ${f.name} → ${f.path}`).join('\n');
  const head = stripped ? `${stripped}\n\n` : '';
  return `${head}[用户上传了 ${files.length} 个附件，已保存到本地，可用 shell / 读取工具按下面的绝对路径直接打开：\n${lines}\n]`;
}
