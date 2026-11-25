import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import 'temml/dist/Temml-Local.css';
import './board/board.css';
import { $, graphName, setText } from './board/ui.mjs';
import { createNavigation, matches, orderTasks } from './board/navigation.mjs';
import { createDetail } from './board/detail.mjs';
import { createGraph } from './board/graph.mjs';

const app = new App({ name:'Codex 任务', version:'0.1.2' }, {});
const limit = 30;
let selected, offset = 0, connected = false, generation = 0, poll;
let board, taskIndex = new Map(), groups = new Map(), frame, queued;
const details = new Map();
let criteria = { query:[], filter:'all' };
let searchCache, scan, scanTimer, scanFailed = false;

const nav = createNavigation({ onSelect:selectTask, onCriteriaChange:filterTasks });
const graph = createGraph({ onSelect:selectTask, showDetail:nav.showDetail });
const detail = createDetail({ onSelect:selectTask, onOpenGraph:id => selectTask(id, true) });
const filtered = () => criteria.query.length || criteria.filter !== 'all';

function showError(message) {
  setText($('error'), message || '');
  $('error').hidden = !message;
}

async function readBoard(args, signal) {
  const response = await app.callServerTool({ name:'relay_board_changes', arguments:args }, { signal, timeout:35000 });
  if (response.isError || !response.structuredContent) {
    throw Error(response.content?.[0]?.text || '任务进程未返回视图。');
  }
  if (response.structuredContent.offline) throw Error(response.structuredContent.offline);
  return response.structuredContent;
}

function filterTasks(value) {
  criteria = value;
  if (!filtered()) stopScan();
  paintList();
  scheduleScan();
}

function paintList() {
  if (!board) return;
  let found;
  if (filtered()) {
    const available = new Map((searchCache?.tasks || []).map(task => [task.id, task]));
    for (const task of board.tasks) available.set(task.id, task);
    if (board.selected) available.set(board.selected.id, board.selected);
    found = [...available.values()].filter(task => matches(task, criteria));
  }
  const scanning = !!found && board.total > limit && !searchCache;
  nav.render({
    tasks:board.tasks, total:board.total, offset:board.offset, limit, selected, filtered:found,
    scanning:scanning && !scanFailed, scanFailed:scanning && scanFailed,
  });
}

function stopScan() {
  clearTimeout(scanTimer);
  scanTimer = undefined;
  scan?.abort();
  scan = undefined;
  scanFailed = false;
}

function scheduleScan() {
  if (!connected || document.hidden || !filtered() || !board || board.total <= limit || scan || scanTimer
    || searchCache?.revision === board.revision) return;
  scanTimer = setTimeout(scanPages, scanFailed ? 1800 : searchCache ? 850 : 140);
}

async function scanPages() {
  scanTimer = undefined;
  const snapshot = board;
  const controller = new AbortController();
  scan = controller;
  try {
    const tasks = new Map();
    for (let start = 0; start < snapshot.total; start += limit) {
      const page = start === snapshot.offset && snapshot.tasks.length <= limit
        ? snapshot : await readBoard({ offset:start, limit }, controller.signal);
      for (const task of page.tasks) tasks.set(task.id, task);
    }
    if (scan !== controller) return;
    searchCache = { revision:snapshot.revision, tasks:[...tasks.values()] };
    scanFailed = false;
  } catch {
    if (scan !== controller) return;
    scanFailed = true;
  } finally {
    if (scan === controller) {
      scan = undefined;
      paintList();
      scheduleScan();
    }
  }
}

function showSelected(loading) {
  const task = details.get(selected) || (loading
    ? taskIndex.get(selected) || searchCache?.tasks.find(item => item.id === selected) : undefined);
  detail.render({
    id:selected, task, group:groups.get(selected) || task?.graphTitle || task?.graphId,
    canOpenGraph:groups.has(selected),
    pending:!!selected && loading && !details.has(selected),
  });
}

