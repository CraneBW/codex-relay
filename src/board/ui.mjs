import { astra, luna, sol, terra } from '../models.mjs';

export const $ = id => document.getElementById(id);
export const running = new Set(['running', 'starting', 'stopping']);
export const attention = new Set(['blocked', 'waiting_user', 'host', 'review']);
export const interrupted = new Set(['blocked', 'waiting_user', 'host']);
export const labels = {
  queued: '排队中', starting: '连接中', running: '执行中', stopping: '正在暂停', blocked: '等待反重力',
  host: '反重力排障', waiting_user: '等待你回答', review: '等待验收', done: '已完成', cancelled: '已取消', missing: '记录缺失',
};
const discussionLabels = { running: '讨论中', review: '待反重力回应', done: '讨论已结束' };
export const queueLabels = {
  upstream: '等待上游验收', upstream_blocked: '上游遇到阻塞', upstream_cancelled: '上游已取消', write_lock: '等待目录写锁',
};
const models = new Map([
  [astra, ['Astra Max', 'astra']], [sol, ['Sol', 'sol']], [terra, ['Terra', 'terra']], [luna, ['Luna', 'luna']],
]);
export const modelName = id => models.get(id)?.[0] || id;
export const taskLabel = task => task.nodeLabel || task.title;
export const statusLabel = task => (task.kind === 'discussion' && discussionLabels[task.status]) || labels[task.status] || task.status;
export const modeLabel = task => task.mode === 'read' ? '只读' : '可写';
export const graphKey = graph => JSON.stringify([graph.origin, graph.graphId]);
export const graphName = graph => graph.graphTitle || graph.graphId;

export function el(tag, text, classes) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (classes) node.className = classes;
  return node;
}

export function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

export function button(text, classes = 'control') {
  const node = el('button', text, classes);
  node.type = 'button';
  return node;
}

export function stateBadge(task, dotOnly = false) {
  const label = statusLabel(task);
  const node = el('span', dotOnly ? null : label, `state ${task.status || 'missing'}${dotOnly ? ' state-dot' : ''}`);
  if (dotOnly) node.append(el('span', label, 'sr-only'));
  node.title = label;
  return node;
}

export function modelBadge(task) {
  const name = modelName(task.model);
  return el('span', [name, task.effort].filter(Boolean).join(' · '), `model-badge model-${models.get(task.model)?.[1] || 'sol'}`);
}

export function permissionBadge({ mode, sandbox = mode === 'read' ? 'read-only' : 'workspace-write', approvalPolicy = 'on-request' }) {
  const fullAccess = sandbox === 'danger-full-access';
  const scope = fullAccess ? '完全开放' : sandbox === 'read-only' ? '只读' : '可写';
  const policy = { 'never':'免审批', 'untrusted':'严格审批', 'on-request':fullAccess ? '按需审批' : '' }[approvalPolicy];
  const node = el('span', [scope, policy].filter(Boolean).join(' · '),
    `permission-badge${fullAccess ? ' permission-open' : policy ? ' permission-policy' : ''}`);
  node.title = `${sandbox} · ${approvalPolicy}`;
  return node;
}

export function time(value, style = 'clock') {
  const date = new Date(value);
  const options = style === 'clock' ? { hour:'2-digit', minute:'2-digit', second:'2-digit' }
    : style === 'minutes' ? { hour:'2-digit', minute:'2-digit' }
    : { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' };
  const node = el('time', style === 'exact' ? value : date.toLocaleString('zh-CN', { ...options, hour12:false }));
  node.dateTime = value;
  node.title = value;
  return node;
}

export function plainPreview(value, limit = 125) {
  const text = String(value ?? '')
    .replace(/^\s{0,3}(?:`{3,}|~{3,})[^\n]*$/gm, '')
    .replace(/^\s{0,3}(?:(?:#{1,6}|>|[-+*]|\d+[.)])\s+)+/gm, '')
    .replace(/!?\[([^\]]*)\]\([^\n)]*\)/g, '$1')
    .replace(/(`+|\*\*|__|~~|\*)([^\n]+?)\1/g, '$2')
    .replace(/<\/?[a-z][^<>]*>/gi, '')
    .replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit).trimEnd() + '…' : text;
}

