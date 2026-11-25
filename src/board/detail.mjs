import {
  $, button, copyButton, el, modelBadge, patch, permissionBadge, running, setText, stateBadge, time,
} from './ui.mjs';
import { diagnosticEntries, goalEntry, overviewEntries, recordEntries } from './content.mjs';
import { discussionEntries } from './discussion.mjs';

const tabsFor = {
  execution: [['overview', '概览'], ['goal', '目标'], ['records', '执行记录'], ['diagnostic', '详细信息']],
  discussion: [['discussion', '讨论'], ['consensus', '共识与方案'], ['issue', '议题'], ['process', '详情与过程']],
};
const difficulty = { simple:'简单', browser:'浏览器操作', standard:'常规', complex:'常规', hard:'复杂', exceptional:'极高' };
const endStates = new Set(['done', 'cancelled']);

function shortPath(value) {
  if (value.length <= 36) return value;
  return '…/' + value.split('/').filter(Boolean).slice(-2).join('/');
}

function showHeader(task, group, canOpenGraph, onOpenGraph) {
  $('task-head').hidden = !task;
  if (!task) return;
  setText($('task-title'), task.title);
  $('task-title').title = task.title;
  const badges = [['status', [task.status, task.kind], () => stateBadge(task)]];
  if (group) badges.push(['group', [group, task.id, canOpenGraph], ([label, id, clickable]) => {
    const badge = clickable ? button(label, 'group-badge') : el('span', label, 'group-badge');
    badge.title = clickable ? `查看依赖图 · ${label}` : label;
    if (clickable) {
      badge.setAttribute('aria-controls', 'graphs');
      badge.onclick = () => onOpenGraph(id);
    }
    return badge;
  }]);
  patch($('task-badges'), badges);
  const fields = [];
  if (task.model) fields.push(['model', [task.model, task.effort], () => modelBadge(task)]);
  fields.push(['permission', [task.mode, task.sandbox, task.approvalPolicy], () => permissionBadge(task)]);
  if (task.kind === 'discussion' || task.difficulty) {
    fields.push(['kind', task.kind === 'discussion' ? '科研讨论' : difficulty[task.difficulty] || task.difficulty,
      label => el('span', label, 'meta-item')]);
  }
  if (task.holdsWriteLock) fields.push(['lock', true, () => el('span', '持有写锁', 'lock-label')]);
  if (task.updated) fields.push(['updated', task.updated, date => {
    const update = el('span', null, 'meta-item meta-updated');
    const wide = el('span', '更新 ', 'meta-wide');
    wide.append(time(date, 'short'));
    const short = time(date, 'minutes');
    short.className = 'meta-short';
    update.title = '更新时间 ' + date;
    update.append(wide, short);
    return update;
  }]);
  if (task.cwd) fields.push(['cwd', task.cwd, value => {
    const path = el('span', null, 'meta-path');
    const code = el('code', shortPath(value));
    code.title = value;
    path.append(code, copyButton(value, '工作目录'));
    return path;
  }]);
  patch($('task-meta'), fields);
}

function captureAnchor(scroll) {
  if (scroll.scrollTop < 1) return null;
  const top = scroll.getBoundingClientRect().top + 8;
  let anchor, distance = Infinity;
  for (const node of scroll.querySelectorAll('[data-scroll-anchor]')) {
    if (node.parentElement.closest('details:not([open])')) continue;
    const box = node.getBoundingClientRect();
    if (box.bottom <= top || box.top > top + scroll.clientHeight) continue;
    const d = box.top <= top ? top - box.top : scroll.clientHeight + box.top - top;
    if (d <= distance) {
      distance = d;
      anchor = { node, top:box.top };
    }
  }
  return anchor;
}

function preserveScroll(scroll, previous, anchor) {
  if (anchor?.node.isConnected && !anchor.node.parentElement.closest('details:not([open])')) {
    scroll.scrollTop += anchor.node.getBoundingClientRect().top - anchor.top;
  } else scroll.scrollTop = previous;
}

