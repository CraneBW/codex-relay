import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cache = new Map();
const maxCachedLineages = 256;

async function readLineage(id) {
  try {
    const helper = process.env.CODEX_RELAY_AGENTAPI || 'agentapi';
    const { stdout } = await exec(helper, ['get-conversation-metadata', id], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    const { parentConversationId, rootConversationId, nestingDepth } = JSON.parse(stdout).response.conversationMetadata.metadata;
    return { parentConversationId, rootConversationId, nestingDepth };
  } catch (error) {
    const stderr = String(error.stderr || '').trim().replace(/\s+/g, ' ').slice(0, 500);
    const reason = [error.code != null ? 'code=' + error.code : '',
      error.signal ? 'signal=' + error.signal : '',
      String(error.message).split('\n')[0].slice(0, 300), stderr].filter(Boolean).join(' · ');
    console.error('[codex-relay] agentapi get-conversation-metadata:', reason);
    throw Error('无法查询反重力对话谱系，请检查子代理是否仍在运行后重试。', { cause: error });
  }
}

export async function requireDirectChild(parent, child) {
  const message = '仅当前主对话的直系子代理可以认领讨论。';
  if (parent === child) throw Error(message);
  let lineage = cache.get(child);
  if (lineage) cache.delete(child);
  else {
    lineage = readLineage(child).catch(error => {
      if (cache.get(child) === lineage) cache.delete(child);
      throw error;
    });
  }
  cache.set(child, lineage);
  if (cache.size > maxCachedLineages) cache.delete(cache.keys().next().value);
  const { parentConversationId, nestingDepth } = await lineage;
  if (parentConversationId !== parent || Number(nestingDepth) !== 1) throw Error(message);
}
