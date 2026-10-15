import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { toUserMessage } from '../src/agent/claude-agent/thread';

/**
 * The inbound-image fix: {@link toUserMessage} must fold the images the bridge
 * downloaded (input.images — the same local paths codex reads as `localImage`)
 * into base64 image content blocks so Claude SEES the pixels. Regression guard for
 * the bug where images were silently dropped (claude群发图看不到, codex群能看到).
 *
 * The type is detected from MAGIC BYTES, not the filename — media.ts derives the
 * on-disk extension from the (possibly absent) HTTP content-type, so the extension
 * can be wrong; trusting it would mislabel the media_type and the API would reject.
 */

// Magic-byte headers (enough for sniffImageType); real content is irrelevant.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // "GIF89a"
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]); // RIFF....WEBP
// Types the Anthropic API can't take as base64 → must be skipped:
const BMP = Buffer.from([0x42, 0x4d, 0x00, 0x00]); // "BM"
const HEIC = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]); // ftypheic
const TIFF = Buffer.from([0x49, 0x49, 0x2a, 0x00]); // "II*\0"

const dirs: string[] = [];
async function writeImage(name: string, bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-img-'));
  dirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Narrow the message content to the array (image) form for assertions. */
function blocks(content: unknown): Array<Record<string, any>> {
  expect(Array.isArray(content)).toBe(true);
  return content as Array<Record<string, any>>;
}

describe('toUserMessage — text-only fast path', () => {
  it('no images → content is a plain string', async () => {
    const m = await toUserMessage({ text: 'hello' });
    expect(m.type).toBe('user');
    expect(m.message.role).toBe('user');
    expect(m.message.content).toBe('hello');
    expect(m.parent_tool_use_id).toBeNull();
  });

  it('empty images array → still a plain string', async () => {
    const m = await toUserMessage({ text: 'hi', images: [] });
    expect(m.message.content).toBe('hi');
  });

  it('missing text → empty string content', async () => {
    const m = await toUserMessage({});
    expect(m.message.content).toBe('');
  });
});

describe('toUserMessage — images become base64 content blocks', () => {
  it('text + one PNG → [text block, base64 image block]', async () => {
    const path = await writeImage('a.png', PNG);
    const m = await toUserMessage({ text: '看这张图', images: [path] });
    const bl = blocks(m.message.content);
    expect(bl).toHaveLength(2);
    expect(bl[0]).toEqual({ type: 'text', text: '看这张图' });
    expect(bl[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') },
    });
  });

  it('image-only message (no text) → just the image block, no empty text block', async () => {
    const path = await writeImage('a.png', PNG);
    const m = await toUserMessage({ images: [path] });
    const bl = blocks(m.message.content);
    expect(bl).toHaveLength(1);
    expect(bl[0]!.type).toBe('image');
  });

  it('detects all four supported types by magic bytes', async () => {
    const cases: Array<[Buffer, string]> = [
      [PNG, 'image/png'],
      [JPG, 'image/jpeg'],
      [GIF, 'image/gif'],
      [WEBP, 'image/webp'],
    ];
    for (const [bytes, mediaType] of cases) {
      const p = await writeImage('x.bin', bytes); // deliberately-wrong extension
      const bl = blocks((await toUserMessage({ images: [p] })).message.content);
      expect(bl[0]!.source.media_type).toBe(mediaType);
    }
  });

  it('type comes from BYTES, not the extension (mislabel-bug guard)', async () => {
    // media.ts can save a JPEG as `x.png` when Feishu omits the content-type.
    const p = await writeImage('mislabeled.png', JPG);
    const bl = blocks((await toUserMessage({ images: [p] })).message.content);
    expect(bl[0]!.source.media_type).toBe('image/jpeg'); // NOT image/png
  });

  it('multiple images → one block each, in order', async () => {
    const p1 = await writeImage('one.png', PNG);
    const p2 = await writeImage('two.jpg', JPG);
    const bl = blocks((await toUserMessage({ text: 't', images: [p1, p2] })).message.content);
    expect(bl.map((b) => b.type)).toEqual(['text', 'image', 'image']);
    expect(bl[1]!.source.media_type).toBe('image/png');
    expect(bl[2]!.source.media_type).toBe('image/jpeg');
  });
});

describe('toUserMessage — best-effort: bad images never break the turn', () => {
  it('API-unsupported types (bmp/heic/tiff) are skipped → falls back to plain text', async () => {
    for (const bytes of [BMP, HEIC, TIFF]) {
      const p = await writeImage('x.png', bytes); // even a .png name can't smuggle it in
      const m = await toUserMessage({ text: 'hi', images: [p] });
      expect(m.message.content).toBe('hi'); // no valid image → plain string, not an array
    }
  });

  it('unreadable path is skipped → falls back to plain text', async () => {
    const m = await toUserMessage({ text: 'hi', images: ['/no/such/file.png'] });
    expect(m.message.content).toBe('hi');
  });

  it('empty (0-byte) file is skipped', async () => {
    const p = await writeImage('empty.png', Buffer.alloc(0));
    const m = await toUserMessage({ text: 'hi', images: [p] });
    expect(m.message.content).toBe('hi');
  });

  it('mix of good + unsupported → only the good image survives (with the text)', async () => {
    const good = await writeImage('ok.png', PNG);
    const bad = await writeImage('bad.heic', HEIC);
    const bl = blocks((await toUserMessage({ text: 'q', images: [bad, good] })).message.content);
    expect(bl.map((b) => b.type)).toEqual(['text', 'image']);
    expect(bl[1]!.source.media_type).toBe('image/png');
  });

  it('image-only message where every image drops → empty-string turn (no bogus array)', async () => {
    const m = await toUserMessage({ images: ['/no/such/file.png'] });
    expect(m.message.content).toBe('');
  });
});
