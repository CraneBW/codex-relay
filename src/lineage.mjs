import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cache = new Map();

async function readLineage(id) {
  try {
    const helper = process.env.CODEX_RELAY_AGENTAPI || 'agentapi';
    const { stdout } = await exec(helper, ['get-conversation-metadata', id], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    const { parentConversationId, rootConversationId, nestingDepth } = JSON.parse(stdout).response.conversationMetadata.metadata;
    return { parentConversationId, rootConversationId, nestingDepth };
  } catch {
    throw Error('无法查询反重力对话谱系，请检查子代理是否仍在运行后重试。');
  }
}

export async function requireDirectChild(parent, child) {
  const message = '仅当前主对话的直系子代理可以认领讨论。';
  if (parent === child) throw Error(message);
  if (!cache.has(child)) {
    cache.set(child, readLineage(child).catch(error => {
      cache.delete(child);
      throw error;
    }));
  }
  const { parentConversationId, nestingDepth } = await cache.get(child);
  if (parentConversationId !== parent || Number(nestingDepth) !== 1) throw Error(message);
}
