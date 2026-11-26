import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

export const realWorkspacePath = process.platform === 'darwin' ? realpathSync.native : realpathSync;

export function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}

function runtimeDir() {
  if (process.platform === 'darwin') {
    // The hook, MCP server and sidecar can receive different TMPDIR values.
    return execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim();
  }
  return process.env.XDG_RUNTIME_DIR || tmpdir();
}

export const socketDir = process.env.CODEX_RELAY_SOCKET_DIR ||
  join(runtimeDir(), 'codex-relay-' + process.getuid());
export const socketPath = join(socketDir, 'events.sock');
export const dataDir = process.env.CODEX_RELAY_DATA ||
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'codex-relay');
