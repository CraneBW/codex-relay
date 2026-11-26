import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { distStatus } from '../scripts/dist-status.mjs';

const receiptName = '.codex-relay-installed.json';
const launcher = 'scripts/run-node.sh';
function fixture(t) {
  const dir = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'relay-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'release'), config = join(dir, 'config');
  const installed = join(config, 'plugins', 'codex-relay'), configFile = join(config, 'config.json');
  const put = (root, name, value) => {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value);
    return file;
  };
  const payload = ['plugin.json', 'mcp_config.json', 'hooks.json', 'rules/AGENTS.md', 'skills/example/SKILL.md',
    'sidecars/events/worker.mjs', 'src/example.mjs', 'dist/server.cjs', 'dist/board.html',
    'dist/THIRD-PARTY-NOTICES.txt', 'package.json', 'package-lock.json', 'README.md', 'docs/demo/01-cover.png', 'tests/regress.py'];
  for (const name of payload) put(source, name, name);
  for (const name of ['install.mjs', 'dist-status.mjs'])
    cpSync(fileURLToPath(new URL('../scripts/' + name, import.meta.url)), put(source, 'scripts/' + name, ''));
  cpSync(fileURLToPath(new URL('../' + launcher, import.meta.url)), join(source, launcher));
  const sourceTime = new Date('2025-01-01T00:00:00Z'), distTime = new Date('2025-01-02T00:00:00Z');
  for (const name of payload) {
    const stamp = name.startsWith('dist/') ? distTime : sourceTime;
    utimesSync(join(source, name), stamp, stamp);
  }
  const run = ({ flags = [], preload = [], env = {} } = {}) => spawnSync(process.execPath,
    [...preload, join(source, 'scripts', 'install.mjs'), '--config-dir', config, ...flags],
    { cwd: dir, encoding: 'utf8', timeout: 5000, env: { ...process.env, ...env } });
  const install = options => {
    const result = run(options);
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    return result;
  };
  const contents = file => readFileSync(file, 'utf8');
  const receipt = () => JSON.parse(contents(join(installed, receiptName)));
  const addLegacy = name => {
    put(installed, name, name);
    const previous = receipt();
    previous[name] = createHash('sha256').update(name).digest('hex');
    put(installed, receiptName, JSON.stringify(previous));
  };
  return { dir, source, config, configFile, installed, put, run, install, contents, receipt, payload, addLegacy };
}

test('first install includes runtime and documentation, and reinstall preserves existing config and files', t => {
  const f = fixture(t);
  f.install();
  assert.deepEqual(JSON.parse(f.contents(f.configFile)), { sidecars: { 'codex-relay/events': { enabled: true } } });
  for (const name of f.payload.filter(name => !name.startsWith('tests/'))) {
    assert.equal(f.contents(join(f.installed, name)), name);
    assert.equal(f.receipt()[name], createHash('sha256').update(name).digest('hex'));
  }
  assert.equal(existsSync(join(f.installed, 'tests')), false);
  assert.deepEqual(distStatus(f.installed).stale, []);
  const installedLauncher = join(f.installed, launcher);
  assert.equal(statSync(installedLauncher).mode & 0o111, 0o111);
  const launch = spawnSync(installedLauncher, ['--version'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(launch.status, 0, launch.error?.message || launch.stderr);
  assert.equal(launch.stdout.trim(), process.version);
  const watched = [f.configFile, join(f.installed, 'dist/server.cjs'), join(f.installed, 'README.md'), installedLauncher];
  const metadata = () => watched.map(file => [statSync(file).ino, statSync(file).mtimeMs]);
  const before = metadata(), receipt = f.receipt();
  f.install();
  assert.deepEqual(metadata(), before);
  assert.deepEqual(f.receipt(), receipt);
  assert.deepEqual(readdirSync(f.config).sort(), ['config.json', 'plugins']);
});

test('upgrade removes unchanged files tracked by older releases and prunes empty directories', t => {
  const f = fixture(t);
  f.install();
  f.addLegacy('tests/regress.py');
  f.addLegacy('rules/legacy/nested/old.md');
  f.addLegacy('rules/shared/old.md');
  f.addLegacy('rules/interrupted/nested/missing.md');
  rmSync(join(f.installed, 'rules/interrupted/nested/missing.md'));
  f.put(f.installed, 'rules/shared/user.md', 'user');
  f.put(f.source, 'README.md', 'upgraded');
  const installedLauncher = join(f.installed, launcher);
  chmodSync(installedLauncher, 0o644);
  f.install();
  for (const path of ['tests', 'rules/legacy', 'rules/shared/old.md', 'rules/interrupted'])
    assert.equal(existsSync(join(f.installed, path)), false, path);
  assert.equal(f.contents(join(f.installed, 'rules/shared/user.md')), 'user');
  assert.equal(f.contents(join(f.installed, 'README.md')), 'upgraded');
  assert.equal(statSync(installedLauncher).mode & 0o111, 0o111);
  assert.equal(Object.hasOwn(f.receipt(), 'tests/regress.py'), false);
  f.install();
});

test('local edits to retained and removed files both stop the upgrade before writes', t => {
  const f = fixture(t);
  f.install();
  f.addLegacy('tests/keep.py');
  const receipt = f.receipt();
  f.put(f.source, 'README.md', 'upgraded');
  f.put(f.installed, 'rules/AGENTS.md', 'local rules');
  f.put(f.installed, 'tests/keep.py', 'local test');
  let result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /本地修改.*tests\/keep\.py/);
  assert.equal(f.contents(join(f.installed, 'tests/keep.py')), 'local test');
  f.put(f.installed, 'tests/keep.py', 'tests/keep.py');
  result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /本地修改.*rules\/AGENTS\.md/);
  assert.equal(f.contents(join(f.installed, 'rules/AGENTS.md')), 'local rules');
  assert.equal(f.contents(join(f.installed, 'README.md')), 'README.md');
  assert.equal(f.contents(join(f.installed, 'tests/keep.py')), 'tests/keep.py');
  assert.deepEqual(f.receipt(), receipt);
});

