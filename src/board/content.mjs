import {
  button, copyButton, el, interrupted, modeLabel, openReader, patch, plainPreview, queueLabels, running,
  setText, stateBadge, taskLinks, time, withKeys,
} from './ui.mjs';
import { prose } from './markdown.mjs';

const eventLabels = {
  model:'模型', permission:'会话权限', command:'命令', file:'文件', tool:'工具', host:'反重力', accepted:'验收',
  blocked:'阻塞', review:'交付', retry:'重试', message:'消息', user:'用户',
  delegate:'讨论委托', handover:'控制权交接',
};
const deliveryLabels = { pending:'等待投递唤醒通知', sent:'已投递唤醒通知', retry:'正在重试唤醒通知' };
const failedCommand = new Set(['failed', 'declined', 'interrupted']);

export const hasText = value => typeof value === 'string' && !!value.trim();
export const sameText = (a, b) => hasText(a) && hasText(b) && (a.trim() === b.trim() || a.trim() === b.slice(0, 400).trim());

export function section(title, classes = '') {
  const block = el('section', null, `content-block ${classes}`);
  block.dataset.scrollAnchor = '';
  if (title) block.append(el('h3', title));
  return block;
}

export function field(parent, label, value) {
  if (!hasText(value)) return;
  const block = el('div', null, 'result-field');
  block.append(el('h4', label), prose(value));
  parent.append(block);
}

function tabLink(label, tab, showTab) {
  const control = button(label, 'text-control tab-link');
  control.onclick = () => showTab(tab);
  return control;
}

export function goalEntry(value, { tab, showTab, preview = false, rendered = false, discussion = false }) {
  if (!hasText(value)) return [];
  return [['goal', [value, preview, rendered, discussion], ([text, compact, rich, isDiscussion]) => {
    const node = section(isDiscussion ? '原始议题' : '任务目标', compact ? 'goal-preview' : '');
    if (!compact) node.append(prose(text));
    else {
      if (rich) {
        const excerpt = prose(text);
        while (excerpt.children.length > 3) excerpt.lastElementChild.remove();
        excerpt.inert = true;
        node.append(excerpt);
      } else node.append(el('p', plainPreview(text, 148), 'goal-snippet'));
      node.append(tabLink(isDiscussion ? '查看完整议题' : '查看完整目标', tab, showTab));
    }
    return node;
  }]];
}

const raw = new WeakMap();

function rawBlock(title, full = false, state) {
  const root = el('div', null, 'code-box raw-box');
  const header = el('div', null, 'code-head');
  const actions = el('div', null, 'code-actions');
  const pre = el('pre');
  pre.setAttribute('aria-label', title);
  pre.tabIndex = 0;
  const record = { value:'', title, full, pre, state };
  actions.append(copyButton(() => record.value, title));
  if (!full) {
    const expand = button('展开全文', 'text-control');
    expand.setAttribute('aria-expanded', 'false');
    expand.onclick = () => {
      state.expanded = !state.expanded;
      updateRaw(root, record.value);
    };
    const reader = button('独立阅读', 'text-control');
    reader.onclick = () => openReader(title, record.value);
    actions.append(expand, reader);
    Object.assign(record, { expand, reader });
  }
  header.append(el('span', title), actions);
  root.append(header, pre);
  raw.set(root, record);
  return root;
}

function updateRaw(root, value) {
  const record = raw.get(root);
  record.value = value;
  const lines = value.split('\n');
  const trimmed = !record.full && (lines.length > 14 || value.length > 3000);
  const expanded = trimmed && record.state.expanded;
  const visible = trimmed && !expanded ? lines.slice(0, 14).join('\n').slice(0, 3000) : value;
  if (!record.full) {
    setText(record.expand, expanded ? '收起输出' : '展开全文');
    record.expand.setAttribute('aria-expanded', String(!!expanded));
    record.expand.hidden = record.reader.hidden = !trimmed;
    root.classList.toggle('has-preview', trimmed && !expanded);
  }
  setText(record.pre, visible);
}

function commandStatus({ command, status }) {
  if (command.code != null) return ['退出码 ' + command.code, command.code === 0 ? 'ok' : 'failure'];
  if (command.status === 'inProgress') return running.has(status) ? ['运行中', 'live'] : ['已中断', 'failure'];
  return [{
    failed:'执行失败', declined:'未获批准', interrupted:'已中断',
  }[command.status] || '无退出码', failedCommand.has(command.status) ? 'failure' : 'neutral'];
}

function commandEntry(task, context) {
  if (!task.command?.text && !task.command?.output) return [];
  const id = String(task.command.id ?? task.command.text);
  const { outputs } = context.state;
  if (!outputs.has(id)) outputs.set(id, { expanded:false });
  const state = outputs.get(id);
  const update = (root, data) => {
    const [label, tone] = commandStatus(data);
    const mark = root.querySelector('.command-status');
    setText(mark, label);
    mark.className = `command-status ${tone}`;
    root.classList.toggle('command-failure', tone === 'failure');
    const [input, output] = root.querySelectorAll('.raw-box');
    updateRaw(input, data.command.text || '');
    updateRaw(output, data.command.output || '');
    input.hidden = !data.command.text;
    output.hidden = !data.command.output;
  };
  return [[`command-${id}`, { command:task.command, status:task.status }, data => {
    const root = section(null, 'command-block');
    const heading = el('div', null, 'section-line');
    heading.append(el('h3', '最近命令'), el('span', null, 'command-status'));
    root.append(heading, rawBlock('命令', true), rawBlock('输出', false, state));
    update(root, data);
    return root;
  }, update]];
}

