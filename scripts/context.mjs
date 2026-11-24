import { readFileSync } from 'node:fs';
import { sign } from '../src/context.mjs';

const event = JSON.parse(readFileSync(0, 'utf8'));
const overwrite = {
  origin: event.conversationId,
  roots: event.workspacePaths || [],
};
if (!overwrite.origin) {
  console.log(JSON.stringify({ decision: 'deny', reason: '反重力没有提供派单对话 ID。' }));
} else {
  try {
    overwrite.hostProof = sign(overwrite.origin, overwrite.roots);
    console.log(JSON.stringify({ decision: 'allow', overwrite }));
  } catch {
    console.log(JSON.stringify({ decision: 'deny', reason: 'Codex 任务进程未就绪。请确认 codex-relay/events 已启用。' }));
  }
}