export function queueText(task) {
  if (!task.waitInfo) return '';
  const { kind, blockers = [] } = task.waitInfo;
  return [queueLabels[kind] || '等待启动', blockers.map(ref => ref.label).join('、')].filter(Boolean).join(' · ');
}

export function taskLinks(refs, onSelect) {
  const list = el('div', null, 'task-links');
  for (const ref of refs || []) {
    const item = button(null, 'task-link');
    item.append(stateBadge(ref, true), el('span', ref.label), el('span', statusLabel(ref), 'link-state'));
    item.disabled = ref.status === 'missing';
    if (ref.cwd) item.title = ref.cwd;
    item.onclick = () => onSelect(ref.id);
    list.append(item);
  }
  return list;
}

export function readSetting(key, fallback) {
  try { return JSON.parse(localStorage.getItem(`codex-relay.board.${key}`)) ?? fallback; }
  catch { return fallback; }
}

export function writeSetting(key, value) {
  try { localStorage.setItem(`codex-relay.board.${key}`, JSON.stringify(value)); }
  catch { /* A sandboxed iframe can disable storage. */ }
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const focused = document.activeElement;
    const selection = document.getSelection();
    const ranges = Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange());
    const input = el('textarea', null, 'copy-buffer');
    input.value = value;
    input.readOnly = true;
    input.addEventListener('copy', event => {
      if (!event.clipboardData) return;
      event.clipboardData.setData('text/plain', value);
      event.preventDefault();
    }, { once:true });
    (focused?.closest('dialog') || document.body).append(input);
    input.focus({ preventScroll:true });
    input.select();
    try { return document.execCommand('copy'); }
    catch { return false; }
    finally {
      input.remove();
      focused?.focus({ preventScroll:true });
      if (ranges.length) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    }
  }
}

export function copyButton(value, subject = '内容') {
  const label = `复制${subject}`;
  const control = button('复制', 'text-control copy');
  control.title = label;
  control.setAttribute('aria-label', label);
  let reset;
  control.onclick = async () => {
    const copied = await copyText(typeof value === 'function' ? value() : value);
    const feedback = copied ? '已复制' : '复制失败';
    setText(control, feedback);
    $('feedback').textContent = `${subject}${feedback}`;
    clearTimeout(reset);
    reset = setTimeout(() => setText(control, '复制'), 1500);
  };
  return control;
}

export function openReader(title, value, technical = true) {
  const dialog = $('reader');
  setText($('reader-title'), title);
  const body = $('reader-text');
  body.classList.toggle('reader-prose', !technical);
  setText(body, value);
  const actions = $('reader-actions');
  actions.querySelector('.copy')?.remove();
  actions.prepend(copyButton(value, title));
  $('reader-close').onclick = () => dialog.close();
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('.reader-scroll').scrollTop = 0;
}

export function syncChildren(parent, nodes) {
  const next = new Set(nodes);
  for (const child of [...parent.childNodes]) if (!next.has(child)) child.remove();
  let before = parent.firstChild;
  for (const node of nodes) {
    if (node === before) before = before.nextSibling;
    else parent.insertBefore(node, before);
  }
}

const keyed = new WeakMap();
export function patch(parent, entries) {
  const previous = keyed.get(parent) || new Map();
  const next = new Map();
  for (const [key, data, create, update] of entries) {
    const snapshot = JSON.stringify(data);
    const old = previous.get(key);
    let node = old?.node;
    if (!old || old.snapshot !== snapshot) {
      if (node && update) update(node, data);
      else node = create(data);
    }
    next.set(key, { node, snapshot });
  }
  syncChildren(parent, [...next.values()].map(item => item.node));
  keyed.set(parent, next);
}

export function withKeys(values, identify) {
  const seen = new Map();
  return values.map(value => {
    const key = identify(value);
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    return [JSON.stringify([key, count]), value];
  });
}
