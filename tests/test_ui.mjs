import assert from 'node:assert/strict';
import test from 'node:test';
import { astra, codingProfile, luna, sessionPermission, sol, terra } from '../src/models.mjs';
import { delegateBadge, modelBadge, permissionBadge, plainPreview, queueText, stateBadge } from '../src/board/ui.mjs';
import { formatDuration } from '../src/board/content.mjs';
import { getRounds } from '../src/board/discussion.mjs';
import { graphLayers } from '../src/board/graph.mjs';
import { parseMarkdown } from '../src/board/markdown.mjs';

test('coding routes apply explicit overrides and retain or reset previous choices', () => {
  for (const [level, model, effort] of [
    ['simple', luna, 'low'], ['browser', terra, 'medium'], ['standard', sol, 'high'],
    ['hard', sol, 'xhigh'], ['exceptional', sol, 'max'],
  ]) assert.deepEqual(codingProfile(level), { difficulty: level, model, effort });
  assert.deepEqual(codingProfile('complex'), codingProfile());
  const prior = codingProfile('hard', 'ultra', undefined, terra);
  assert.deepEqual(codingProfile(undefined, undefined, prior), prior);
  assert.deepEqual(codingProfile('simple', undefined, prior, astra), { difficulty: 'simple', model: astra, effort: 'low' });
  assert.throws(() => codingProfile(undefined, undefined, prior, sol), /最高为 max/);
  assert.throws(() => codingProfile('constructor'), /未知/);
  assert.throws(() => codingProfile('hard', '', prior), /思考等级/);
  assert.throws(() => codingProfile('hard', 'high', undefined, 'other'), /编码模型/);
});

test('permission presets respect access overrides, previous values and read-only guards', () => {
  const full = { permission: 'full', sandbox: 'danger-full-access', approvalPolicy: 'never' };
  const readAuto = { permission: 'auto', sandbox: 'read-only', approvalPolicy: 'never' };
  assert.deepEqual(sessionPermission({ mode: 'write', permission: 'full' }), full);
  assert.deepEqual(sessionPermission({ mode: 'read', permission: 'auto' }), readAuto);
  assert.deepEqual(sessionPermission({ mode: 'read' }, readAuto), readAuto);
  assert.deepEqual(sessionPermission({ mode: 'write', permission: 'default' }, full), {
    permission: 'default', sandbox: 'workspace-write', approvalPolicy: 'on-request',
  });
  assert.deepEqual(sessionPermission({ mode: 'write', approvalPolicy: 'untrusted' }, full), {
    permission: 'custom', sandbox: 'danger-full-access', approvalPolicy: 'untrusted',
  });
  for (const args of [{ permission: 'full', sandbox: 'read-only' }, { sandbox: 'workspace-write' }, { sandbox: 'danger-full-access' }])
    assert.throws(() => sessionPermission({ mode: 'read', ...args }), /只读任务/);
  for (const field of ['permission', 'sandbox', 'approvalPolicy'])
    assert.throws(() => sessionPermission({ mode: 'write', [field]: 'invalid' }), new RegExp(field));
});

test('status, model, delegation and permission badges emit readable labels', t => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: tagName => ({ tagName, children: [], append(...nodes) { this.children.push(...nodes); } }),
  } });
  t.after(() => {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
    else delete globalThis.document;
  });
  const discussion = { kind: 'discussion', status: 'review', delegateOrigin: 'child' };
  const dot = stateBadge(discussion, true);
  assert.match(dot.className, /state-dot/);
  assert.equal(dot.children[0].textContent, '待子代理回应');
  assert.equal(stateBadge({ status: 'unknown' }).textContent, 'unknown');
  assert.equal(delegateBadge(discussion).textContent, '子代理讨论中');
  assert.equal(modelBadge({ model: terra, effort: 'ultra' }).textContent, 'Terra · ultra');
  assert.equal(permissionBadge({ mode: 'read' }).textContent, '只读');
  const open = permissionBadge({ mode: 'write', sandbox: 'danger-full-access', approvalPolicy: 'never' });
  assert.equal(open.textContent, '完全开放 · 免审批');
  assert.match(open.className, /permission-open/);
  assert.equal(permissionBadge({ mode: 'write', approvalPolicy: 'untrusted' }).textContent, '可写 · 严格审批');
});

