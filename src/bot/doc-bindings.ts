import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';

/**
 * 云文档评论 → 项目绑定的持久化注册表：一份 `doc-bindings.json`，把文档
 * （按 file_token 主键）映射到某个项目。绑定后，该文档评论里 @bot 会用项目的
 * cwd / 后端 / 模型 / 沙箱权限运行，而不是独立的 `comments/comment-<type>-<token>`
 * 目录 + 全局评论配置（见 handle-message.ts 的 onComment）。
 *
 * 一个文档同一时刻最多绑定一个项目；重新绑定到另一项目会抛错（用「解绑 → 再绑定」）。
 * 读写模式仿 project/registry.ts：模块级 opChain 串行化读-改-写 + tmp 原子 rename。
 */
export interface DocBinding {
  fileType: string;
  fileToken: string;
  projectName: string;
  boundAt: number;
}

interface StoreFile {
  version: number;
  bindings: DocBinding[];
}

const FILE_VERSION = 1;

let opChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  opChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function read(): Promise<DocBinding[]> {
  try {
    const text = await readFile(paths.docBindingsFile, 'utf8');
    const parsed = JSON.parse(text) as Partial<StoreFile>;
    return Array.isArray(parsed.bindings) ? parsed.bindings : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function write(bindings: DocBinding[]): Promise<void> {
  await mkdir(dirname(paths.docBindingsFile), { recursive: true });
  const tmp = `${paths.docBindingsFile}.tmp-${process.pid}-${randomUUID()}`;
  const body: StoreFile = { version: FILE_VERSION, bindings };
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  await rename(tmp, paths.docBindingsFile);
}

export async function listDocBindings(): Promise<DocBinding[]> {
  return read();
}

export async function getDocBinding(fileToken: string): Promise<DocBinding | undefined> {
  return (await read()).find((b) => b.fileToken === fileToken);
}

/** 绑定文档到项目。同 token 已被别的项目绑定时抛错；重复绑同一项目则刷新绑定时间。 */
export async function bindDoc(fileType: string, fileToken: string, projectName: string): Promise<void> {
  return withLock(async () => {
    const bindings = await read();
    const existing = bindings.find((b) => b.fileToken === fileToken);
    if (existing) {
      if (existing.projectName !== projectName) {
        throw new Error(`该文档已绑定到项目「${existing.projectName}」，请先解绑再绑定「${projectName}」。`);
      }
      existing.fileType = fileType;
      existing.boundAt = Date.now();
    } else {
      bindings.push({ fileType, fileToken, projectName, boundAt: Date.now() });
    }
    await write(bindings);
  });
}

/** 解除绑定。返回是否真有解绑发生（未被绑定过 → false）。 */
export async function unbindDoc(fileToken: string): Promise<boolean> {
  return withLock(async () => {
    const bindings = await read();
    const idx = bindings.findIndex((b) => b.fileToken === fileToken);
    if (idx === -1) return false;
    bindings.splice(idx, 1);
    await write(bindings);
    log.info('comment', 'doc-unbound', { fileToken });
    return true;
  });
}