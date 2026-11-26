import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tail } from './store.mjs';
import { version } from './version.mjs';

export const resultSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    outcome: { type: 'string', enum: ['done', 'blocked'] },
    summary: { type: 'string' }, evidence: { type: 'string' }, next: { type: 'string' },
  },
  required: ['outcome', 'summary', 'evidence', 'next'],
};
export const discussionSchema = { ...resultSchema, properties: { ...resultSchema.properties, disagreement: { type: 'string' } },
  required: [...resultSchema.required, 'disagreement'] };
export const discussionInstructions = `You are Astra Max, the independent discussion partner of the Antigravity agent.
Address Antigravity directly. It is the user's only contact and delivers the final synthesis.
Discuss experiment design, results, or proposed plans in the supplied read-only workspace. Read the cited material
when available. Assess Antigravity's position independently. Separate observations, interpretation, counterexamples,
assumptions and unrun experiments. Do not run a new experiment or edit files as part of this discussion.
Use the same thread for follow-ups. Give a concise Chinese answer. Use summary for your position, evidence for
concrete observations or file references, disagreement for a specific disagreement or remaining limitation, and
next for the check that could change the conclusion. If the evidence already settles the issue, say so.
Return done when this discussion round has an answer and blocked only for a specific missing prerequisite.`;
export const instructions = `You execute tasks delegated by the Antigravity agent in the given working directory.
Address Antigravity, the user's only contact. Send blockers and completed work back to this supervisor.
Use the existing thread and workspace. For a recoverable error with a concrete new lead, investigate and verify it.
Only report blocked when you need the supervisor to intervene. Give the failing observation, failed attempts,
and the precise next decision. Report done only after checking the user's requested outcome.
Report your final result using the supplied JSON schema. Keep the summary, evidence and next step concise and in Chinese.
Only the delegated scope is authorized. Keep commands bound to this run and avoid detached/background processes.
When recovering an interrupted run, inspect existing files, processes and test output before repeating a step.`;

export class Codex {
  constructor(cwd, onMessage, onExit, onActivity) {
    this.id = 0;
    this.pending = new Map();
    this.stderr = '';
    const codex = process.env.CODEX_RELAY_CODEX || 'codex';
    const args = ['app-server', '--listen', 'stdio://'];
    // Linux clears the worker's pipes on exit. The parent-death signal also covers an active CLI
    // that has not yet returned to reading stdin when Antigravity or the worker is killed.
    const guard = process.platform === 'linux' && existsSync('/usr/bin/setpriv');
    this.child = spawn(guard ? '/usr/bin/setpriv' : codex, guard ? ['--pdeathsig', 'TERM', '--', codex, ...args] : args, {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    this.child.stderr.on('data', data => { this.stderr = tail(this.stderr + data); });
    this.child.stdin.on('error', () => {});
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let packet;
      try { packet = JSON.parse(line); } catch { return; }
      onActivity?.();
      const pending = this.pending.get(packet.id);
      if (!packet.method && pending) {
        clearTimeout(pending.timer);
        this.pending.delete(packet.id);
        if (packet.error) pending.reject(new Error(packet.error.message));
        else pending.resolve(packet.result);
      } else if (packet.method) {
        onMessage(packet);
      }
    });
    this.ended = new Promise(resolve => { this.finish = resolve; });
    const finish = reason => {
      if (this.dead) return;
      this.dead = true;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(reason));
      }
      this.pending.clear();
      this.finish();
      onExit(reason);
    };
    this.child.once('error', e => finish(e.message));
    this.child.once('exit', (code, signal) => finish(this.stderr.trim() || 'Codex 退出 ' + (signal || code)));
  }

  send(packet) {
    if (!this.dead && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(packet) + '\n');
  }

  request(method, params) {
    if (this.dead) return Promise.reject(new Error('Codex 进程已退出。'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex 接口超时 ' + method));
      }, 90000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  async init() {
    await this.request('initialize', { clientInfo: { name: 'antigravity_codex_relay', version },
      capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized' });
  }

  killGroup(signal) {
    if (!this.child.pid) return;
    try { process.kill(-this.child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }

  async close() {
    if (!this.closing) {
      this.closing = (async () => {
        this.child.stdin.end();
        this.killGroup('SIGTERM');
        const timer = setTimeout(() => this.killGroup('SIGKILL'), 2000);
        try { await this.ended; } finally { clearTimeout(timer); }
        // The CLI can exit before a child in its dedicated process group notices TERM.
        this.killGroup('SIGKILL');
      })();
    }
    return this.closing;
  }
}

export function outcome(text) {
  try {
    const value = JSON.parse(text);
    if (['done', 'blocked'].includes(value?.outcome) &&
        ['summary', 'evidence', 'next'].every(k => typeof value[k] === 'string') && value.summary.trim()) {
      const result = { outcome: value.outcome, summary: value.summary.slice(0, 4000),
        evidence: value.evidence.slice(0, 4000), next: value.next.slice(0, 2400) };
      if (typeof value.disagreement === 'string') result.disagreement = value.disagreement.slice(0, 3000);
      return result;
    }
  } catch { /* A malformed completion needs supervisor review. */ }
  return null;
}
