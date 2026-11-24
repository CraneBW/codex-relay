import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const terminal = new Set(['done', 'cancelled']);
export const clip = (value, size = 2400) => String(value ?? '').slice(0, size);
export const tail = (value, size = 2400) => String(value ?? '').slice(-size);
export const now = () => new Date().toISOString();

export class Store {
  constructor(dir) {
    this.db = new DatabaseSync(join(dir, 'tasks.sqlite'));
    this.db.exec(`
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
      CREATE TABLE IF NOT EXISTS discussion_messages (
        task_id TEXT NOT NULL, message_key TEXT NOT NULL, speaker TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY(task_id,message_key)
      );
    `);
    this.tasks = new Map(this.db.prepare('SELECT body FROM tasks ORDER BY rowid').all()
      .map(row => { const task = JSON.parse(row.body); return [task.id, task]; }));
    this.changes = new EventEmitter();
    this.changes.setMaxListeners(0);
    this.run = randomUUID();
    this.sequence = 0;
    this.previewTimers = new Map();
  }

  get revision() { return this.run + '/' + this.sequence; }

  persist(task, notice = false, message = null) {
    clearTimeout(this.previewTimers.get(task.id));
    this.previewTimers.delete(task.id);
    task.updated = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (notice) {
        task.noticeId = randomUUID();
        task.delivery = 'pending';
        this.db.prepare('INSERT INTO notices(id, task_id, origin, status) VALUES(?,?,?,?)')
          .run(task.noticeId, task.id, task.origin, task.status);
      }
      if (message) this.db.prepare('INSERT OR IGNORE INTO discussion_messages VALUES(?,?,?,?,?)')
        .run(task.id, message.key, message.speaker, clip(message.text, 16000), task.updated);
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
        .run(task.id, task.origin, task.requestKey, JSON.stringify(task));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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

  view(task, detail = false) {
    const { id, title, cwd, mode, model, effort, status, current, updated, delivery, noticeId, created } = task;
    const summary = { id, title, cwd, mode, model, effort, difficulty:task.difficulty || null,
      kind: task.kind || 'execution', status, current: clip(current, 400), updated, created, delivery };
    const discussion = detail && task.kind === 'discussion' ? this.db.prepare(
      'SELECT speaker,body,at FROM discussion_messages WHERE task_id=? ORDER BY rowid DESC LIMIT 8'
    ).all(task.id).reverse() : [];
    return detail ? { ...summary, goal: task.goal, threadId: task.threadId,
      result: task.result, command: task.command, events: task.events, noticeId, discussion,
      deliveryError: task.deliveryError || '', turnId: task.turnId } : summary;
  }

  board({ selected, limit = 40, offset = 0 }) {
    const all = [...this.tasks.values()].sort((a, b) =>
      Number(terminal.has(a.status)) - Number(terminal.has(b.status)) || b.updated.localeCompare(a.updated));
    return { revision: this.revision, total: all.length, offset,
      tasks: all.slice(offset, offset + limit).map(t => this.view(t)),
      selected: selected && this.tasks.has(selected) ? this.view(this.tasks.get(selected), true) : null };
  }
}