export function createDetail({ onSelect, onOpenGraph }) {
  const scroll = $('detail-scroll');
  const panel = $('detail-content');
  const tabs = $('tabs');
  const activity = $('new-activity');
  const views = new Map();
  const lastTabs = new Map();
  let current = {};
  let tab, viewKey, state, ready, rendered, marker, wasLive, deferred;

  const nearBottom = () => scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 48;
  function updateActivity() {
    if (ready && state && nearBottom()) state.unread = false;
    activity.hidden = !state?.unread || !ready;
  }
  scroll.addEventListener('scroll', updateActivity, { passive:true });
  activity.onclick = () => {
    state.unread = false;
    activity.hidden = true;
    scroll.scrollTop = scroll.scrollHeight;
  };

  function showTab(id) {
    if (id === tab) return;
    lastTabs.set(current.id, id);
    paint();
  }

  function paintTabs(options, active) {
    tabs.hidden = !options.length;
    panel.setAttribute('role', 'tabpanel');
    patch(tabs, options.map(([key, label]) => [key, label, name => {
      const control = button(name, 'tab');
      control.id = 'tab-' + key;
      control.dataset.tab = key;
      control.setAttribute('role', 'tab');
      control.setAttribute('aria-controls', panel.id);
      control.onclick = () => showTab(key);
      return control;
    }]));
    for (const control of tabs.children) {
      const selected = control.dataset.tab === active;
      control.setAttribute('aria-selected', String(selected));
      control.tabIndex = selected ? 0 : -1;
    }
    if (active) panel.setAttribute('aria-labelledby', 'tab-' + active);
    else panel.removeAttribute('aria-labelledby');
  }

  tabs.onkeydown = event => {
    const controls = [...tabs.children];
    const index = controls.indexOf(event.target);
    const count = controls.length;
    if (index < 0) return;
    const target = ({
      ArrowLeft:(index - 1 + count) % count, ArrowRight:(index + 1) % count, Home:0, End:count - 1,
    })[event.key];
    if (target == null) return;
    event.preventDefault();
    controls[target].click();
    controls[target].focus({ preventScroll:true });
  };

  function viewEntries(task) {
    const context = { onSelect, showTab, state };
    if (tab === 'overview') return overviewEntries(task, context);
    if (tab === 'goal' || tab === 'issue') {
      return goalEntry(task.goal, { ...context, tab, discussion:tab === 'issue' });
    }
    if (tab === 'records') return recordEntries(task, context);
    if (tab === 'discussion' || tab === 'consensus') return discussionEntries(task, tab, context);
    const diagnostics = diagnosticEntries(task, context);
    return tab === 'process' ? [...diagnostics, ...recordEntries(task, context)] : diagnostics;
  }

  function hasSelection(container) {
    const selection = document.getSelection();
    return selection && !selection.isCollapsed && selection.rangeCount && selection.getRangeAt(0).intersectsNode(container);
  }

  function paint() {
    const { id, task, group, canOpenGraph, pending } = current;
    const options = id ? tabsFor[task?.kind === 'discussion' ? 'discussion' : 'execution'] : [];
    const last = lastTabs.get(id);
    const active = options.some(([key]) => last === key) ? last : options[0]?.[0];
    const key = JSON.stringify([id, active]);
    const switched = viewKey !== key;
    if (switched) {
      if (ready) state.top = scroll.scrollTop;
      if (!views.has(key)) views.set(key, {
        top:0, unread:false, outputs:new Map(), rounds:new Map(), discussionMode:'recent',
      });
      state = views.get(key);
      viewKey = key;
      tab = active;
      ready = false;
      rendered = marker = wasLive = undefined;
      patch(panel, []);
      paintTabs(options, tab);
    }

    const readingHeader = !switched && hasSelection($('task-head'));
    if (!readingHeader) showHeader(task, group, canOpenGraph, onOpenGraph);
    deferred = readingHeader;
    if (!task || pending) {
      if (ready) state.top = scroll.scrollTop;
      ready = false;
      rendered = marker = wasLive = undefined;
      const message = pending ? '正在读取任务详情…' : id ? '这项任务的详情已不可用。' : '从任务列表选择一项任务。';
      patch(panel, [['placeholder', message, text => el('p', text, 'empty-note')]]);
      updateActivity();
      return;
    }

    const snapshot = JSON.stringify(task);
    if (rendered === snapshot) return;
    if (!switched && hasSelection(panel)) {
      deferred = true;
      return;
    }
    const previous = scroll.scrollTop;
    const atTail = nearBottom();
    const anchor = ready ? captureAnchor(scroll) : null;
    const live = tab === 'discussion' ? !endStates.has(task.status) :
      (tab === 'records' || tab === 'process') && running.has(task.status);
    const nextMarker = JSON.stringify(tab === 'discussion' ? task.discussion
      : ['records', 'process'].includes(tab) ? [task.events, task.command?.output, task.command?.code] : null);
    const changed = ready && (live || wasLive) && marker !== nextMarker;
    if (changed && tab === 'discussion' && !atTail) {
      const round = anchor?.node.closest('.round');
      if (round?.open) state.rounds.set(round.dataset.roundKey, true);
    }
    const entries = viewEntries(task);
    patch(panel, entries.length ? entries : [['empty', tab, () => el('p', '暂无记录。', 'empty-note')]]);
    if (!ready) scroll.scrollTop = state.top;
    else if (changed && atTail) scroll.scrollTop = scroll.scrollHeight;
    else {
      preserveScroll(scroll, previous, anchor);
      if (changed) state.unread = true;
    }
    rendered = snapshot;
    marker = nextMarker;
    wasLive = live;
    ready = true;
    updateActivity();
  }

  document.addEventListener('selectionchange', () => {
    if (deferred && !hasSelection(panel) && !hasSelection($('task-head'))) paint();
  });

  return {
    render(value) {
      current = value;
      paint();
    },
    focusHeading: () => ($('task-head').hidden ? scroll : $('task-title')).focus({ preventScroll:true }),
  };
}
