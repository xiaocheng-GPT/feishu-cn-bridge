import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommentEvent, LarkChannel } from '@larksuiteoapi/node-sdk';
import {
  buildCommentPrompt,
  commentCwd,
  commentSessionKey,
  DEFAULT_COMMENT_INSTRUCTIONS,
  fetchCommentContext,
  loadCommentInstructions,
  postCommentReply,
  renderCommentInstructions,
  resolveComment,
  stripMarkdown,
  SUPPORTED_FILE_TYPES,
  syncCommentInstructions,
  type ResolvedTarget,
} from '../src/bot/comments';
import { finalMessageText, initialState, reduce } from '../src/card/run-state';
import type { AgentEvent } from '../src/agent/types';

/** An API error in the shape thrown by the lark rawClient (axios-style). */
function apiError(code: number): Error {
  return Object.assign(new Error(`feishu ${code}`), { response: { data: { code } } });
}

function evt(overrides: Partial<CommentEvent> = {}): CommentEvent {
  return {
    fileToken: 'doccnAAA',
    fileType: 'docx',
    commentId: 'cmt1',
    operator: { openId: 'ou_user' },
    mentionedBot: true,
    timestamp: 0,
    ...overrides,
  } as CommentEvent;
}

const docxTarget: ResolvedTarget = { fileToken: 'doccnAAA', fileType: 'docx' };

describe('stripMarkdown', () => {
  it('removes bold/italic/heading/inline-code/bullet/quote markers', () => {
    expect(stripMarkdown('**bold**')).toBe('bold');
    expect(stripMarkdown('__bold__')).toBe('bold');
    expect(stripMarkdown('# Heading')).toBe('Heading');
    expect(stripMarkdown('`code`')).toBe('code');
    expect(stripMarkdown('- item')).toBe('item');
    expect(stripMarkdown('> quote')).toBe('quote');
  });

  it('strips fenced code-block markers but keeps the body', () => {
    expect(stripMarkdown('```js\nfoo()\n```')).toBe('foo()\n');
  });

  it('leaves plain text untouched', () => {
    expect(stripMarkdown('multi-agent 不是最优解。')).toBe('multi-agent 不是最优解。');
  });

  it('still strips real *italic* / _italic_ that hug their content', () => {
    expect(stripMarkdown('this *word* here')).toBe('this word here');
    expect(stripMarkdown('this _word_ here')).toBe('this word here');
  });

  it('leaves a lone asterisk/underscore used as an operator alone', () => {
    expect(stripMarkdown('a * b and c * d')).toBe('a * b and c * d');
    expect(stripMarkdown('time _ space')).toBe('time _ space');
    expect(stripMarkdown('snake_case_var')).toBe('snake_case_var');
  });
});

describe('finalMessageText (run-state)', () => {
  const fold = (events: AgentEvent[]) => {
    let s = initialState;
    for (const e of events) s = reduce(s, e);
    return s;
  };

  it('returns the LAST non-empty agent message, not all of them concatenated', () => {
    // codex emits preamble/progress messages then the answer; we want only the answer.
    const s = fold([
      { type: 'thinking', itemId: 'r', text: 'pondering' },
      { type: 'text', itemId: 'a', text: '我先查一下版本' }, // preamble message
      { type: 'tool_use', itemId: 't', title: 'ls' },
      { type: 'text', itemId: 'b', text: '最新 Current 是 26.2.0' }, // final answer
      { type: 'done', turnId: 'x' },
    ]);
    expect(finalMessageText(s)).toBe('最新 Current 是 26.2.0');
  });

  it('returns empty string when the turn produced no text (reasoning/tools only)', () => {
    const s = fold([
      { type: 'thinking', itemId: 'r', text: 'pondering' },
      { type: 'tool_use', itemId: 't', title: 'ls' },
    ]);
    expect(finalMessageText(s)).toBe('');
  });
});