function selectTask(id, openGraph = false) {
  const changed = selected !== id;
  selected = id;
  nav.showDetail();
  nav.select(id);
  graph.select(id, openGraph);
  if (changed) {
    showSelected(true);
    restart();
  }
  if (!openGraph && matchMedia('(max-width: 639px)').matches) requestAnimationFrame(detail.focusHeading);
}

function receive(data, answeredSelection) {
  if (data.offline) {
    showError(data.offline);
    return;
  }
  board = data;
  taskIndex = new Map();
  groups = new Map();
  for (const g of data.graphs) {
    for (const task of g.nodes) {
      taskIndex.set(task.id, task);
      groups.set(task.id, graphName(g));
    }
    for (const task of g.externalNodes || []) if (!taskIndex.has(task.id)) taskIndex.set(task.id, task);
  }
  for (const task of data.tasks) taskIndex.set(task.id, task);
  if (data.selected?.id === selected && data.selected) {
    details.delete(selected);
    details.set(selected, data.selected);
    if (details.size > 16) details.delete(details.keys().next().value);
  } else if (selected && answeredSelection === selected) details.delete(selected);
  if (board.total <= limit) searchCache = undefined;

  showError('');
  paintList();
  graph.render(data.graphs, selected);
  showSelected(answeredSelection !== selected);
  scheduleScan();
}

function queueBoard(data, token, requestedId) {
  queued = { data, token, requestedId };
  if (!frame) frame = requestAnimationFrame(() => {
    frame = undefined;
    if (queued.token === generation) receive(queued.data, queued.requestedId);
  });
}

function restart() {
  generation++;
  poll?.abort();
  if (connected && !document.hidden) void follow(generation);
}

async function follow(token) {
  let revision;
  while (token === generation && !document.hidden) {
    try {
      poll = new AbortController();
      const requestedId = selected;
      const args = { offset, limit };
      if (requestedId) args.selected = requestedId;
      if (revision) args.revision = revision;
      const data = await readBoard(args, poll.signal);
      if (token !== generation) return;
      if (offset && offset >= data.total) {
        offset = Math.max(0, Math.floor((data.total - 1) / limit) * limit);
        selected = undefined;
        revision = undefined;
        continue;
      }
      if (!selected && data.tasks.length) {
        selected = orderTasks(data.tasks)[0].id;
        queueBoard(data, token, requestedId);
        continue;
      }
      if (data.revision !== revision) queueBoard(data, token, requestedId);
      else showError('');
      revision = data.revision;
    } catch (error) {
      if (token !== generation) return;
      showError(error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
      revision = undefined;
    }
  }
}

function pageBy(step) {
  offset = Math.max(0, offset + step * limit);
  selected = undefined;
  $('list-scroll').scrollTop = 0;
  restart();
}

function theme(context) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}

$('prev').onclick = () => pageBy(-1);
$('next').onclick = () => pageBy(1);
$('detail-content').addEventListener('click', event => {
  const link = event.target.closest?.('.prose a[href]');
  if (!link || event.defaultPrevented || !app.getHostCapabilities()?.openLinks) return;
  event.preventDefault();
  void app.openLink({ url:link.href }, { timeout:8000 }).then(result => {
    if (result.isError) showError('宿主未打开该链接。');
  }).catch(() => showError('宿主未打开该链接。'));
});
app.ontoolresult = response => {
  const data = response.structuredContent;
  if (!data || board) return;
  if (!selected && data.tasks?.length) selected = orderTasks(data.tasks)[0].id;
  receive(data.tasks ? { ...data, tasks:data.tasks.slice(0, limit) } : data);
  if (connected) restart();
};
app.onhostcontextchanged = theme;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopScan();
  restart();
  if (!document.hidden) scheduleScan();
});
window.addEventListener('pagehide', () => {
  generation++;
  poll?.abort();
  stopScan();
});
window.addEventListener('pageshow', event => { if (event.persisted) restart(); });
app.connect().then(() => {
  connected = true;
  theme(app.getHostContext());
  restart();
}).catch(error => showError(error.message));
