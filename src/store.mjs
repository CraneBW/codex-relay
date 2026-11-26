import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { modelName, sessionPermission } from './models.mjs';
import { inside } from './paths.mjs';

export const terminal = new Set(['done', 'cancelled']);
export const active = new Set(['starting', 'running', 'stopping']);
const defaultDiscussionLimit = 8;
const maxDiscussionLimit = 100;
export const clip = (value, size = 2400) => String(value ?? '').slice(0, size);
export const tail = (value, size = 2400) => String(value ?? '').slice(-size);
export const now = () => new Date().toISOString();
export const taskLabel = task => task.nodeLabel || task.title;
const reference = task => ({ id: task.id, label: taskLabel(task), status: task.status });
const holdsWriteLock = task => task.mode === 'write' && !!task.lease;
const blocked = new Set(['blocked', 'waiting_user', 'host']);
const matchesStatus = (status, filter) => filter === 'all' ||
  (filter === 'active' && (active.has(status) || status === 'queued')) ||
  (filter === 'attention' && (blocked.has(status) || status === 'review')) ||
  (filter === 'done' && status === 'done');

function matchesQuery(task, words) {
  if (!words.length) return true;
  const { id, title, nodeLabel, graphTitle, graphId, model, effort, cwd, mode, status } = task;
  const { permission, sandbox, approvalPolicy } = sessionPermission({ mode }, task);
  const text = [id, title, nodeLabel, graphTitle, graphId, model, modelName(model), effort, cwd,
    permission, sandbox, approvalPolicy, status].join(' ').toLowerCase();
  return words.every(word => text.includes(word));
}

