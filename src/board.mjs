import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import 'temml/dist/Temml-Local.css';
import './board/board.css';
import { $, graphName, setText } from './board/ui.mjs';
import { createNavigation, orderTasks } from './board/navigation.mjs';
import { createDetail } from './board/detail.mjs';
import { createGraph } from './board/graph.mjs';
import { version } from './version.mjs';

const app = new App({ name:'Codex 任务', version }, {});
const limit = 30;
const maxDiscussionLimit = 100;
let selected, offset = 0, connected = false, generation = 0, poll;
let board, taskIndex = new Map(), groups = new Map(), frame, queued;
const details = new Map();
const discussionWindows = new Map();
let criteria = { query:'', filter:'all', workspace:'' };

const nav = createNavigation({ onSelect:selectTask, onCriteriaChange:filterTasks });
const graph = createGraph({ onSelect:selectTask, showDetail:nav.showDetail, onExpansionChange:restart });
const detail = createDetail({ onSelect:selectTask, onOpenGraph:id => selectTask(id, true), onDiscussionWindow:changeDiscussionWindow });
const filtered = () => !!(criteria.query || criteria.workspace || criteria.filter !== 'all');

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
  if (value.query === criteria.query && value.filter === criteria.filter && value.workspace === criteria.workspace) return;
  criteria = value;
  offset = 0;
  selected = undefined;
  restart();
}

function showSelected(loading) {
  const task = details.get(selected) || (loading ? taskIndex.get(selected) : undefined);
  detail.render({
    id:selected, task, group:groups.get(selected) || task?.graphTitle || task?.graphId,
    canOpenGraph:!!task?.graphId,
    pending:!!selected && loading && !details.has(selected),
  });
}

function selectTask(id, openGraph = false) {
  const changed = selected !== id;
  selected = id;
  nav.showDetail();
  nav.select(id);
  const wasExpanded = graph.expanded;
  graph.select(id, openGraph);
  if (changed) showSelected(true);
  if (changed || wasExpanded !== graph.expanded) restart();
  if (!openGraph && matchMedia('(max-width: 639px)').matches) requestAnimationFrame(detail.focusHeading);
}

function changeDiscussionWindow(task, latest) {
  if (task.id !== selected) return;
  const size = task.discussion.length;
  const discussionLimit = Math.min(maxDiscussionLimit, Math.max(size * 2, task.discussionTotal || 0));
  const discussionOffset = latest || size < maxDiscussionLimit ? 0 : (task.discussionOffset || 0) + task.discussion.length;
  const previous = discussionWindows.get(selected);
  if (previous?.discussionLimit === discussionLimit && previous.discussionOffset === discussionOffset) return;
  discussionWindows.set(selected, { discussionLimit, discussionOffset });
  restart();
}

function receive(data, answeredSelection) {
  if (data.offline) {
    showError(data.offline);
    return;
  }
  board = data;
  taskIndex = new Map();
  groups = new Map();
  for (const g of data.graphs || []) {
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
    if (details.size > 16) {
      const evicted = details.keys().next().value;
      details.delete(evicted);
      discussionWindows.delete(evicted);
    }
  } else if (selected && answeredSelection === selected) details.delete(selected);
  showError('');
  nav.render({ ...data, limit, selected, filtered:filtered() });
  graph.render(data.graphs || [], data.hasGraphs ?? !!data.graphs?.length, selected);
  showSelected(answeredSelection !== selected);
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
      const args = { offset, limit, ...criteria, includeGraphs:graph.expanded };
      if (requestedId) Object.assign(args, { selected:requestedId }, discussionWindows.get(requestedId));
      if (revision) args.revision = revision;
      const data = await readBoard(args, poll.signal);
      if (token !== generation) return;
      const total = data.filteredTotal ?? data.total;
      if (offset && offset >= total) {
        offset = Math.max(0, Math.floor((total - 1) / limit) * limit);
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
  if (data.offline) { showError(data.offline); return; }
  if (!data.tasks) return;
  if (!selected && data.tasks.length) selected = orderTasks(data.tasks)[0].id;
  receive({ ...data, tasks:data.tasks.slice(0, limit) });
  if (connected) restart();
};
app.onhostcontextchanged = theme;
document.addEventListener('visibilitychange', restart);
window.addEventListener('pagehide', () => {
  generation++;
  poll?.abort();
});
window.addEventListener('pageshow', event => { if (event.persisted) restart(); });
app.connect().then(() => {
  connected = true;
  theme(app.getHostContext());
  restart();
}).catch(error => showError(error.message));
