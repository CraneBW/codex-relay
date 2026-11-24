import {
  $, button, el, graphKey, graphName, modeLabel, modelBadge, patch, plainPreview, queueText, stateBadge, taskLabel,
} from './ui.mjs';

function graphLayers(graph) {
  const external = graph.externalNodes || [];
  const nodes = [...external, ...graph.nodes];
  const ids = new Set(nodes.map(node => node.id));
  const parents = new Map(graph.nodes.map(node => [node.id, (node.dependsOn || []).filter(id => ids.has(id))]));
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  const incoming = new Map(nodes.map(node => [node.id, parents.get(node.id)?.length || 0]));
  for (const node of graph.nodes) {
    for (const parent of parents.get(node.id)) outgoing.get(parent).push(node);
  }
  const layers = [];
  const placed = new Set();
  let ready = nodes.filter(node => !incoming.get(node.id));
  while (ready.length) {
    layers.push(ready);
    const next = [];
    for (const node of ready) {
      placed.add(node.id);
      for (const child of outgoing.get(node.id)) {
        const count = incoming.get(child.id) - 1;
        incoming.set(child.id, count);
        if (!count) next.push(child);
      }
    }
    ready = next;
  }
  if (placed.size !== nodes.length) layers.push(nodes.filter(node => !placed.has(node.id)));
  return { layers, parents, external:new Set(external.map(node => node.id)) };
}

