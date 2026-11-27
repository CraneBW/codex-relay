import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, socketDir, socketPath } from '../src/paths.mjs';
import { distStatus } from './dist-status.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { engines, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const required = engines.node.replace(/^>=/, '').split('.').map(Number);
const current = process.versions.node.split('.').map(Number);
const differing = required.findIndex((part, i) => part !== current[i]);
const nodeSupported = differing === -1 || current[differing] > required[differing];

function report(level, label, detail) {
  console.log(`[${level}] ${label} · ${detail}`);
  if (level === 'FAIL') process.exitCode = 1;
}

function checkCommand(label, command, args, missingDetail) {
  const { status, signal, error, stdout, stderr } = spawnSync(command, args, {
    encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024,
  });
  if (error?.code === 'ENOENT' && missingDetail) return report('WARN', label, missingDetail);
  const detail = `${command} ${((status === 0 ? stdout : stderr || stdout) || '').trim().split('\n')[0]}`.trim();
  if (error || status !== 0) report('FAIL', label, `${detail} · ${error?.message || signal || '退出码 ' + status}`);
  else report('OK', label, detail);
}

async function checkSocket() {
  let info;
  try { info = lstatSync(socketPath); }
  catch (error) {
    return error.code === 'ENOENT' ? ['WARN', '尚未创建，后台组件未监听此路径'] : ['FAIL', error.message];
  }
  if (!info.isSocket()) return ['FAIL', '路径已有其他类型的文件'];
  return new Promise(resolve => {
    const socket = net.createConnection(socketPath);
    const finish = (level, detail) => {
      socket.destroy();
      resolve([level, detail]);
    };
    socket.once('connect', () => finish('OK', '可连接'));
    socket.once('error', error => finish('WARN', '连接失败 ' + error.code));
    socket.setTimeout(1000, () => finish('WARN', '连接超时'));
  });
}

function checkLock(DatabaseSync, socketLevel) {
  const path = join(socketDir, 'worker.lock.sqlite');
  if (!existsSync(path)) return report('WARN', '后台锁', path + ' · 尚未创建');
  let lock;
  try {
    lock = new DatabaseSync(path, { readOnly: true });
    lock.exec('PRAGMA busy_timeout=0');
    // The worker holds an exclusive transaction in this database while listening.
    lock.prepare('PRAGMA schema_version').get();
    report(socketLevel === 'OK' ? 'WARN' : 'OK', '后台锁',
      path + (socketLevel === 'OK' ? ' · 空闲，但套接字仍在监听' : ' · 空闲'));
  } catch (error) {
    const busy = error.errcode & 0xff;
    if (busy === 5 || busy === 6) report('OK', '后台锁', path + ' · 已占用');
    else report('FAIL', '后台锁', path + ' · ' + error.message);
  } finally { lock?.close(); }
}

function checkDatabase(DatabaseSync, path) {
  if (!existsSync(path)) return report('WARN', 'SQLite', path + ' · 尚未创建');
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=1000; BEGIN');
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all();
    const counts = tables.map(({ name }) => {
      const identifier = '"' + name.replaceAll('"', '""') + '"';
      return name + '=' + db.prepare('SELECT count(*) AS total FROM ' + identifier).get().total;
    });
    db.exec('COMMIT');
    report('OK', 'SQLite', `${path} · ${tables.length} 张表${counts.length ? ' · ' + counts.join('，') : ''}`);
  } catch (error) {
    report('FAIL', 'SQLite', path + ' · ' + error.message);
  } finally { db?.close(); }
}

console.log('Codex 调度台诊断 · ' + version);
report(nodeSupported ? 'OK' : 'FAIL', 'Node.js', `${process.version}（要求 ${engines.node}）`);
checkCommand('Codex CLI', process.env.CODEX_RELAY_CODEX || 'codex', ['--version']);
const agentapi = process.env.CODEX_RELAY_AGENTAPI;
const agentapiRequired = agentapi || process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
checkCommand('agentapi', agentapi || 'agentapi', ['--help'], agentapiRequired ? undefined :
  '当前环境未找到，Antigravity 会将 agentapi 加入后台组件的 PATH');
try {
  const { missing, changed } = distStatus(root);
  if (missing.length) report('FAIL', 'dist', '缺少 ' + missing.join('、') + ' · 请运行 npm run build');
  else if (changed.length) report('FAIL', 'dist', '构建清单不符 · ' + changed.join('、') + ' · 请运行 npm run build');
  else report('OK', 'dist', '构建清单与当前文件一致');
} catch (error) { report('FAIL', 'dist', error.message); }

const [socketLevel, socketDetail] = await checkSocket();
report(socketLevel, '套接字', socketPath + ' · ' + socketDetail);
if (nodeSupported) {
  const { DatabaseSync } = await import('node:sqlite');
  checkLock(DatabaseSync, socketLevel);
  const fallback = join(dataDir, 'tasks.sqlite');
  const host = join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'codex-relay', 'events', 'data', 'tasks.sqlite');
  const explicit = process.env.CODEX_RELAY_DATA || process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  const paths = explicit ? [fallback] : [...new Set([host, fallback])].filter(existsSync);
  for (const path of paths.length ? paths : [host, fallback]) checkDatabase(DatabaseSync, path);
}
