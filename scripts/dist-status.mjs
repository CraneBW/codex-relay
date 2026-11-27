import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const outputs = ['dist/server.cjs', 'dist/board.html'];
const manifest = 'dist/build-manifest.json';

export function fingerprint(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function hashes(root, paths) {
  return Object.fromEntries(paths.map(path => [path, fingerprint(join(root, path))]));
}

export function buildInputHashes(root) {
  const sources = readdirSync(join(root, 'src'), { recursive: true, withFileTypes: true })
    .filter(entry => !entry.isDirectory() && entry.name !== '.DS_Store' && !entry.name.startsWith('._'))
    .map(entry => relative(root, join(entry.parentPath, entry.name)))
    .sort();
  return hashes(root, ['package.json', 'package-lock.json', 'scripts/build.mjs', ...sources]);
}

export function writeDistManifest(root, inputs) {
  const files = { ...inputs, ...hashes(root, outputs) };
  writeFileSync(join(root, manifest), JSON.stringify(files, null, 2) + '\n');
}

export function distStatus(root) {
  const isFile = path => statSync(join(root, path), { throwIfNoEntry: false })?.isFile();
  const missing = outputs.filter(path => !isFile(path));
  if (missing.length) return { missing, changed: [] };
  if (!isFile(manifest)) return { missing, changed: [manifest] };

  const recorded = JSON.parse(readFileSync(join(root, manifest), 'utf8'));
  const current = { ...buildInputHashes(root), ...hashes(root, outputs) };
  const paths = new Set([...Object.keys(recorded), ...Object.keys(current)]);
  const changed = [...paths].filter(path => recorded[path] !== current[path]);
  return { missing, changed };
}
