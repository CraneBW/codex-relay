import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const entries = ['plugin.json','mcp_config.json','hooks.json','rules','skills','sidecars','dist','src','scripts','tests','package.json','package-lock.json','README.md'];
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--config-dir')) throw Error('用法：node scripts/install.mjs [--config-dir 目录]');
const config = resolve(args[1] || join(homedir(), '.gemini', 'config'));
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

const fingerprint = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function files(dir) {
  if (!lstatSync(dir).isDirectory()) return [relative(root,dir)];
  return readdirSync(dir).filter(s => s !== '__pycache__').flatMap(s => files(join(dir,s)));
}
for (const name of entries) if (!existsSync(join(root,name))) throw Error('安装包缺少 ' + name);
const hashes = Object.fromEntries(entries.flatMap(e => files(join(root,e))).map(f => [f,fingerprint(join(root,f))]));
mkdirSync(plugins,{recursive:true});
const receipt = join(destination,'.codex-relay-installed.json');
if (existsSync(destination)) {
  if (realpathSync(destination) !== realpathSync(root)) {
    const previous = existsSync(receipt) ? JSON.parse(readFileSync(receipt,'utf8')) : {};
    const changes = [];
    for (const [name, hash] of Object.entries(hashes)) {
      const target = join(destination,name);
      if (existsSync(target)) {
        const current = fingerprint(target);
        if (current === hash) continue;
        if (current !== previous[name]) throw Error('检测到本地修改，请先保存 ' + target);
      }
      changes.push(name);
    }
    // An interrupted installation can retry: each file matches the previous or the incoming release.
    for (const name of changes) {
      const target = join(destination,name), tmp = target + '.' + randomUUID() + '.tmp';
      mkdirSync(dirname(target),{recursive:true});
      try { cpSync(join(root,name),tmp); renameSync(tmp,target); }
      finally { if (existsSync(tmp)) rmSync(tmp); }
    }
  }
} else {
  const stage=mkdtempSync(join(plugins,'.codex-relay-'));
  try {
    for (const name of entries) cpSync(join(root,name),join(stage,name),{recursive:true});
    renameSync(stage,destination);
  } finally { if (existsSync(stage)) rmSync(stage,{recursive:true,force:true}); }
}
const receiptTmp=receipt + '.' + randomUUID() + '.tmp';
try { writeFileSync(receiptTmp,JSON.stringify(hashes),{mode:0o600}); renameSync(receiptTmp,receipt); }
finally { if (existsSync(receiptTmp)) rmSync(receiptTmp); }
if (!alreadyEnabled) {
  const tmp = join(config,'.codex-relay-' + randomUUID() + '.tmp');
  const mode = original === null ? 0o600 : statSync(configFile).mode & 0o777;
  try {
    writeFileSync(tmp, JSON.stringify(settings,null,2) + '\n',{mode,flag:'wx'});
    const latest = existsSync(configFile) ? readFileSync(configFile,'utf8') : null;
    if (latest !== original) throw Error('反重力刚更新了配置，请重新运行安装命令以合并最新设置。');
    if (original !== null) {
      const backup = join(config,'config.before-codex-relay-' + randomUUID() + '.json');
      writeFileSync(backup,original,{mode:0o600,flag:'wx'});console.log('配置备份 ' + basename(backup));
    }
    renameSync(tmp,configFile);
  } finally { if (existsSync(tmp)) rmSync(tmp); }
}
console.log('插件目录 ' + destination + '\n已启用 Codex 事件组件。打开反重力项目后即可派单。');
