import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clip } from './store.mjs';

const exec = promisify(execFile);

/** The worker reacts to state transitions. A timer exists only after a delivery fails. */
export class Notices {
  constructor(store) {
    this.store = store; this.busy = false; this.closed = false;
    this.signal = () => { if (!this.closed) void this.flush(); };
    store.changes.on('notice', this.signal);
  }
  async flush() {
    if (this.closed || this.busy) return;
    clearTimeout(this.timer); this.busy = true;
    const db = this.store.db;
    try {
      for (;;) {
        if (this.closed) return;
        const n = db.prepare('SELECT * FROM notices WHERE delivered=0 AND retry_at<=? ORDER BY rowid LIMIT 1').get(Date.now());
        if (!n) break;
        const t = this.store.tasks.get(n.task_id);
        if (!t || t.noticeId !== n.id || t.status !== n.status) {
          db.prepare('UPDATE notices SET delivered=1 WHERE id=?').run(n.id); continue;
        }
        const speaker = t.kind === 'discussion' ? 'Astra Max' : 'Codex';
        const target = t.delegateOrigin || t.origin;
        const delegated = target === t.delegateOrigin;
        const subject = delegated ? (n.status === 'review' ? 'Astra Max 已回应。' : 'Astra Max 遇到阻塞。') +
          '请子代理核对并用 resume 继续，或调用 handover 交还主对话。'
          : n.status !== 'review' ? speaker + ' 遇到阻塞，请接手。'
          : t.kind === 'discussion' ? 'Astra Max 已回应，请主对话核对、追问或独立定论。' : 'Codex 已交付，请验收。';
        const text = 'Codex 调度台 · ' + subject +
          '\n任务 ' + t.id + '\n事件 ' + n.id +
          '\n调用 relay_inspect 读取任务与证据。如果事件已处理，直接结束本次通知。';
        try {
          const helper = process.env.CODEX_RELAY_AGENTAPI || 'agentapi';
          await exec(helper, ['send-message', target, text], { timeout: 60000, maxBuffer: 64 * 1024 });
          if (t.noticeId === n.id && t.status === n.status && target !== (t.delegateOrigin || t.origin)) continue;
          db.prepare('UPDATE notices SET delivered=1 WHERE id=?').run(n.id);
          if (t.noticeId === n.id && t.status === n.status) { t.delivery = 'sent'; t.deliveryError = ''; this.store.persist(t); }
        } catch (e) {
          if (t.noticeId !== n.id || t.status !== n.status || target !== (t.delegateOrigin || t.origin)) continue;
          if (delegated && n.attempts >= 1) {
            t.delegateOrigin = null; t.awaitingDelegate = false;
            this.store.log(t, 'handover', '子代理通知失败，控制权已回退给主对话');
            this.store.persist(t);
            db.prepare('UPDATE notices SET attempts=0,retry_at=0 WHERE id=?').run(n.id);
            continue;
          }
          const retry = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(n.attempts, 6));
          db.prepare('UPDATE notices SET attempts=attempts+1,retry_at=? WHERE id=?').run(retry, n.id);
          t.delivery = 'retry'; t.deliveryError = clip(e.stderr || e.code || e.message, 450); this.store.persist(t);
        }
      }
      const pending = db.prepare('SELECT MIN(retry_at) AS earliest FROM notices WHERE delivered=0').get();
      if (pending.earliest != null) this.timer = setTimeout(this.signal, Math.max(1, pending.earliest - Date.now()));
    } finally { this.busy = false; }
  }
  close() {
    this.closed = true; clearTimeout(this.timer);
    this.store.changes.off('notice', this.signal);
  }
}