describe('buildCommentPrompt (facts only — behavioral instructions live in AGENTS.md/CLAUDE.md)', () => {
  it('includes the question/token/scope/url', () => {
    const p = buildCommentPrompt(docxTarget, { question: '这样对吗?', isWhole: true }, 'feishu');
    expect(p).toContain('这样对吗?');
    expect(p).toContain('doccnAAA');
    expect(p).toContain('全文评论');
    expect(p).toContain('https://feishu.cn/docx/doccnAAA');
  });

  it('no longer carries the behavioral instructions (they moved to the synced AGENTS.md/CLAUDE.md)', () => {
    const p = buildCommentPrompt(docxTarget, { question: '这样对吗?', isWhole: true }, 'feishu');
    expect(p).not.toContain('纯文本'); // no-markdown rule now lives in the instructions file
    expect(p).not.toContain('系统会自动'); // ditto for the self-post contract
    expect(p).not.toContain('最终答案');
  });

  it('renders the selected quote for inline comments and uses the lark host', () => {
    const p = buildCommentPrompt(docxTarget, { question: 'q', isWhole: false, quote: 'line one\nline two' }, 'lark');
    expect(p).toContain('行内评论');
    expect(p).toContain('> line one\n> line two');
    expect(p).toContain('https://larksuite.com/docx/doccnAAA');
  });

  it('maps each file type to its real URL path segment (sheet→/sheets/, doc→/docs/, bitable→/base/)', () => {
    const link = (t: ResolvedTarget): string =>
      buildCommentPrompt(t, { question: 'q', isWhole: true }, 'feishu');
    // bitable: the web URL is /base/<app_token>, NOT /bitable/ (that's only the REST path)
    expect(link({ fileToken: 'bascnX', fileType: 'bitable' })).toContain('https://feishu.cn/base/bascnX');
    expect(link({ fileToken: 'bascnX', fileType: 'bitable' })).not.toContain('/bitable/');
    expect(link({ fileToken: 'shtX', fileType: 'sheet' })).toContain('https://feishu.cn/sheets/shtX');
    expect(link({ fileToken: 'docX', fileType: 'doc' })).toContain('https://feishu.cn/docs/docX');
    // docx matches the type string verbatim — already covered by the test above
  });
});

describe('DEFAULT_COMMENT_INSTRUCTIONS (the seeded AGENTS.md/CLAUDE.md content)', () => {
  it('carries the machine contract + read/edit + anchor-preservation guidance', () => {
    expect(DEFAULT_COMMENT_INSTRUCTIONS).toContain('系统会自动'); // the bridge posts the reply, not the agent
    expect(DEFAULT_COMMENT_INSTRUCTIONS).toContain('纯文本'); // no-markdown output rule
    expect(DEFAULT_COMMENT_INSTRUCTIONS).toContain('lark-cli'); // read/edit the doc via lark-cli
    expect(DEFAULT_COMMENT_INSTRUCTIONS).toContain('原文已被删除'); // anchor-preservation rule: don't delete the commented text
    expect(DEFAULT_COMMENT_INSTRUCTIONS).toContain('解决 / 删除'); // don't self-resolve/delete comments
  });

  it('uses the doc-level variables so each synced copy is doc-specific', () => {
    expect(DEFAULT_COMMENT_INSTRUCTIONS).toContain('{fileToken}'); // the read/edit line uses the token var
    expect(DEFAULT_COMMENT_INSTRUCTIONS).toContain('{fileType}');
    expect(DEFAULT_COMMENT_INSTRUCTIONS).toContain('{docUrl}');
    expect(DEFAULT_COMMENT_INSTRUCTIONS).not.toContain('<file_token>'); // no prose placeholder
  });

  it('stays within the in-card editor cap (1000 chars) so it can be edited in the card', () => {
    expect(DEFAULT_COMMENT_INSTRUCTIONS.length).toBeLessThanOrEqual(1000);
  });

  it('substitutes its variables to the real doc values when synced', () => {
    const rendered = renderCommentInstructions(DEFAULT_COMMENT_INSTRUCTIONS, 'feishu', 'docx', 'doccnAAA');
    expect(rendered).not.toContain('{fileToken}'); // all placeholders resolved
    expect(rendered).not.toContain('{docUrl}');
    expect(rendered).toContain('doccnAAA'); // the real token
    expect(rendered).toContain('https://feishu.cn/docx/doccnAAA'); // the real link
  });

  it('substitutes a 多维表格 (bitable) link at /base/', () => {
    const rendered = renderCommentInstructions(DEFAULT_COMMENT_INSTRUCTIONS, 'feishu', 'bitable', 'bascnX');
    expect(rendered).toContain('https://feishu.cn/base/bascnX');
    expect(rendered).not.toContain('/bitable/');
  });
});

describe('commentSessionKey (one session per comment THREAD)', () => {
  it('keys by doc:<fileToken>:<commentId>', () => {
    expect(commentSessionKey('doccnAAA', 'cmt1')).toBe('doc:doccnAAA:cmt1');
  });

  it('gives distinct keys to distinct threads on the same doc', () => {
    expect(commentSessionKey('doccnAAA', 'cmt1')).not.toBe(commentSessionKey('doccnAAA', 'cmt2'));
  });
});

describe('commentCwd (one working dir per document)', () => {
  it('joins projectsRoot with comment-<fileType>-<fileToken>', () => {
    expect(commentCwd('/root', 'docx', 'doccnAAA')).toBe(join('/root', 'comment-docx-doccnAAA'));
  });

  it('is shared by all comment threads on the same doc (no commentId in the path)', () => {
    expect(commentCwd('/root', 'docx', 'doccnAAA')).toBe(commentCwd('/root', 'docx', 'doccnAAA'));
  });
});

