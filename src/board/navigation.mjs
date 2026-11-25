import {
  $, attention, button, el, modelBadge, modelName, patch, permissionBadge, plainPreview, queueText, readSetting, running,
  setText, stateBadge, statusLabel, taskLabel, writeSetting,
} from './ui.mjs';

const ranks = ['blocked', 'waiting_user', 'host', 'running', 'starting', 'stopping', 'review', 'queued', 'done', 'cancelled'];
const rank = task => {
  const index = ranks.indexOf(task.status);
  return index === -1 ? ranks.length : index;
};
export const orderTasks = tasks => [...tasks].sort((a, b) => rank(a) - rank(b));

export function matches(task, { query, filter }) {
  if (filter === 'active' && !running.has(task.status) && task.status !== 'queued') return false;
  if (filter === 'attention' && !attention.has(task.status)) return false;
  if (filter === 'done' && task.status !== 'done') return false;
  const text = [task.title, task.nodeLabel, task.model, modelName(task.model), task.effort, task.cwd].join(' ').toLowerCase();
  return query.every(word => text.includes(word));
}

function taskRow(task, onSelect) {
  const row = button(null, 'task');
  row.dataset.taskId = task.id;
  row.onclick = () => onSelect(task.id);
  const title = el('strong');
  const light = el('span', null, 'task-light');
  const line = el('span', null, 'task-line');
  line.append(title, light);
  const model = el('span', null, 'task-model');
  row.append(line, model, el('span', null, 'task-preview'));
  updateTaskRow(row, task);
  return row;
}

function updateTaskRow(row, task) {
  const title = task.title || taskLabel(task);
  setText(row.querySelector('strong'), title);
  row.title = title;
  const light = row.querySelector('.task-light');
  if (light.firstElementChild?.title !== statusLabel(task)) light.replaceChildren(stateBadge(task, true));
  patch(row.querySelector('.task-model'), [
    ['model', [task.model, task.effort], () => modelBadge(task)],
    ['permission', [task.mode, task.sandbox, task.approvalPolicy], () => permissionBadge(task)],
  ]);
  const preview = row.querySelector('.task-preview');
  setText(preview, plainPreview(queueText(task) || task.current));
  preview.classList.toggle('queue-note', !!task.waitInfo);
  preview.hidden = !preview.textContent;
}

export function createNavigation({ onSelect, onCriteriaChange }) {
  const app = $('app');
  const workspace = $('workspace');
  const scroll = $('list-scroll');
  const filterBar = $('filters');
  const search = $('search');
  const compact = matchMedia('(max-width: 639px)');
  let filter = 'all';
  let visibleBeforeSwitch = 0;
  const groups = ['active', 'done', 'cancelled'].map(id => {
    const node = $(`${id}-group`);
    let saved = readSetting(`fold.${id}`, false);
    let forced = false;
    if (node.localName === 'details') {
      node.open = saved;
      node.querySelector('summary').onclick = event => {
        event.preventDefault();
        node.open = !node.open;
        if (!forced) {
          saved = node.open;
          writeSetting(`fold.${id}`, saved);
        }
      };
    }
    return {
      id, node, list:$(`${id}-list`), count:$(`${id}-count`),
      setForced(value) {
        if (node.localName !== 'details' || value === forced) return;
        forced = value;
        node.open = forced || saved;
      },
    };
  });
  const criteria = () => ({
    query:search.value.toLowerCase().trim().split(/\s+/).filter(Boolean), filter,
  });
  search.oninput = () => { scroll.scrollTop = 0; onCriteriaChange(criteria()); };
  filterBar.onclick = event => {
    const chip = event.target.closest('[data-filter]');
    if (!chip || filter === chip.dataset.filter) return;
    filter = chip.dataset.filter;
    for (const other of filterBar.children) other.setAttribute('aria-pressed', String(chip === other));
    scroll.scrollTop = 0;
    onCriteriaChange(criteria());
  };

  function mobileView(view, focus = false) {
    if (!compact.matches || app.dataset.mobile === view) return;
    if (app.dataset.mobile === 'nav') visibleBeforeSwitch = scroll.scrollTop;
    app.dataset.mobile = view;
    $('mobile-nav').setAttribute('aria-expanded', String(view === 'nav'));
    setText($('mobile-nav'), view === 'nav' ? '返回详情' : '任务列表');
    if (view === 'nav') {
      scroll.scrollTop = visibleBeforeSwitch;
      if (focus) search.focus({ preventScroll:true });
    }
  }
  $('mobile-nav').onclick = () => mobileView(app.dataset.mobile === 'nav' ? 'detail' : 'nav', true);
  setupSplitter(workspace);

  function select(id) {
    for (const row of scroll.querySelectorAll('[data-task-id]')) {
      row.setAttribute('aria-pressed', String(row.dataset.taskId === id));
    }
  }

  function render({ tasks, total, offset, limit, selected, filtered, scanning, scanFailed }) {
    const items = orderTasks(filtered || tasks);
    const grouped = { active:[], done:[], cancelled:[] };
    for (const task of items) {
      const group = ['done', 'cancelled'].includes(task.status) ? task.status : 'active';
      grouped[group].push(task);
    }
    const oldTop = scroll.scrollTop;
    for (const group of groups) {
      const entries = grouped[group.id];
      group.node.hidden = !entries.length;
      group.setForced(!!filtered && !!entries.length);
      setText(group.count, `· ${entries.length}`);
      patch(group.list, entries.map(({ id, title, nodeLabel, status, kind, model, effort, mode, sandbox, approvalPolicy, current, waitInfo }) => [
        id, { id, title, nodeLabel, status, kind, model, effort, mode, sandbox, approvalPolicy, current, waitInfo },
        value => taskRow(value, onSelect), updateTaskRow,
      ]));
    }
    if (oldTop) scroll.scrollTop = oldTop;
    select(selected);
    setText($('count'), scanFailed ? '筛选暂未完成' : scanning ? '正在筛选…' : filtered ? `${items.length} / ${total} 项` : `${total} 项`);
    const empty = $('list-empty');
    empty.hidden = !!items.length;
    setText(empty, scanFailed ? '读取其他页失败，正在重试。' : scanning ? '正在读取其他页的任务…'
      : total ? '没有匹配的任务。' : '还没有任务。');
    $('pager').hidden = !!filtered || total <= limit;
    $('prev').disabled = !offset;
    $('next').disabled = offset + limit >= total;
    setText($('page'), `${Math.floor(offset / limit) + 1} / ${Math.max(1, Math.ceil(total / limit))}`);
  }

  return { render, select, showDetail: () => mobileView('detail') };
}

