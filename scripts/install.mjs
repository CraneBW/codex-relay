import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { distStatus, fingerprint } from './dist-status.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const entries = ['plugin.json','mcp_config.json','hooks.json','rules','skills','sidecars','dist','src','scripts','package.json','package-lock.json','README.md'];
const launcher = 'scripts/run-node.sh';
const realpath = process.platform === 'darwin' ? realpathSync.native : realpathSync;
const { values: args } = parseArgs({ options: {
  'config-dir': { type: 'string' }, 'allow-stale-dist': { type: 'boolean' },
} });
const { missing, changed } = distStatus(root);
if (missing.length) throw Error('安装包缺少 ' + missing.join('、') + '。请先运行 npm run build。');
if (changed.length && !args['allow-stale-dist'])
  throw Error('构建清单与当前文件不符（' + changed.join('、') + '）。请先运行 npm run build，或显式使用 --allow-stale-dist。');
const config = resolve(args['config-dir'] || join(homedir(), '.gemini', 'config'));
const plugins = join(config, 'plugins'), destination = join(plugins, 'codex-relay'), configFile = join(config, 'config.json');
const original = existsSync(configFile) ? readFileSync(configFile, 'utf8') : null;
const settings = original === null ? {} : JSON.parse(original);
const object = v => v && typeof v === 'object' && !Array.isArray(v);
if (!object(settings) || (settings.sidecars != null && !object(settings.sidecars))) throw Error('config.json 的 sidecars 格式异常，安装已停止。');
settings.sidecars ||= {};
const key = 'codex-relay/events';
if (settings.sidecars[key] != null && !object(settings.sidecars[key])) throw Error('现有后台组件配置格式异常。');
const alreadyEnabled = settings.sidecars[key]?.enabled === true;
settings.sidecars[key] = { ...settings.sidecars[key], enabled: true };

function files(dir) {
  const info = lstatSync(dir);
  if (info.isFile()) return [relative(root,dir)];
  if (!info.isDirectory()) throw Error('安装包包含非普通文件 ' + dir);
  return readdirSync(dir)
    .filter(s => s !== '__pycache__' && s !== '.DS_Store' && !s.startsWith('._'))
    .flatMap(s => files(join(dir,s)));
}
function statIfPresent(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}
function installedHash(name) {
  const parts = name.split(sep);
  if (parts.some(part => !part || part === '.' || part === '..') || name === receiptName)
    throw Error('安装清单包含无效路径 ' + name);
  let path = destination;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const info = statIfPresent(path);
    if (!info) return null;
    if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()) throw localChange(path);
  }
  return fingerprint(path);
}
const localChange = path => Error('检测到本地修改，请先保存 ' + path);
for (const name of [...entries, launcher]) if (!existsSync(join(root,name))) throw Error('安装包缺少 ' + name);
if (existsSync(join(root, 'docs', 'demo'))) entries.push('docs/demo');
const hashes = Object.fromEntries(entries.flatMap(e => files(join(root,e))).map(f => [f,fingerprint(join(root,f))]));
mkdirSync(plugins,{recursive:true});
const receiptName = '.codex-relay-installed.json';
const receipt = join(destination,receiptName);
function writeReceipt(path) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  try { writeFileSync(tmp,JSON.stringify(hashes),{mode:0o600,flag:'wx'}); renameSync(tmp,path); }
  finally { if (existsSync(tmp)) rmSync(tmp); }
}
if (statIfPresent(destination)) {
  if (realpath(destination) !== realpath(root)) {
    if (!lstatSync(destination).isDirectory()) throw localChange(destination);
    const receiptInfo = statIfPresent(receipt);
    if (receiptInfo && !receiptInfo.isFile()) throw localChange(receipt);
    const previous = receiptInfo ? JSON.parse(readFileSync(receipt,'utf8')) : {};
    if (!object(previous)) throw Error('安装清单格式异常 ' + receipt);
    const changes = [];
    const removed = [];
    for (const [name, hash] of Object.entries(previous)) {
      if (Object.hasOwn(hashes, name)) continue;
      const current = installedHash(name);
      if (current !== null && current !== hash) throw localChange(join(destination,name));
      removed.push(name);
    }
    for (const [name, hash] of Object.entries(hashes)) {
      const current = installedHash(name);
      if (current === hash) {
        if (name === launcher) {
          const targetMode = lstatSync(join(destination, name)).mode;
          const sourceMode = lstatSync(join(root, name)).mode;
          if ((targetMode & 0o111) === (sourceMode & 0o111)) continue;
        } else continue;
      }
      else if (current !== null && current !== previous[name]) throw localChange(join(destination,name));
      changes.push([name, current]);
    }
    // An interrupted installation can retry: each file matches the previous or the incoming release.
    for (const [name, current] of changes) {
      const target = join(destination,name), tmp = target + '.' + randomUUID() + '.tmp';
      mkdirSync(dirname(target),{recursive:true});
      try {
        cpSync(join(root,name),tmp,{preserveTimestamps:true});
        if (installedHash(name) !== current) throw localChange(target);
        renameSync(tmp,target);
      }
      finally { if (existsSync(tmp)) rmSync(tmp); }
    }
    for (const name of removed) {
      const target = join(destination,name);
      const current = installedHash(name);
      if (current !== null) {
        if (current !== previous[name]) throw localChange(target);
        unlinkSync(target);
      }
      for (let dir = dirname(target); dir !== destination; dir = dirname(dir)) {
        try { rmdirSync(dir); }
        catch (error) {
          if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') break;
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  }
  writeReceipt(receipt);
} else {
  const stage=mkdtempSync(join(plugins,'.codex-relay-'));
  try {
    for (const name of Object.keys(hashes)) {
      const target = join(stage,name);
      mkdirSync(dirname(target),{recursive:true});
      cpSync(join(root,name),target,{preserveTimestamps:true});
    }
    writeReceipt(join(stage,receiptName));
    renameSync(stage,destination);
  } finally { if (existsSync(stage)) rmSync(stage,{recursive:true,force:true}); }
}
if (!alreadyEnabled) {
  const tmp = join(config,'.codex-relay-' + randomUUID() + '.tmp');
  const mode = original === null ? 0o600 : (statIfPresent(configFile)?.mode ?? 0o600) & 0o777;
  const checkConfig = () => {
    let latest;
    try { latest = readFileSync(configFile,'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; latest = null; }
    if (latest !== original) throw Error('反重力刚更新了配置，请重新运行安装命令以合并最新设置。');
  };
  try {
    writeFileSync(tmp, JSON.stringify(settings,null,2) + '\n',{mode,flag:'wx'});
    checkConfig();
    if (original !== null) {
      const backup = join(config,'config.before-codex-relay-' + randomUUID() + '.json');
      writeFileSync(backup,original,{mode:0o600,flag:'wx'});console.log('配置备份 ' + basename(backup));
    }
    checkConfig();
    renameSync(tmp,configFile);
  } finally { if (existsSync(tmp)) rmSync(tmp); }
}
console.log('插件目录 ' + destination + '\n已启用 Codex 事件组件。打开反重力项目后即可派单。');
