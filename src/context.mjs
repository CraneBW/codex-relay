import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { socketDir } from './paths.mjs';

export const contextKey = join(socketDir, 'context.key');
export function sign(origin, roots) {
  return createHmac('sha256', readFileSync(contextKey)).update(JSON.stringify([origin, roots])).digest('hex');
}
export function checkContext(args) {
  if (!/^[a-f0-9]{64}$/.test(args.hostProof || '')) return false;
  return timingSafeEqual(Buffer.from(sign(args.origin, args.roots), 'hex'), Buffer.from(args.hostProof, 'hex'));
}