describe('comment instructions file lifecycle', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'comment-instr-'));
    dirs.push(d);
    return d;
  };

  it('seeds the master file with the default when absent, then returns it', async () => {
    const root = tmp();
    const master = join(root, 'comment-instructions.md');
    const loaded = await loadCommentInstructions(master);
    expect(loaded).toBe(DEFAULT_COMMENT_INSTRUCTIONS);
    expect(readFileSync(master, 'utf8')).toBe(DEFAULT_COMMENT_INSTRUCTIONS); // written to disk
  });

  it('returns the user-edited master content on subsequent loads (no clobber)', async () => {
    const root = tmp();
    const master = join(root, 'comment-instructions.md');
    await loadCommentInstructions(master); // seed
    rmSync(master);
    const edited = '# 我的自定义评论助手\n只回三段：风险/待确认人/下一步。';
    const { writeFileSync } = await import('node:fs');
    writeFileSync(master, edited, 'utf8');
    expect(await loadCommentInstructions(master)).toBe(edited);
  });

  it('does NOT overwrite an existing blank/whitespace master file (uses default for the run, leaves file intact)', async () => {
    const root = tmp();
    const master = join(root, 'comment-instructions.md');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(master, '   \n\n', 'utf8'); // user emptied it on purpose
    expect(await loadCommentInstructions(master)).toBe(DEFAULT_COMMENT_INSTRUCTIONS); // run still gets the contract
    expect(readFileSync(master, 'utf8')).toBe('   \n\n'); // but the file on disk is untouched (no silent clobber)
  });

  it('syncs instructions into BOTH AGENTS.md and CLAUDE.md of the cwd', async () => {
    const cwd = join(tmp(), 'comment-docx-doccnAAA');
    const content = '# 助手\n回答要真诚';
    await syncCommentInstructions(cwd, content);
    expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')).toBe(content);
    expect(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8')).toBe(content);
  });
});

describe('SUPPORTED_FILE_TYPES', () => {
  it('covers doc/docx/sheet/bitable and excludes file/slides/mindnote/wiki', () => {
    for (const t of ['doc', 'docx', 'sheet', 'bitable']) expect(SUPPORTED_FILE_TYPES.has(t)).toBe(true);
    for (const t of ['file', 'slides', 'mindnote', 'wiki']) expect(SUPPORTED_FILE_TYPES.has(t)).toBe(false);
  });
});

describe('resolveComment', () => {
  // get returns a reply ONLY for the given file_token; list is always empty.
  function channelFor(replyTokens: Record<string, string>, getNode = vi.fn()) {
    const get = vi.fn((payload?: { path?: { file_token?: string } }) => {
      const token = payload?.path?.file_token ?? '';
      const text = replyTokens[token];
      if (text === undefined) return Promise.resolve({ data: { reply_list: { replies: [] } } });
      return Promise.resolve({
        data: { reply_list: { replies: [{ reply_id: 'r1', content: { elements: [{ type: 'text_run', text_run: { text } }] } }] } },
      });
    });
    const list = vi.fn(() => Promise.resolve({ data: { items: [] } }));
    const channel = {
      rawClient: {
        drive: { v1: { fileComment: { get, list } } },
        wiki: { v2: { space: { getNode } } },
      },
    } as unknown as LarkChannel;
    return { channel, getNode };
  }

  it('uses the event token directly and never calls wiki getNode for a normal doc', async () => {
    const { channel, getNode } = channelFor({ doccnAAA: '直接命中的答案' });
    const r = await resolveComment(channel, evt({ fileToken: 'doccnAAA', fileType: 'docx' }));
    expect(r?.target).toEqual({ fileToken: 'doccnAAA', fileType: 'docx' });
    expect(r?.ctx.question).toBe('直接命中的答案');
    expect(getNode).not.toHaveBeenCalled(); // no wiki scope needed for regular docs
  });

  it('falls back to wiki node resolution when the direct token has no comment', async () => {
    const getNode = vi.fn().mockResolvedValue({ data: { node: { obj_token: 'realdocx', obj_type: 'docx' } } });
    // direct token 'wikiNode' yields nothing; the resolved 'realdocx' has the reply.
    const { channel } = channelFor({ realdocx: 'wiki 文档里的答案' }, getNode);
    const r = await resolveComment(channel, evt({ fileToken: 'wikiNode', fileType: 'docx' }));
    expect(getNode).toHaveBeenCalledWith({ params: { token: 'wikiNode' } });
    expect(r?.target).toEqual({ fileToken: 'realdocx', fileType: 'docx' });
    expect(r?.ctx.question).toBe('wiki 文档里的答案');
  });

  it('returns null for unsupported file types without calling any API', async () => {
    const { channel, getNode } = channelFor({});
    const get = channel.rawClient.drive.v1.fileComment.get as ReturnType<typeof vi.fn>;
    expect(await resolveComment(channel, evt({ fileType: 'mindnote' }))).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(getNode).not.toHaveBeenCalled();
  });

  it('returns null when neither the direct token nor a wiki node yields a comment', async () => {
    const getNode = vi.fn().mockRejectedValue(apiError(404)); // not a wiki node
    const { channel } = channelFor({}, getNode);
    expect(await resolveComment(channel, evt({ fileToken: 'doccnAAA', fileType: 'docx' }))).toBeNull();
  });
});

