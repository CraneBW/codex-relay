import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clip } from './store.mjs';

const exec = promisify(execFile);
const targetOf = task => task.delegateOrigin || task.origin;
const current = (task, notice) => task?.noticeId === notice.id && task.status === notice.status;
const maxConcurrent = 4;

export class Notices {
  constructor(store) {
    this.store = store; this.closed = false;
    this.inFlight = new Map();
    const attempts = Number(process.env.CODEX_RELAY_NOTICE_MAX_ATTEMPTS);
    this.maxAttempts = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 12;
    this.signal = () => {
      try { this.flush(); } catch (error) { this.retryFlush(error); }
    };
    store.changes.on('notice', this.signal);
  }

  retryFlush(error) {
    if (this.closed) return;
    console.error('通知队列写入或读取失败', error);
    clearTimeout(this.timer);
    this.timer = setTimeout(this.signal, 1000);
  }

  flush() {
    if (this.closed) return;
    clearTimeout(this.timer);
    if (this.inFlight.size >= maxConcurrent) return;
    const db = this.store.db;
    const timestamp = Date.now();
    let earliest = Infinity;
    for (const notice of db.prepare('SELECT * FROM notices WHERE delivered=0 ORDER BY rowid').all()) {
      // A notice can change destination while the old invocation is still running.
      if ([...this.inFlight.values()].some(job => job.id === notice.id)) continue;
      const task = this.store.tasks.get(notice.task_id);
      if (!current(task, notice)) {
        db.prepare('DELETE FROM notices WHERE id=?').run(notice.id);
        continue;
      }
      const target = targetOf(task);
      if (this.inFlight.has(target)) continue;
      if (notice.retry_at > timestamp) {
        earliest = Math.min(earliest, notice.retry_at);
        continue;
      }
      const controller = new AbortController();
      this.inFlight.set(target, { id: notice.id, controller });
      void this.deliver(task, notice, target, controller.signal).then(() => {
        this.inFlight.delete(target);
        this.signal();
      }, error => {
        this.inFlight.delete(target);
        this.retryFlush(error);
      });
      if (this.inFlight.size >= maxConcurrent) return;
    }
    if (earliest < Infinity) this.timer = setTimeout(this.signal, Math.max(1, earliest - Date.now()));
  }

  async deliver(task, notice, target, signal) {
    const speaker = task.kind === 'discussion' ? 'Astra Max' : 'Codex';
    const delegated = target === task.delegateOrigin;
    if (!delegated && notice.attempts >= this.maxAttempts) {
      this.fail(task, notice.attempts, task.deliveryError || '已达到通知投递次数上限');
      return;
    }
    const subject = delegated ? (notice.status === 'review' ? 'Astra Max 已回应。' : 'Astra Max 遇到阻塞。') +
      '请子代理核对并用 resume 继续，或调用 handover 交还主对话。'
      : notice.status !== 'review' ? speaker + ' 遇到阻塞，请接手。'
      : task.kind === 'discussion' ? 'Astra Max 已回应，请主对话核对、追问或独立定论。' : 'Codex 已交付，请验收。';
    const text = 'Codex 调度台 · ' + subject +
      '\n任务 ' + task.id + '\n事件 ' + notice.id +
      '\n调用 relay_inspect 读取任务与证据。如果事件已处理，直接结束本次通知。';
    let failure;
    try {
      const helper = process.env.CODEX_RELAY_AGENTAPI || 'agentapi';
      await exec(helper, ['send-message', target, text], { signal, timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
    } catch (error) { failure = error; }
    if (this.closed || !current(task, notice) || target !== targetOf(task)) return;

    if (!failure) {
      this.commit(task, { delivery: 'sent', deliveryError: '' }, { delivered: 1, attempts: notice.attempts, retryAt: 0 });
    } else if (delegated && notice.attempts >= 1) {
      this.commit(task, { delegateOrigin: null, awaitingDelegate: false }, { delivered: 0, attempts: 0, retryAt: 0 },
        'handover', '子代理通知失败，控制权已回退给主对话');
    } else {
      const attempts = notice.attempts + 1;
      const deliveryError = clip(failure.stderr || failure.code || failure.message, 450);
      if (!delegated && attempts >= this.maxAttempts) {
        this.fail(task, attempts, deliveryError);
      } else {
        const retryAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(notice.attempts, 6));
        this.commit(task, { delivery: 'retry', deliveryError }, { delivered: 0, attempts, retryAt });
      }
    }
  }

  fail(task, attempts, deliveryError) {
    // The outbox uses 0 for pending, 1 for sent and 2 for permanent failure.
    this.commit(task, { delivery: 'failed', deliveryError }, { delivered: 2, attempts, retryAt: 0 },
      'delivery', `唤醒通知投递失败（已尝试 ${attempts} 次）：${deliveryError}`);
  }

  commit(task, fields, state, kind, message) {
    const previous = {};
    for (const key of Object.keys(fields)) previous[key] = task[key];
    if (kind) {
      previous.events = task.events;
      task.events = [...task.events];
      this.store.log(task, kind, message);
    }
    Object.assign(task, fields);
    try { this.store.persist(task, false, null, state); }
    catch (error) { Object.assign(task, previous); throw error; }
  }

  close() {
    this.closed = true; clearTimeout(this.timer);
    this.store.changes.off('notice', this.signal);
    for (const { controller } of this.inFlight.values()) controller.abort();
  }
}