function setupSplitter(workspace) {
  const splitter = $('splitter');
  const minimum = 220;
  const detailMinimum = 320;
  const defaultRatio = 0.3;
  let ratio = readSetting('sidebar-ratio', defaultRatio);
  if (!Number.isFinite(ratio)) ratio = defaultRatio;
  let drag, frame, pending;

  const bounds = () => {
    const width = workspace.clientWidth;
    return [width, Math.max(minimum, Math.min(width * .55, width - detailMinimum - splitter.offsetWidth))];
  };

  function apply() {
    const [width, max] = bounds();
    if (!width || !splitter.offsetWidth) return;
    workspace.style.setProperty('--nav-width', `${ratio * 100}%`);
    splitter.setAttribute('aria-valuemin', Math.round(minimum / width * 100));
    splitter.setAttribute('aria-valuemax', Math.round(max / width * 100));
    splitter.setAttribute('aria-valuenow', Math.round(Math.max(minimum, Math.min(max, width * ratio)) / width * 100));
  }

  function resize(pixels, persist = false) {
    const [width, max] = bounds();
    ratio = Math.max(minimum, Math.min(max, pixels)) / width;
    apply();
    if (persist) writeSetting('sidebar-ratio', ratio);
  }

  splitter.onpointerdown = event => {
    if (event.button !== 0 || drag) return;
    drag = { id:event.pointerId, start:event.clientX, width:$('task-nav').getBoundingClientRect().width };
    pending = undefined;
    splitter.setPointerCapture(event.pointerId);
    workspace.classList.add('resizing');
  };
  splitter.onpointermove = event => {
    if (event.pointerId !== drag?.id) return;
    pending = drag.width + event.clientX - drag.start;
    if (!frame) frame = requestAnimationFrame(() => {
      resize(pending);
      frame = undefined;
    });
  };
  function finish(event) {
    if (event.pointerId !== drag?.id) return;
    if (frame) cancelAnimationFrame(frame);
    if (pending != null) resize(pending, true);
    drag = frame = pending = undefined;
    workspace.classList.remove('resizing');
  }
  splitter.onpointerup = splitter.onpointercancel = splitter.onlostpointercapture = finish;
  splitter.ondblclick = () => {
    ratio = defaultRatio;
    apply();
    writeSetting('sidebar-ratio', ratio);
  };
  splitter.onkeydown = event => {
    const step = event.shiftKey ? 32 : 16;
    const width = $('task-nav').getBoundingClientRect().width;
    const target = { ArrowLeft:width-step, ArrowRight:width+step, Home:minimum, End:bounds()[1] }[event.key];
    if (target == null) return;
    event.preventDefault();
    resize(target, true);
  };
  new ResizeObserver(apply).observe(workspace);
  apply();
}