describe('fetchCommentContext', () => {
  function channelWith(getImpl: () => unknown, listImpl?: () => unknown): LarkChannel {
    return {
      rawClient: {
        drive: {
          v1: {
            fileComment: {
              get: vi.fn(getImpl as () => Promise<unknown>),
              list: vi.fn((listImpl ?? (() => Promise.resolve({ data: { items: [] } }))) as () => Promise<unknown>),
            },
          },
        },
      },
    } as unknown as LarkChannel;
  }

  const replies = [
    { reply_id: 'r1', content: { elements: [{ type: 'text_run', text_run: { text: 'first' } }] } },
    { reply_id: 'r2', content: { elements: [{ type: 'text_run', text_run: { text: '@bot 第二条' } }] } },
  ];

  it('picks the reply matching evt.replyId', async () => {
    const channel = channelWith(() =>
      Promise.resolve({ data: { reply_list: { replies }, quote: 'sel', is_whole: false } }),
    );
    const ctx = await fetchCommentContext(channel, docxTarget, evt({ replyId: 'r2' }));
    expect(ctx.question).toBe('@bot 第二条');
    expect(ctx.targetReplyId).toBe('r2');
    expect(ctx.quote).toBe('sel');
    expect(ctx.isWhole).toBe(false);
  });

  it('falls back to the last reply when replyId is absent', async () => {
    const channel = channelWith(() => Promise.resolve({ data: { reply_list: { replies } } }));
    const ctx = await fetchCommentContext(channel, docxTarget, evt());
    expect(ctx.targetReplyId).toBe('r2');
    expect(ctx.question).toBe('@bot 第二条');
  });

  it('falls back to .list when .get throws (e.g. 1069307)', async () => {
    const channel = channelWith(
      () => Promise.reject(apiError(1069307)),
      () =>
        Promise.resolve({
          data: { items: [{ comment_id: 'cmt1', reply_list: { replies }, is_whole: true }], has_more: false },
        }),
    );
    const ctx = await fetchCommentContext(channel, docxTarget, evt());
    expect(ctx.question).toBe('@bot 第二条');
    expect(ctx.isWhole).toBe(true);
  });
});

describe('postCommentReply', () => {
  function channel(replyCreate: () => unknown, commentCreate = vi.fn(() => Promise.resolve({}))) {
    const ch = {
      rawClient: {
        drive: {
          v1: {
            fileCommentReply: { create: vi.fn(replyCreate as () => Promise<unknown>) },
            fileComment: { create: commentCreate },
          },
        },
      },
    } as unknown as LarkChannel;
    return ch;
  }

  it('replies in-thread via fileCommentReply.create', async () => {
    const ch = channel(() => Promise.resolve({}));
    await postCommentReply(ch, docxTarget, evt(), 'answer');
    const reply = ch.rawClient.drive.v1.fileCommentReply.create as ReturnType<typeof vi.fn>;
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0]?.[0]).toMatchObject({
      params: { file_type: 'docx' },
      path: { file_token: 'doccnAAA', comment_id: 'cmt1' },
      data: { content: { elements: [{ type: 'text_run', text_run: { text: 'answer' } }] } },
    });
  });

  it('falls back to a top-level comment on 1069302 (whole-doc, no thread)', async () => {
    const commentCreate = vi.fn((_payload?: unknown) => Promise.resolve({}));
    const ch = channel(() => Promise.reject(apiError(1069302)), commentCreate);
    await postCommentReply(ch, { fileToken: 'doccnAAA', fileType: 'doc' }, evt({ fileType: 'doc' }), 'answer');
    expect(commentCreate).toHaveBeenCalledOnce();
    expect(commentCreate.mock.calls[0]?.[0]).toMatchObject({
      params: { file_type: 'doc' },
      path: { file_token: 'doccnAAA' },
    });
  });

  it('rethrows non-1069302 errors instead of masking them', async () => {
    const ch = channel(() => Promise.reject(apiError(99999)));
    await expect(postCommentReply(ch, docxTarget, evt(), 'x')).rejects.toThrow();
    expect(ch.rawClient.drive.v1.fileComment.create).not.toHaveBeenCalled();
  });
});
