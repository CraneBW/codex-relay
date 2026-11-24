import net from 'node:net';
import { chmodSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataDir, socketDir, socketPath } from '../../src/paths.mjs';
import { Store } from '../../src/store.mjs';
import { Supervisor } from '../../src/supervisor.mjs';
import { Notices } from '../../src/notices.mjs';
import { contextKey } from '../../src/context.mjs';

process.umask(0o077);
mkdirSync(socketDir, { recursive: true, mode: 0o700 });
const directory = lstatSync(socketDir);
if (!directory.isDirectory() || directory.uid !== process.getuid()) throw Error('套接字目录的所有者不匹配。');
chmodSync(socketDir, 0o700);
const lock = new DatabaseSync(join(socketDir, 'worker.lock.sqlite'));
lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
writeFileSync(contextKey, randomBytes(32), { mode: 0o600 });
try { unlinkSync(socketPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const store = new Store(dataDir);
const supervisor = new Supervisor(store);
const notices = new Notices(store);
const sockets = new Set();
const server = net.createServer(socket => {
  sockets.add(socket); socket.setEncoding('utf8');
  const controller = new AbortController();
  socket.on('error', () => {});
  socket.on('close', () => { sockets.delete(socket); controller.abort(); });
  let input = '';
  const receive = async part => {
    input += part;
    if (input.length > 256000) { socket.destroy(); return; }
    if (!input.includes('\n')) return;
    socket.off('data', receive);
    let response;
    try {
      const { method, args = {} } = JSON.parse(input.trim());
      let result;
      if (supervisor.closing) throw Error('反重力正在关闭，进度已保存。');
      if (method === 'dispatch') result = supervisor.dispatch(args);
      else if (method === 'discuss') result = supervisor.dispatch(args, true);
      else if (method === 'control') result = await supervisor.control(args);
      else if (method === 'inspect') result = supervisor.inspect(args);
      else if (method === 'board') {
        if (args.revision) await store.wait(args.revision, controller.signal);
        result = store.board(args);
      } else throw Error('未知方法。');
      response = { result };
    } catch (e) { response = { error: e.message }; }
    if (!socket.destroyed) socket.end(JSON.stringify(response) + '\n');
  };
  socket.on('data', receive);
});

let quitting = false;
async function quit() {
  if (quitting) return;
  quitting = true;
  notices.close(); supervisor.closing = true;
  if (server.listening) server.close();
  for (const socket of sockets) socket.destroy();
  await supervisor.stop();
  try { unlinkSync(socketPath); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => void quit());
process.on('SIGINT', () => void quit());
await supervisor.recover();
if (!quitting) server.listen(socketPath, () => { chmodSync(socketPath, 0o600); notices.signal(); });
