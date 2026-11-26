import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { socketDir } from './paths.mjs';

export const contextKey = join(socketDir, 'context.key');
let cachedKey;

export function sign(origin, roots) {
  const { dev, ino, mtimeNs, ctimeNs } = statSync(contextKey, { bigint: true });
  if (cachedKey?.dev !== dev || cachedKey.ino !== ino || cachedKey.mtimeNs !== mtimeNs || cachedKey.ctimeNs !== ctimeNs)
    cachedKey = { dev, ino, mtimeNs, ctimeNs, bytes: readFileSync(contextKey) };
  return createHmac('sha256', cachedKey.bytes).update(JSON.stringify([origin, roots])).digest('hex');
}
export function checkContext(args) {
  if (!/^[a-f0-9]{64}$/.test(args.hostProof || '')) return false;
  return timingSafeEqual(Buffer.from(sign(args.origin, args.roots), 'hex'), Buffer.from(args.hostProof, 'hex'));
}
