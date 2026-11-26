import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export function distStatus(root) {
  const src = join(root, 'src');
  let newest;
  let newestTime = -Infinity;
  for (const entry of readdirSync(src, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const file = join(entry.parentPath, entry.name);
    const { mtimeMs } = statSync(file);
    if (mtimeMs > newestTime) { newest = relative(root, file); newestTime = mtimeMs; }
  }
  const missing = [], stale = [];
  for (const output of ['dist/server.cjs', 'dist/board.html']) {
    try {
      const info = statSync(join(root, output));
      if (!info.isFile()) missing.push(output);
      else if (info.mtimeMs < newestTime) stale.push(output);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(output);
    }
  }
  return { missing, stale, newest };
}
