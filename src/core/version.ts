import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The bridge's own version, read from package.json at runtime. Both bundle
 * entries (dist/cli.js, dist/index.js) sit at dist/ root, so package.json is one
 * level up — same in a local build and the published tarball. Falling back to
 * '0.0.0' keeps callers from crashing if the file is ever missing; a hardcoded
 * literal would silently lie after a release bump.
 */
export function bridgeVersion(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