test('previews, queue reasons and durations handle empty and bounded values', () => {
  assert.equal(plainPreview('# 标题\n> **证据** [链接](https://example.test) <i>尾</i>\n```sh\necho ok\n```'), '标题 证据 链接 尾 echo ok');
  assert.equal(plainPreview('abc def', 4), 'abc…');
  assert.equal(plainPreview(null), '');
  assert.equal(queueText({}), '');
  assert.equal(queueText({ waitInfo: { kind: 'unknown' } }), '等待启动');
  const blockers = [{ label: '任务甲' }, { label: '任务乙' }];
  assert.equal(queueText({ waitInfo: { kind: 'concurrency', blockers } }), '等待并发槽位 · 任务甲、任务乙');
  assert.equal(queueText({ waitInfo: { kind: 'write_lock', blockers } }), '等待目录写锁 · 任务甲、任务乙');
  assert.equal(formatDuration(null), '');
  assert.equal(formatDuration(0), '0 毫秒');
  assert.equal(formatDuration(3661999), '1 小时 1 分 1 秒');
});

test('discussion groups consecutive replies, handles partial pages and caps only when indicated', () => {
  const first = { actor: 'main', at: '1', body: '问题' };
  const reply = { speaker: 'Astra Max', at: '2', body: '回复' };
  const follow = { actor: 'subagent', at: '3', body: '追问' };
  const closing = { speaker: '反重力', at: '4', body: '定论' };
  const discussion = [reply, first, reply, reply, follow, reply, reply, closing];
  const latest = getRounds({ status: 'done', discussion, discussionTruncated: false });
  assert.equal(latest.final, closing);
  assert.equal(latest.capped, false);
  assert.equal(latest.count, 7);
  assert.deepEqual(latest.rounds.map(round => round.messages.length), [1, 3, 3]);
  const keys = latest.rounds.flatMap(round => round.messages.map(([key]) => key));
  assert.equal(new Set(keys).size, keys.length);
  const older = getRounds({ status: 'done', discussion, discussionOffset: 8, discussionTruncated: true });
  assert.equal(older.final, null);
  assert.equal(older.capped, true);
  assert.equal(older.count, 8);
  assert.equal(getRounds({ status: 'review', discussion }).capped, true);
  assert.deepEqual(getRounds({}), { rounds: [], final: null, capped: false, count: 0 });
});

test('DAG layers handle multiple parents, external nodes, absent parents and cyclic tails', () => {
  const node = (id, ...dependsOn) => ({ id, dependsOn });
  const external = node('external'), root = node('root', 'missing'), branch = node('branch', 'external');
  const join = node('join', 'branch', 'root');
  const acyclic = graphLayers({ nodes: [join, branch, root], externalNodes: [external] });
  assert.deepEqual(acyclic.layers, [[external, root], [branch], [join]]);
  assert.deepEqual(acyclic.parents.get('root'), []);
  assert.deepEqual(acyclic.external, new Set(['external']));
  const left = node('left', 'right'), right = node('right', 'left'), tail = node('tail', 'right');
  assert.deepEqual(graphLayers({ nodes: [root, left, right, tail] }).layers, [[root], [left, right, tail]]);
  assert.deepEqual(graphLayers({ nodes: [] }).layers, []);
});

test('Markdown keeps CJK emphasis and escaped code, isolates math and leaves literals intact', () => {
  const formulas = [];
  const html = parseMarkdown(String.raw`中文**（重点）**接续，\(a+b\) 与 \$HOME 以及 \`$x$\`。`.replaceAll('\\`', '`'), formulas);
  assert.match(html, /中文<strong>（重点）<\/strong>接续/);
  assert.match(html, /<span data-board-math="0"><\/span>/);
  assert.match(html, /\$HOME.*<code>\$x\$<\/code>/);
  assert.deepEqual(formulas.map(({ formula, display }) => [formula, display]), [['a+b', false]]);
  const display = [];
  assert.equal(parseMarkdown('$$a\nb$$', display), '<div data-board-math="0"></div>');
  assert.deepEqual(display.map(({ formula, display }) => [formula, display]), [['a\nb', true]]);
  const literal = [];
  assert.match(parseMarkdown('~~~invalid@tag\n<>& $ENV$\n~~~', literal), /<code>&lt;&gt;&amp; \$ENV\$<\/code>/);
  assert.equal(parseMarkdown('![a < b](https://example.test/x)', literal), '<p>a &lt; b</p>\n');
  assert.deepEqual(literal, []);
});