export class Store {
  constructor(dir) {
    this.db = new DatabaseSync(join(dir, 'tasks.sqlite'));
    const concurrency = Number(process.env.CODEX_RELAY_MAX_CONCURRENT);
    this.maxConcurrent = Number.isSafeInteger(concurrency) && concurrency > 0 ? concurrency : 4;
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, origin TEXT NOT NULL, request_key TEXT NOT NULL, body TEXT NOT NULL,
        UNIQUE(origin,request_key)
      );
      CREATE TABLE IF NOT EXISTS notices (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS notices_by_task ON notices(task_id);
      CREATE INDEX IF NOT EXISTS pending_notices ON notices(delivered) WHERE delivered=0;
      CREATE TABLE IF NOT EXISTS discussion_messages (
        task_id TEXT NOT NULL, message_key TEXT NOT NULL, speaker TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT 'main',
        PRIMARY KEY(task_id,message_key)
      );
    `);
    if (!this.db.prepare('PRAGMA table_info(discussion_messages)').all().some(column => column.name === 'actor'))
      this.db.exec("ALTER TABLE discussion_messages ADD COLUMN actor TEXT NOT NULL DEFAULT 'main'");
    this.db.exec(`DELETE FROM notices WHERE delivered<>0 AND NOT EXISTS (
      SELECT 1 FROM tasks WHERE tasks.id=notices.task_id
        AND json_extract(tasks.body, '$.noticeId')=notices.id AND json_extract(tasks.body, '$.status')=notices.status
    )`);
    this.tasks = new Map(this.db.prepare('SELECT body FROM tasks ORDER BY rowid').all().map(row => {
      const task = JSON.parse(row.body);
      task.commands ??= task.command ? [task.command] : [];
      if (task.commands.length) task.command = task.commands.at(-1);
      return [task.id, task];
    }));
    this.changes = new EventEmitter();
    this.changes.setMaxListeners(0);
    this.run = randomUUID();
    this.sequence = 0;
    this.previewTimers = new Map();
  }

  get revision() { return this.run + '/' + this.sequence; }

  persist(task, notice = false, message = null, noticeState = null) {
    const snapshot = ['updated', 'noticeId', 'delivery'].map(key => [key, Object.getOwnPropertyDescriptor(task, key)]);
    let inTransaction = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      task.updated = now();
      if (notice) {
        task.noticeId = randomUUID();
        task.delivery = 'pending';
        this.db.prepare('INSERT INTO notices(id, task_id, origin, status) VALUES(?,?,?,?)')
          .run(task.noticeId, task.id, task.origin, task.status);
      }
      if (noticeState) this.db.prepare('UPDATE notices SET delivered=?,attempts=?,retry_at=? WHERE id=?')
        .run(noticeState.delivered, noticeState.attempts, noticeState.retryAt, task.noticeId);
      if (message) this.db.prepare(`INSERT INTO discussion_messages(task_id,message_key,speaker,body,at,actor) VALUES(?,?,?,?,?,?)
        ON CONFLICT(task_id,message_key) DO UPDATE SET body=excluded.body WHERE ?`)
        .run(task.id, message.key, message.speaker, clip(message.text, 16000), task.updated,
          message.actor ?? (message.speaker === 'Astra Max' ? 'astra' : 'main'), Number(!!message.amend));
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
        .run(task.id, task.origin, task.requestKey, JSON.stringify(task));
      this.db.prepare('DELETE FROM notices WHERE task_id=? AND delivered<>0 AND (id IS NOT ? OR status<>?)')
        .run(task.id, task.noticeId ?? null, task.status);
      this.db.exec('COMMIT');
    } catch (error) {
      if (inTransaction) { try { this.db.exec('ROLLBACK'); } catch { /* Preserve the write error. */ } }
      for (const [key, descriptor] of snapshot) {
        if (descriptor) Object.defineProperty(task, key, descriptor);
        else delete task[key];
      }
      throw error;
    }
    clearTimeout(this.previewTimers.get(task.id));
    this.previewTimers.delete(task.id);
    this.tasks.set(task.id, task);
    this.sequence++;
    this.changes.emit('change');
    if (notice) this.changes.emit('notice');
  }

  preview(task) {
    // Batch streaming stdout. Command completion, ownership and notices still commit immediately.
    if (this.previewTimers.has(task.id)) return;
    this.previewTimers.set(task.id, setTimeout(() => this.persist(task), 250));
  }

  log(task, kind, text) {
    if (!text) return;
    task.events.push({ time: now(), kind, text: clip(text) });
    if (task.events.length > 36) task.events.shift();
  }

  wait(revision, signal) {
    if (revision !== this.revision || signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        this.changes.off('change', finish);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, 20000);
      this.changes.once('change', finish);
      signal.addEventListener('abort', finish, { once: true });
    });
  }

  pendingUpstreams(task) {
    return (task.dependsOn || []).flatMap(id => {
      const upstream = this.tasks.get(id);
      if (!upstream || upstream.origin !== task.origin) return [{ id, label: id, status: 'missing' }];
      return upstream.status === 'done' ? [] : [reference(upstream)];
    });
  }

  writeOwners() {
    return [...this.tasks.values()].filter(holdsWriteLock);
  }

  writeBlockers(task, owners) {
    if (task.mode !== 'write') return [];
    return (owners ?? this.writeOwners()).filter(other => other.id !== task.id &&
      (inside(task.cwd, other.cwd) || inside(other.cwd, task.cwd)));
  }

  queueSnapshot() {
    const owners = [], running = [];
    for (const task of this.tasks.values()) {
      if (holdsWriteLock(task)) owners.push(task);
      if (active.has(task.status)) running.push(task);
    }
    const concurrency = running.length >= this.maxConcurrent ? { kind: 'concurrency', blockers: running.map(reference) } : null;
    return { owners, concurrency };
  }

  waitInfo(task, snapshot) {
    if (task.status !== 'queued') return null;
    const upstreams = this.pendingUpstreams(task);
    if (upstreams.length) {
      const kind = upstreams.some(t => t.status === 'cancelled') ? 'upstream_cancelled'
        : upstreams.some(t => blocked.has(t.status) || t.status === 'missing') ? 'upstream_blocked' : 'upstream';
      return { kind, blockers: upstreams };
    }
    snapshot ??= this.queueSnapshot();
    const conflicts = this.writeBlockers(task, snapshot.owners);
    if (conflicts.length) return { kind: 'write_lock', blockers: conflicts.map(t => ({ ...reference(t), cwd: t.cwd })) };
    if (task.awaitingDelegate) return { kind: 'awaiting_delegate', blockers: [] };
    return snapshot.concurrency;
  }

  view(task, detail = false, { discussionLimit = defaultDiscussionLimit, discussionOffset = 0 } = {}, snapshot) {
    const { id, title, cwd, mode, model, effort, status, current, updated, delivery, noticeId, created } = task;
    const summary = { id, title, cwd, mode, model, effort, difficulty:task.difficulty || null,
      ...sessionPermission({ mode }, task),
      kind: task.kind || 'execution', status, current: clip(current, 400), updated, created, delivery,
      delegateOrigin: task.delegateOrigin || null, awaitingDelegate: !!task.awaitingDelegate, hasHandoff: !!task.handoff?.note,
      graphId: task.graphId ?? null, graphTitle: task.graphTitle ?? null, nodeLabel: task.nodeLabel ?? null,
      dependsOn: task.dependsOn || [], waitInfo: this.waitInfo(task, snapshot), holdsWriteLock: holdsWriteLock(task) };
    if (!detail) return summary;
    const isDiscussion = task.kind === 'discussion';
    const discussionTotal = isDiscussion ? this.db.prepare('SELECT COUNT(*) AS total FROM discussion_messages WHERE task_id=?')
      .get(task.id).total : 0;
    const discussion = isDiscussion ? this.db.prepare(
      `SELECT speaker,body,at,CASE WHEN speaker='Astra Max' THEN 'astra' ELSE actor END AS actor
       FROM discussion_messages WHERE task_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?`
    ).all(task.id, Math.min(maxDiscussionLimit, Math.max(1, discussionLimit)), discussionOffset).reverse() : [];
    const upstreams = summary.dependsOn.map(id => this.tasks.get(id)).filter(t => t?.origin === task.origin).map(reference);
    const downstreams = [...this.tasks.values()].filter(t => t.origin === task.origin && t.dependsOn?.includes(id)).map(reference);
    return { ...summary, goal: task.goal, threadId: task.threadId, upstreams, downstreams,
      result: task.result, command: task.command, commands: task.commands, events: task.events, noticeId, discussion, discussionTotal, discussionOffset,
      discussionTruncated: discussionOffset + discussion.length < discussionTotal, handoff: task.handoff || null,
      deliveryError: task.deliveryError || '', turnId: task.turnId, turns: task.turns ?? null,
      startedAt: task.startedAt ?? null, finishedAt: task.finishedAt ?? null, durationMs: task.durationMs ?? null };
  }

  graphs(snapshot = this.queueSnapshot()) {
    const graphs = new Map();
    for (const t of this.tasks.values()) {
      if (!t.graphId) continue;
      const key = JSON.stringify([t.origin, t.graphId]);
      if (!graphs.has(key)) graphs.set(key, { origin: t.origin, graphId: t.graphId, graphTitle: null, nodes: [] });
      const graph = graphs.get(key);
      graph.graphTitle ||= t.graphTitle || null;
      graph.nodes.push(this.view(t, false, undefined, snapshot));
    }
    for (const graph of graphs.values()) {
      const members = new Set(graph.nodes.map(t => t.id));
      const sources = new Set();
      for (const node of graph.nodes) {
        for (const id of node.dependsOn) if (this.tasks.get(id)?.origin === graph.origin) sources.add(id);
        // Lock blockers are already visible in the board's queue information, including across conversations.
        if (node.waitInfo?.kind === 'write_lock') for (const blocker of node.waitInfo.blockers) sources.add(blocker.id);
      }
      graph.externalNodes = [...sources].filter(id => !members.has(id))
        .map(id => this.view(this.tasks.get(id), false, undefined, snapshot));
    }
    return [...graphs.values()];
  }

  board({ selected, limit = 40, offset = 0, discussionLimit, discussionOffset,
    filter = 'all', query = '', workspace, includeGraphs = true } = {}) {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const workspaces = new Set();
    const matches = [];
    let hasGraphs = false;
    for (const task of this.tasks.values()) {
      if (task.cwd) workspaces.add(task.cwd);
      hasGraphs ||= !!task.graphId;
      if (matchesStatus(task.status, filter) && (!workspace || (task.cwd && inside(workspace, task.cwd))) &&
          matchesQuery(task, words)) matches.push(task);
    }
    matches.sort((a, b) =>
      Number(terminal.has(a.status)) - Number(terminal.has(b.status)) || b.updated.localeCompare(a.updated));
    const snapshot = this.queueSnapshot();
    const task = this.tasks.get(selected);
    return { revision: this.revision, total: this.tasks.size, filteredTotal: matches.length, offset,
      workspaces: [...workspaces].sort(), hasGraphs,
      tasks: matches.slice(offset, offset + limit).map(t => this.view(t, false, undefined, snapshot)),
      graphs: includeGraphs ? this.graphs(snapshot) : [],
      selected: task ? this.view(task, true, { discussionLimit, discussionOffset }, snapshot) : null };
  }
}
