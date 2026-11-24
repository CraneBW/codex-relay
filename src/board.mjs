import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'Codex 任务', version: '0.1.1' }, {});
const $ = id => document.getElementById(id);
const labels = { queued:'排队中',starting:'连接中',running:'执行中',stopping:'正在暂停',blocked:'等待反重力',
  host:'反重力排障',waiting_user:'等待你回答',review:'等待验收',done:'已完成',cancelled:'已取消' };
const difficulties = { simple:'简单',browser:'浏览器操作',standard:'常规',complex:'常规',hard:'复杂',exceptional:'极高' };
const eventKinds = { model:'模型',command:'命令',file:'文件',tool:'工具',host:'宿主',accepted:'验收',
  blocked:'阻塞',review:'待验收',retry:'重试',message:'消息',user:'用户' };
const deliveryStates = { pending:'等待唤醒原对话',sent:'已投递唤醒通知',retry:'正在重试唤醒原对话' };
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
function stamp(value) { return new Date(value).toLocaleTimeString('zh-CN', { hour12:false }); }
function time(value, text = stamp(value)) {
  const node = el('time', text); node.dateTime = value; return node;
}
function profile(t) { return t.model + ' · ' + t.effort; }
function status(t) {
  const discussion = {running:'Astra 讨论中',review:'待反重力回应',done:'讨论已结束'};
  return el('span', (t.kind === 'discussion' && discussion[t.status]) || labels[t.status] || t.status, 'state ' + t.status);
}
function error(text) { $('error').textContent = text || ''; $('error').hidden = !text; }
let selected, revision, controller, generation = 0, offset = 0, connected = false;
const limit = 30;
function card(parent, title, cls = '') {
  const section = el('section', null, ('card ' + cls).trim());
  if (title) section.append(el('h3', title));
  parent.append(section);
  return section;
}
function disclosure(key, label, collapseLabel, content) {
  const details = el('details'); details.dataset.detailKey = key;
  const summary = el('summary');
  summary.append(el('span', label, 'open-label'), el('span', collapseLabel, 'close-label'));
  details.append(summary, content);
  return details;
}
function isLong(value, chars, lines) {
  return value.length > chars || value.split('\n').length > lines;
}
function preview(value, chars) {
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length > chars ? text.slice(0, chars).trimEnd() + '…' : text;
}
function previewContent(parent, key, short, full, label = '展开原文', collapseLabel = '收起原文') {
  const wrapper = el('div', null, 'excerpt');
  wrapper.append(el('p', short, 'preview'), disclosure(key, label, collapseLabel, full));
  parent.append(wrapper);
}
function field(parent, title, value, key) {
  if (!value?.trim()) return;
  parent.append(el('h4', title));
  if (key && isLong(value, 260, 5)) previewContent(parent, key, preview(value, 150), el('p', value));
  else parent.append(el('p', value));
}
function overview(parent, t) {
  const section = el('div', null, 'overview');
  const head = el('div', null, 'titleline'); head.append(el('h2', t.title), status(t));
  const metadata = el('dl', null, 'metadata');
  const updated = t.updated && time(t.updated, new Date(t.updated).toLocaleString('zh-CN', {
    month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false,
  }));
  for (const [label, value, cls] of [
    ['模型', t.model], ['思考等级', t.effort],
    ['难度 / 类型', t.kind === 'discussion' ? '讨论' : difficulties[t.difficulty] || t.difficulty],
    ['权限', t.mode === 'read' ? '只读' : '可写'], ['更新时间', updated, 'meta-wide'],
    ['工作目录', t.cwd && el('code', t.cwd), 'meta-wide'],
  ]) {
    const item = el('div', null, cls);
    const description = el('dd'); description.append(value || '—');
    item.append(el('dt', label), description); metadata.append(item);
  }
  section.append(head, metadata); parent.append(section);
}
function shortenPaths(value, cwd) {
  if (!cwd || cwd === '/') return value;
  const path = cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = new RegExp("(^|[\\s\"'`=(:、，])" + path + "(?=/|$|[\\s\"'`),、，])", 'g');
  return value.replace(prefix, '$1.');
}
function activityPreview(value, cwd, command) {
  let text = shortenPaths(value, cwd);
  if (command) {
    const shell = /^((?:执行|结束\s+[^·]+?)\s*·\s*)?(?:(?:\/usr)?\/bin\/)?(?:zsh|bash|sh)\s+-[il]*c[il]*\s+(["']?)([\s\S]*)$/.exec(text);
    if (shell) {
      const [, prefix = '', quote, body] = shell;
      text = prefix + (quote && body.endsWith(quote) ? body.slice(0, -1) : body);
    }
  }
  return preview(text, 120);
}
function progress(parent, t) {
  const section = card(parent, '当前步骤', t.result?.outcome === 'blocked' ? 'progress warning' : 'progress');
  const current = t.current || '等待更新';
  const short = t.result && !isLong(current, 260, 5) ? current : activityPreview(current, t.cwd, !t.result);
  if (short !== current) previewContent(section, 'current', short, el('p', current));
  else section.append(el('p', current));

  if (Object.hasOwn(deliveryStates, t.delivery)) {
    const retry = t.delivery === 'retry';
    const delivery = el('div', null, retry ? 'delivery warning' : 'delivery');
    delivery.append(el('strong', deliveryStates[t.delivery]));
    if (retry && t.deliveryError) delivery.append(el('p', t.deliveryError));
    section.append(delivery);
  }
  if (!t.result) return;
  const { outcome, summary, next, evidence, disagreement } = t.result;
  const result = card(parent, outcome === 'blocked' ? '阻塞情况' : '交付结果', outcome === 'blocked' ? 'warning' : '');
  if (summary !== t.current) field(result, '结论', summary, 'result-summary');
  field(result, '下一步', next, 'result-next');
  field(result, t.kind === 'discussion' ? '证据与依据' : '验证结果', evidence, 'result-evidence');
  field(result, '分歧与限制', disagreement, 'result-disagreement');
  if (result.childElementCount === 1) result.remove();
}
function formatGoal(value) {
  const content = el('div', null, 'goal-text');
  let block;
  for (const line of value.split(/\r?\n/)) {
    const heading = /^(#{1,6})[ \t]+(.+)$/.exec(line);
    const bullet = /^\s*(?:[-+*]|(\d+)[.)])[ \t]+(.+)$/.exec(line);
    if (!line.trim()) { block = undefined; continue; }
    if (heading) {
      content.append(el('h4', heading[2])); block = undefined;
    } else if (bullet) {
      const tag = bullet[1] ? 'ol' : 'ul';
      if (block?.localName !== tag) { block = el(tag); content.append(block); }
      const item = el('li', bullet[2]);
      if (bullet[1]) item.value = Number(bullet[1]);
      block.append(item);
    } else if (block?.localName === 'p') {
      block.textContent += '\n' + line;
    } else {
      block = el('p', line); content.append(block);
    }
  }
  return content;
}
function codeBlock(value, label, key) {
  const block = el('pre', value);
  block.dataset.detailKey = key; block.tabIndex = 0;
  block.setAttribute('role', 'region'); block.setAttribute('aria-label', label);
  return block;
}
function commandCard(parent, t) {
  const c = t.command;
  const id = c.id ?? c.text;
  const section = card(parent);
  const head = el('div', null, 'titleline');
  let label, tone;
  if (c.code != null) {
    label = '退出码 ' + c.code; tone = c.code === 0 ? 'success' : 'warning';
  } else if (c.status === 'inProgress' && ['running', 'starting', 'stopping'].includes(t.status)) {
    label = '运行中'; tone = 'pending';
  } else {
    label = { inProgress:'已中断',failed:'执行失败',declined:'未获批准',interrupted:'已中断' }[c.status] || '无退出码';
    tone = c.status === 'completed' ? 'pending' : 'warning';
  }
  head.append(el('h3', '最近命令'), el('span', label, 'badge ' + tone));
  section.append(head, codeBlock(c.text, '命令文本', 'command-' + id));
  if (c.output) {
    const output = codeBlock(c.output, '命令输出', 'output-text-' + id);
    if (isLong(c.output, 480, 8)) {
      section.append(disclosure('output-' + id, '展开输出', '收起输出', output));
    } else {
      section.append(el('h4', '输出'), output);
    }
  }
}
function timeline(parent, t) {
  const section = card(parent, '最近活动');
  const list = el('ol', null, 'timeline');
  for (const event of t.events.slice(-8).reverse()) {
    const item = el('li');
    const meta = el('div', null, 'event-meta');
    const tone = ['blocked', 'retry'].includes(event.kind) ? ' warning' : event.kind === 'accepted' ? ' success' : '';
    meta.append(time(event.time), el('span', Object.hasOwn(eventKinds, event.kind) ? eventKinds[event.kind] : '活动', 'badge' + tone));
    const text = event.text || '';
    const short = activityPreview(text, t.cwd, event.kind === 'command');
    const full = el('p', text, event.kind === 'command' ? 'event-command' : '');
    item.append(meta);
    if (short !== text) previewContent(item, JSON.stringify([event.time, event.kind, text]), short, full);
    else item.append(full);
    list.append(item);
  }
  section.append(list);
}
let detailSnapshot;
function renderDetail(t) {
  const snapshot = JSON.stringify(t);
  if (snapshot === detailSnapshot) return;
  detailSnapshot = snapshot;
  const detail = $('detail');
  const previous = new Map();
  if (t && detail.dataset.taskId === t.id) {
    for (const node of detail.querySelectorAll('[data-detail-key]')) {
      const control = node.localName === 'details' ? node.firstElementChild : node;
      previous.set(node.dataset.detailKey, { open:node.open, scroll:node.scrollTop, focused:control === document.activeElement });
    }
  }
  detail.replaceChildren();
  detail.dataset.taskId = t?.id || '';
  if (!t) return;
  overview(detail, t);
  progress(detail, t);
  if (t.command) commandCard(detail, t);
  if (t.goal?.trim()) {
    const goal = card(detail, '任务目标');
    const content = formatGoal(t.goal);
    if (isLong(t.goal, 240, 5)) {
      const intro = t.goal.replace(/^(?:#{1,6}|[-+*]|\d+[.)])[ \t]+/gm, '');
      previewContent(goal, 'goal', preview(intro, 130), content, '展开完整目标', '收起');
    } else goal.append(content);
  }
  if (t.events?.length) timeline(detail, t);
  if (t.discussion?.length) {
    const history = el('div');
    for (const m of t.discussion) field(history, m.speaker + ' · ' + stamp(m.at), m.body);
    card(detail, '讨论记录').append(disclosure('discussion', '展开讨论记录', '收起讨论记录', history));
  }
  for (const node of detail.querySelectorAll('[data-detail-key]')) {
    const old = previous.get(node.dataset.detailKey);
    if (!old) continue;
    const isDisclosure = node.localName === 'details';
    if (isDisclosure) node.open = old.open;
    else if (old.scroll) node.scrollTop = old.scroll;
    if (old.focused) (isDisclosure ? node.firstElementChild : node).focus({ preventScroll:true });
  }
}
function render(data) {
  if (data.offline) { error(data.offline); return; }
  error(''); $('count').textContent = data.total + ' 项'; $('empty').hidden = !!data.total;
  $('empty').textContent = '还没有反重力派给 Codex 的任务。';
  const list = $('list'); const oldScroll = list.scrollTop; list.replaceChildren();
  for (const t of data.tasks) {
    const row = el('button',null,'task'); row.type = 'button'; row.setAttribute('aria-pressed',String(t.id === selected));
    const line = el('div',null,'titleline'); line.append(el('strong',t.title),status(t));
    row.append(line,el('small',profile(t)),el('small',t.current)); row.onclick = () => { selected = t.id; restart(); }; list.append(row);
  }
  list.scrollTop = oldScroll;
  $('pager').hidden = data.total <= limit; $('prev').disabled = !offset; $('next').disabled = offset + limit >= data.total;
  $('page').textContent = Math.floor(offset / limit) + 1 + ' / ' + Math.max(1,Math.ceil(data.total / limit));
  renderDetail(data.selected);
}
function restart() {
  generation++; controller?.abort(); revision = undefined;
  if (connected && !document.hidden) void follow(generation);
}
async function follow(token) {
  while (token === generation && !document.hidden) {
    try {
      controller = new AbortController();
      const args = { offset, limit }; if (selected) args.selected = selected; if (revision) args.revision = revision;
      const res = await app.callServerTool({ name:'relay_board_changes', arguments:args }, { signal:controller.signal, timeout:35000 });
      if (token !== generation) return;
      if (res.isError || !res.structuredContent) throw Error(res.content?.[0]?.text || '任务进程未返回视图。');
      const data = res.structuredContent;
      if (!selected && data.tasks.length) { selected = data.tasks[0].id; revision = undefined; continue; }
      if (revision !== data.revision) render(data);
      revision = data.revision;
    } catch (e) {
      if (token !== generation) return;
      error(e.message); await new Promise(r => setTimeout(r,3000)); revision = undefined;
    }
  }
}
function theme(ctx) { if (ctx?.theme) applyDocumentTheme(ctx.theme); if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables); }
$('prev').onclick = () => { offset = Math.max(0, offset-limit); selected = undefined; restart(); };
$('next').onclick = () => { offset += limit; selected = undefined; restart(); };
app.ontoolresult = r => { if (r.structuredContent && !selected) render(r.structuredContent); };
app.onhostcontextchanged = theme;
document.addEventListener('visibilitychange',restart);
window.addEventListener('pagehide', () => { generation++; controller?.abort(); });
app.connect().then(() => { connected = true; theme(app.getHostContext()); restart(); }).catch(e => error(e.message));