function eventTone(event) {
  if (event.kind === 'accepted' || event.kind === 'review') return 'ok';
  if (['blocked', 'retry'].includes(event.kind)) return 'failure';
  if (event.kind === 'command') {
    const match = /^结束\s+(-?\d+|failed|declined|interrupted)\b/.exec(event.text || '');
    if (match) return Number(match[1]) === 0 ? 'ok' : 'failure';
  }
  return 'neutral';
}

function eventRow(event) {
  const item = el('li', null, `event-row ${eventTone(event)}`);
  item.dataset.scrollAnchor = '';
  const meta = el('div', null, 'event-meta');
  const label = Object.hasOwn(eventLabels, event.kind) ? eventLabels[event.kind] : '活动';
  meta.append(el('span', null, 'event-dot'), time(event.time), el('span', label, 'event-kind'));
  const value = event.text || '';
  const technical = ['command', 'tool', 'file'].includes(event.kind);
  const body = el('div', null, 'event-body');
  body.append(el('p', value, technical ? 'event-text mono' : 'event-text'));
  if (value) {
    const actions = el('div', null, 'event-actions');
    actions.append(copyButton(value, '活动原文'));
    if (value.length > 105 || value.split('\n').length > 2) {
      const reader = button('阅读', 'text-control');
      reader.onclick = () => openReader(label + '记录', value, technical);
      actions.prepend(reader);
    }
    body.append(actions);
  }
  item.append(meta, body);
  return item;
}

function timelineEntry(events, recent = false) {
  if (!events?.length) return [];
  const latest = recent ? events.slice(-4) : events;
  const update = (root, values) => {
    const list = root.querySelector('ol');
    patch(list, withKeys(values, event => [event.time, event.kind, event.text])
      .map(([key, event]) => [key, event, eventRow]));
  };
  return [['timeline', latest, values => {
    const root = section(recent ? '最近动态' : '活动时间线');
    root.append(el('ol', null, 'timeline'));
    update(root, values);
    return root;
  }, update]];
}

export function recordEntries(task, context) {
  return [...commandEntry(task, context), ...timelineEntry(task.events)];
}

function recordLink(task, { showTab }) {
  if (!task.events?.length && !task.command) return [];
  return [['record-link', [task.events?.length || 0, !!task.command], ([events, command]) => {
    const root = section(null, 'record-link');
    const text = [events ? `${events} 条动态` : '', command ? '最近命令与输出' : ''].filter(Boolean);
    root.append(el('span', text.join(' · ')), tabLink('查看执行记录', 'records', showTab));
    return root;
  }]];
}

export function deliveryDiagnostic(error) {
  const block = el('div', null, 'delivery-error');
  const heading = el('div', null, 'section-line');
  heading.append(el('h4', '唤醒投递错误'), copyButton(error, '投递错误'));
  block.append(heading, el('pre', error, 'raw-inline'));
  return block;
}

function interruption(task) {
  const focus = {
    blocked:'阻塞原因', waiting_user:'待回答的问题', host:'反重力正在排障',
  }[task.status];
  const { current, result, deliveryError, status } = task;
  if (!hasText(current) && !result && !deliveryError) return [];
  return [['interruption', { current, result, deliveryError, status }, data => {
    const root = section(focus, 'attention-block');
    const summary = data.result?.summary;
    if (hasText(data.current)) root.append(prose(sameText(data.current, summary) ? summary : data.current));
    else if (hasText(summary)) root.append(prose(summary));
    if (hasText(data.current) && !sameText(data.current, summary)) field(root, '阻塞说明', summary);
    if (data.deliveryError) root.append(deliveryDiagnostic(data.deliveryError));
    field(root, '恢复建议', data.result?.next);
    field(root, '已核对', data.result?.evidence);
    return root;
  }]];
}

function queuedEntries(task, { onSelect }) {
  return [['queue', [task.waitInfo, task.upstreams, task.current], ([wait, upstreams, current]) => {
    const root = section('等待原因', 'queue-block');
    root.append(el('p', (wait && queueLabels[wait.kind]) || current || '等待调度'));
    const blockers = wait?.blockers || [];
    const refs = new Map((upstreams || []).map(ref => [ref.id, ref]));
    if (wait?.kind === 'write_lock') root.append(taskLinks(blockers, onSelect));
    else for (const ref of blockers) if (!refs.has(ref.id)) refs.set(ref.id, ref);
    if (refs.size) {
      root.append(el('h4', '前置依赖'), taskLinks([...refs.values()], onSelect));
    }
    return root;
  }]];
}