function svg(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function marker(id, tone) {
  const node = svg('marker', { id, viewBox:'0 0 8 8', refX:7, refY:4, markerWidth:8,
    markerHeight:8, markerUnits:'userSpaceOnUse', orient:'auto' });
  node.append(svg('path', { d:'M0 0 L8 4 L0 8 Z', class:tone }));
  return node;
}

function graphNode({ task, external }, onSelect) {
  const node = button(null, 'graph-node');
  node.dataset.taskId = task.id;
  node.onclick = () => onSelect(task.id);
  updateNode(node, { task, external });
  return node;
}

function updateNode(node, { task, external }) {
  node.classList.toggle('external', external);
  const heading = el('strong', taskLabel(task));
  const flags = el('span', null, 'graph-flags');
  flags.append(stateBadge(task), el('span', modeLabel(task), 'graph-mode'));
  if (task.holdsWriteLock) flags.append(el('span', '持有写锁', 'lock-label'));
  if (external) flags.append(el('span', '图外上游', 'graph-mode'));
  const waiting = queueText(task);
  const progress = waiting || plainPreview(task.current, 100);
  node.title = [taskLabel(task), progress].filter(Boolean).join('\n');
  node.replaceChildren(heading, modelBadge(task), flags, el('small', progress, waiting ? 'queue-note' : ''));
}

function nodeView({ id, title, nodeLabel, kind, status, model, effort, mode, holdsWriteLock, current, waitInfo }) {
  return { id, title, nodeLabel, kind, status, model, effort, mode, holdsWriteLock, current, waitInfo };
}

function edgePath(from, to, frame, lock) {
  const centerX = box => box.left - frame.left + box.width / 2;
  if (lock && Math.abs(from.top - to.top) < 8) {
    const left = from.left < to.left;
    const x = (left ? from.right + 1 : from.left - 1) - frame.left;
    const end = (left ? to.left - 2 : to.right + 2) - frame.left;
    const y = from.top - frame.top + from.height / 2;
    const target = to.top - frame.top + to.height / 2;
    const mid = (x + end) / 2;
    return `M${x} ${y} C${mid} ${y} ${mid} ${target} ${end} ${target}`;
  }
  const x = centerX(from), endX = centerX(to);
  const down = from.top <= to.top;
  const y = (down ? from.bottom + 1 : from.top - 1) - frame.top;
  const endY = (down ? to.top - 2 : to.bottom + 2) - frame.top;
  const mid = (y + endY) / 2;
  return `M${x} ${y} C${x} ${mid} ${endX} ${mid} ${endX} ${endY}`;
}

export function createGraph({ onSelect, showDetail }) {
  const toggle = $('graph-toggle');
  const section = $('graphs');
  const picker = $('graph-select');
  const scroll = $('graph-scroll');
  const canvas = $('graph-canvas');
  const edges = svg('svg', { class:'graph-edges', 'aria-hidden':'true' });
  const defs = svg('defs', {});
  defs.append(marker('dependency-arrow', 'dependency-arrow'), marker('lock-arrow', 'lock-arrow'));
  const paths = svg('g', {});
  edges.append(defs, paths);
  canvas.prepend(edges);
  const rows = el('div', null, 'graph-rows');
  canvas.append(rows);

  const positions = new Map();
  let graphs = [], activeGraph, renderedGraph, selected, expanded = false, visible, frame;

  function scheduleEdges() {
    if (frame || section.hidden) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (section.hidden || !visible) return;
      const canvasBox = canvas.getBoundingClientRect();
      const boxes = new Map([...rows.querySelectorAll('button')].map(node => [node.dataset.taskId, node.getBoundingClientRect()]));
      const entries = [];
      function addEdge(from, to, lock) {
        if (!boxes.has(from) || !boxes.has(to) || from === to) return;
        const path = edgePath(boxes.get(from), boxes.get(to), canvasBox, lock);
        const tone = lock ? 'lock' : 'dependency';
        entries.push([JSON.stringify([from, to, tone]), [path, tone], ([d, type]) => svg('path', {
          d, class:`${type}-edge`, 'marker-end':`url(#${type}-arrow)`,
        })]);
      }
      for (const [to, parents] of visible.parents) for (const from of parents) addEdge(from, to, false);
      for (const layer of visible.layers) {
        for (const task of layer) {
          if (task.waitInfo?.kind === 'write_lock') {
            for (const owner of task.waitInfo.blockers || []) addEdge(owner.id, task.id, true);
          }
        }
      }
      patch(paths, entries);
    });
  }

  function setSelection() {
    for (const node of rows.querySelectorAll('button')) {
      node.setAttribute('aria-pressed', String(node.dataset.taskId === selected));
    }
  }

  function paint() {
    const available = !!graphs.length;
    toggle.hidden = !available;
    toggle.setAttribute('aria-expanded', String(expanded && available));
    section.hidden = !expanded || !available;
    if (section.hidden) return;
    const names = new Map();
    for (const g of graphs) names.set(graphName(g), (names.get(graphName(g)) || 0) + 1);
    patch(picker, graphs.map(g => {
      const key = graphKey(g);
      const name = names.get(graphName(g)) === 1 ? graphName(g) : `${graphName(g)} · ${g.graphId} · ${g.origin.slice(0, 8)}`;
      return [key, name, label => {
        const option = el('option', label);
        option.value = key;
        return option;
      }];
    }));
    const graph = graphs.find(g => graphKey(g) === activeGraph)
      || graphs.find(g => g.nodes.some(task => task.id === selected)) || graphs[0];
    activeGraph = graphKey(graph);
    picker.value = activeGraph;
    const switched = activeGraph !== renderedGraph;
    if (switched && renderedGraph) positions.set(renderedGraph, [scroll.scrollLeft, scroll.scrollTop]);
    visible = graphLayers(graph);
    const { layers, external } = visible;
    const paintLayer = (layer, tasks) => patch(layer, tasks.map(task => [task.id, { task, external:external.has(task.id) },
      data => graphNode(data, onSelect), updateNode]));
    patch(rows, layers.map((layer, index) => [JSON.stringify([activeGraph, index]), layer.map(nodeView), tasks => {
      const node = el('div', null, 'graph-layer');
      paintLayer(node, tasks);
      return node;
    }, paintLayer]));
    $('graph-legend').querySelector('.lock-legend').hidden = !layers.some(layer =>
      layer.some(task => task.waitInfo?.kind === 'write_lock'));
    if (switched) scroll.scrollTo(...(positions.get(activeGraph) || [0, 0]));
    renderedGraph = activeGraph;
    setSelection();
    scheduleEdges();
  }

  toggle.onclick = () => {
    expanded = !expanded;
    if (expanded) showDetail();
    paint();
  };
  picker.onchange = () => { activeGraph = picker.value; paint(); };
  new ResizeObserver(scheduleEdges).observe(canvas);

  return {
    render(data, id) {
      graphs = data;
      selected = id;
      paint();
    },
    select(id, open = false) {
      selected = id;
      const graph = graphs.find(g => graphKey(g) === activeGraph);
      if (open || !graph || ![...graph.nodes, ...(graph.externalNodes || [])].some(task => task.id === id)) {
        const owner = graphs.find(g => g.nodes.some(task => task.id === id));
        if (owner) {
          activeGraph = graphKey(owner);
          if (open) expanded = true;
        }
      }
      paint();
      if (section.hidden) return;
      const node = rows.querySelector('.graph-node[aria-pressed="true"]');
      if (!node) return;
      const bounds = node.getBoundingClientRect(), view = scroll.getBoundingClientRect();
      scroll.scrollBy({
        left:Math.min(0, bounds.left - view.left) || Math.max(0, bounds.right - view.right + 10),
        top:Math.min(0, bounds.top - view.top) || Math.max(0, bounds.bottom - view.bottom + 10),
        behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      });
    },
  };
}