test('an old output requires an explicit bypass and missing outputs still stop installation', t => {
  const f = fixture(t);
  const stale = new Date('2024-01-01T00:00:00Z');
  utimesSync(join(f.source, 'dist/board.html'), stale, stale);
  const denied = f.run();
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /dist\/board\.html.*src\/example\.mjs.*npm run build/);
  assert.equal(existsSync(f.config), false);
  f.install({ flags: ['--allow-stale-dist'] });
  rmSync(join(f.source, 'dist/server.cjs'));
  const missing = f.run({ flags: ['--allow-stale-dist'] });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /缺少 dist\/server\.cjs/);
});

test('existing config is backed up verbatim and merged without losing unrelated fields', t => {
  const f = fixture(t);
  const original = '{ "theme": "dark", "sidecars": { "mine": { "enabled": false }, "codex-relay/events": {"other": 1} } }\n';
  f.put(f.config, 'config.json', original);
  f.install();
  const backups = readdirSync(f.config).filter(name => name.startsWith('config.before-codex-relay-'));
  assert.equal(backups.length, 1);
  assert.equal(f.contents(join(f.config, backups[0])), original);
  assert.deepEqual(JSON.parse(f.contents(f.configFile)), {
    theme: 'dark', sidecars: { mine: { enabled: false }, 'codex-relay/events': { other: 1, enabled: true } },
  });
});

test('a concurrent host config update is preserved and retry merges it', t => {
  const f = fixture(t);
  f.put(f.config, 'config.json', '{"theme":"dark"}\n');
  const updated = '{"theme":"light","concurrent":true}\n';
  // Interleave the host write after the installer has prepared its temporary config file.
  const hook = f.put(f.dir, 'race.mjs', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { basename, dirname } from 'node:path';
    const write = fs.writeFileSync;
    fs.writeFileSync = (path, ...args) => {
      write(path, ...args);
      if (dirname(path) === dirname(process.env.TEST_CONFIG_FILE) && /^\\.codex-relay-.*\\.tmp$/.test(basename(path)))
        write(process.env.TEST_CONFIG_FILE, process.env.TEST_CONFIG_UPDATE);
    };
    syncBuiltinESMExports();
  `);
  const denied = f.run({ preload: ['--import', hook], env: { TEST_CONFIG_FILE: f.configFile, TEST_CONFIG_UPDATE: updated } });
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /刚更新了配置.*重新运行/);
  assert.equal(f.contents(f.configFile), updated);
  assert.deepEqual(readdirSync(f.config).sort(), ['config.json', 'plugins']);
  f.install();
  const backup = readdirSync(f.config).find(name => name.startsWith('config.before-codex-relay-'));
  assert.equal(f.contents(join(f.config, backup)), updated);
  assert.equal(JSON.parse(f.contents(f.configFile)).concurrent, true);
});

test('doctor reads the worker database and confirms its lock survives garbage collection', async t => {
  const f = fixture(t);
  f.put(f.source, 'package.json', '{"version":"0.1.1","engines":{"node":">=22.13.0"}}');
  for (const name of ['scripts/doctor.mjs', 'src/paths.mjs']) {
    const dest = join(f.source, name);
    cpSync(fileURLToPath(new URL('../' + name, import.meta.url)), dest);
    if (name.startsWith('src/')) utimesSync(dest, new Date(0), new Date(0));
  }
  const runtime = join(f.dir, 'runtime');
  const env = { ...process.env, CODEX_RELAY_DATA:runtime, CODEX_RELAY_SOCKET_DIR:runtime,
    CODEX_RELAY_CODEX:process.execPath, CODEX_RELAY_AGENTAPI:process.execPath };
  const preload = f.put(f.dir, 'gc.mjs', `
    import { existsSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const dir = process.env.CODEX_RELAY_SOCKET_DIR;
    const timer = setInterval(() => {
      if (!existsSync(join(dir, 'events.sock'))) return;
      clearInterval(timer);
      globalThis.gc();
      writeFileSync(join(dir, 'collected'), '');
    }, 10);
    timer.unref();
  `);
  const worker = spawn(process.execPath, ['--expose-gc', '--disable-warning=ExperimentalWarning',
    '--import', preload, fileURLToPath(new URL('../sidecars/events/worker.mjs', import.meta.url))],
    { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = once(worker, 'exit');
  let stderr = '';
  worker.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const collected = join(runtime, 'collected');
    for (let n = 0; n < 100 && !existsSync(collected) && worker.exitCode === null; n++) await delay(10);
    assert.ok(existsSync(collected), stderr);
    const probe = () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(f.source, 'scripts/doctor.mjs')],
      { env, encoding:'utf8', timeout:5000 });
    const active = probe();
    assert.equal(active.status, 0, active.stdout || active.stderr);
    assert.match(active.stdout, /\[OK\] 套接字 .*可连接/);
    assert.match(active.stdout, /\[OK\] 后台锁 .*已占用/);
    assert.match(active.stdout, /\[OK\] SQLite .*3 张表.*discussion_messages=0，notices=0，tasks=0/);
    worker.kill();
    assert.deepEqual(await exited, [0, null]);
    const stopped = probe();
    assert.equal(stopped.status, 0, stopped.stdout || stopped.stderr);
    assert.match(stopped.stdout, /\[WARN\] 套接字 .*尚未创建/);
    assert.match(stopped.stdout, /\[OK\] 后台锁 .*空闲/);
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill();
    await exited;
  }
});