function activeStep(task) {
  const isCommand = task.command?.status === 'inProgress' && task.current && task.command.text?.startsWith(task.current);
  const isTechnical = !isCommand && /^(已处理文件 |正在修改 )/.test(task.current || '');
  return [['step', [task.status, task.current, isCommand, isTechnical], ([status, current, command, technical]) => {
    const root = section(null, 'current-step');
    const heading = el('div', null, 'section-line');
    heading.append(el('h3', '当前步骤'), stateBadge({ status }));
    const value = command ? '正在执行下方命令。' : (current || '等待更新');
    root.append(heading, el('p', value, technical ? 'raw-inline' : 'step-text'));
    if (technical) root.append(copyButton(current, '当前步骤'));
    return root;
  }]];
}

function deliveryResult(task) {
  if (!task.result && !hasText(task.current)) return [];
  return [['delivery-result', [task.result, task.current], ([result, current]) => {
    const root = section('交付结论', 'delivery-result');
    if (hasText(result?.summary)) {
      root.append(prose(result.summary));
      if (!sameText(current, result.summary)) field(root, '验收备注', current);
    } else if (hasText(current)) root.append(prose(current));
    field(root, '验证结果', result?.evidence);
    field(root, '下一步', result?.next);
    if (hasText(result?.disagreement)) field(root, '分歧与限制', result.disagreement);
    return root;
  }]];
}

export function overviewEntries(task, context) {
  const goal = (rendered = false) => goalEntry(task.goal, { ...context, tab:'goal', preview:true, rendered });
  if (running.has(task.status)) {
    return [...activeStep(task), ...commandEntry(task, context), ...timelineEntry(task.events, true), ...goal()];
  }
  if (task.status === 'review' || task.status === 'done') return [...deliveryResult(task), ...recordLink(task, context)];
  if (interrupted.has(task.status)) return [...interruption(task), ...commandEntry(task, context), ...recordLink(task, context)];
  if (task.status === 'queued') return [...queuedEntries(task, context), ...goal(true)];
  return [
    ...(hasText(task.current) ? [['current', task.current, value => {
      const root = section('任务状态');
      root.append(el('p', value, 'step-text'));
      return root;
    }]] : []),
    ...recordLink(task, context),
    ...goal(),
  ];
}

function diagnosticField([label, value, type]) {
  const row = el('div');
  const description = el('dd');
  const text = type === 'time' ? time(value, 'exact') : el(type === 'raw' ? 'code' : 'span', value);
  description.append(text);
  if (type === 'raw') description.append(copyButton(value, label));
  row.append(el('dt', label), description);
  return row;
}

function patchFields(list, values) {
  patch(list, values.filter(([, value]) => value != null && value !== '')
    .map(data => [data[0], data, diagnosticField]));
}

export function diagnosticEntries(task, { onSelect }) {
  const completed = task.status === 'done' && task.events?.findLast(event => event.kind === 'accepted')?.time;
  const entries = [];
  const values = [
    ['任务 ID', task.id, 'raw'], ['线程 ID', task.threadId, 'raw'], ['轮次 ID', task.turnId, 'raw'],
    ['完整模型 ID', task.model, 'raw'], ['工作目录', task.cwd, 'raw'],
    ['创建时间', task.created, 'time'], ['更新时间', task.updated, 'time'], ['完成时间', completed || '', 'time'],
    ['任务模式', modeLabel(task)], ['沙盒模式', task.sandbox, 'raw'], ['审批策略', task.approvalPolicy, 'raw'],
    ['目录写锁', task.holdsWriteLock ? '持有' : '未持有'],
  ];
  if (task.kind === 'discussion') values.push(['讨论控制权', task.awaitingDelegate ? '等待子代理认领'
    : task.delegateOrigin ? '子代理代聊' : '主对话']);
  entries.push(['metadata', values, data => {
    const root = section('任务信息');
    const list = el('dl', null, 'diagnostic-list');
    patchFields(list, data);
    root.append(list);
    return root;
  }, (root, data) => patchFields(root.querySelector('dl'), data)]);
  if (task.upstreams?.length || task.downstreams?.length) {
    entries.push(['dependencies', [task.upstreams, task.downstreams], ([before, after]) => {
      const root = section('依赖关系');
      for (const [label, refs] of [['前置任务', before], ['后续任务', after]]) {
        if (!refs?.length) continue;
        root.append(el('h4', label), taskLinks(refs, onSelect));
      }
      return root;
    }]);
  }
  if (task.delivery || task.noticeId || task.deliveryError) {
    entries.push(['delivery', [task.delivery, task.noticeId, task.deliveryError], ([delivery, noticeId, error]) => {
      const root = section('投递诊断');
      const list = el('dl', null, 'diagnostic-list');
      patchFields(list, [['唤醒通知', deliveryLabels[delivery] || delivery], ['通知 ID', noticeId, 'raw']]);
      if (list.childElementCount) root.append(list);
      if (error) root.append(deliveryDiagnostic(error));
      return root;
    }]);
  }
  return entries;
}

export { interruption };
