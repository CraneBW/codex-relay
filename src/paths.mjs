import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

export function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}

export const socketDir = process.env.CODEX_RELAY_SOCKET_DIR ||
  join(process.env.XDG_RUNTIME_DIR || tmpdir(), 'codex-relay-' + process.getuid());
export const socketPath = join(socketDir, 'events.sock');
export const dataDir = process.env.CODEX_RELAY_DATA ||
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'codex-relay');
