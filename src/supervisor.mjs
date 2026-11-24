import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { Codex, discussionInstructions, discussionSchema, instructions, outcome, resultSchema } from './codex.mjs';
import { astra, codingProfile, sol } from './models.mjs';
import { clip, now, tail, terminal } from './store.mjs';
import { checkContext } from './context.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const active = new Set(['starting', 'running', 'stopping']);
const stoppedResult = (summary, evidence = '', next = '') => ({ outcome: 'blocked', summary: clip(summary), evidence: clip(evidence), next: clip(next) });
function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}
function birth(pid) {
  try { return readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ').at(-1).split(' ')[19]; }
  catch { return null; }
}
function checkedCwd(value, roots) {
  if (!Array.isArray(roots) || !roots.length) throw Error('请在反重力项目中派单。当前对话没有挂载工作目录。');
  const path = value || (roots.length === 1 ? roots[0] : '');
  if (!isAbsolute(path)) throw Error('请指定当前项目中的绝对工作目录。');
  const cwd = realpathSync(path);
  if (!statSync(cwd).isDirectory() || !roots.some(r => { try { return inside(realpathSync(r), cwd); } catch { return false; } }))
    throw Error('派单目录必须位于当前反重力对话挂载的工作区。');
  return cwd;
}
function owner(a) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(a.origin || ''))
    throw Error('缺少反重力原对话 ID。请启用插件自带的 PreToolUse 钩子后重新派单。');
  if (!checkContext(a)) throw Error('派单上下文未通过宿主校验。请通过反重力直接调用本插件的工具。');
  return a.origin;
}

export class Supervisor {
  constructor(store) { this.store = store; this.runs = new Map(); this.closing = false; }

  async recover() {
    for (const t of this.store.tasks.values()) {
      if (!active.has(t.status)) continue;
      // Only clean up a process group whose leader still has its recorded Linux start time.
      if (t.pid && t.birth && birth(t.pid) === t.birth) {
        try { process.kill(-t.pid, 'SIGTERM'); } catch {}
        await delay(200);
        if (birth(t.pid) === t.birth) { try { process.kill(-t.pid, 'SIGKILL'); } catch {} }
      }
      this.settle(t, true);
    }
    this.schedule();
  }

  dispatch(a, discussion = false) {
    const origin = owner(a), cwd = checkedCwd(a.cwd, a.roots);
    const { model, effort, difficulty } = discussion ? { model:astra, effort:'max', difficulty:null }
      : codingProfile(a.difficulty, a.effort, undefined, a.model);
    const mode = discussion ? 'read' : a.mode || 'write';
    const kind = discussion ? 'discussion' : 'execution';
    const goal = discussion ? [a.question, '反重力的初步判断或疑点', a.position,
      ...(a.materials ? ['可核对的材料', a.materials] : [])].join('\n') : a.goal;
    if (discussion && (!a.question?.trim() || !a.position?.trim())) throw Error('讨论需要明确的问题和反重力自己的判断或疑点。');
    if (!a.title?.trim() || !goal?.trim() || !a.requestKey?.trim())
      throw Error('派单需要标题、任务和唯一 requestKey。');
    const known = [...this.store.tasks.values()].find(t => t.origin === origin && t.requestKey === a.requestKey);
    if (!['write', 'read'].includes(mode)) throw Error('无效的工作区模式。');
    if (known) {
      if (known.cwd !== cwd || known.goal !== goal || known.mode !== mode || (known.initialModel ?? known.model) !== model ||
          (known.initialEffort ?? known.effort) !== effort)
        throw Error('这个 requestKey 已用于另一个任务。新任务需要独立的 requestKey。');
      return this.store.view(known);
    }
    const t = { id: randomUUID(), origin, cwd, title: clip(a.title, 160), goal, requestKey: a.requestKey,
      kind, mode, model, effort, difficulty, initialModel:model, initialEffort:effort,
      status: 'queued', current: '等待执行', created: now(), updated: now(),
      lease: false, threadId: null, turnId: null, runKey: randomUUID(), prompt: goal, events: [], command: null,
      result: null, savedOutcome: null, intent: null, delivery: null, noticeId: null };
    this.store.persist(t, false, discussion ? { key: t.runKey + '/question', speaker: '反重力', text: goal } : null);
    this.schedule();
    return this.store.view(t);
  }

  owned(a) {
    const t = this.store.tasks.get(a.id);
    if (!t || t.origin !== owner(a)) throw Error('当前反重力对话没有这项派单。');
    return t;
  }

  inspect(a) {
    if (a.id) return this.store.view(this.owned(a), true);
    const origin = owner(a);
    const all = [...this.store.tasks.values()].filter(t => t.origin === origin)
      .sort((a,b) => Number(terminal.has(a.status)) - Number(terminal.has(b.status)) || b.updated.localeCompare(a.updated));
    const offset = a.offset || 0;
    return { total:all.length, offset, tasks:all.slice(offset,offset+40).map(t => this.store.view(t)) };
  }

  schedule() {
    if (this.closing) return;
    for (const t of this.store.tasks.values()) {
      if (t.status !== 'queued' || this.runs.has(t.id)) continue;
      if (t.mode === 'write' && [...this.store.tasks.values()].some(other => other.id !== t.id &&
        other.mode === 'write' && other.lease && (inside(t.cwd, other.cwd) || inside(other.cwd, t.cwd)))) continue;
      t.lease = true;
      t.status = 'starting'; t.current = t.recovering ? '核对退出前的执行记录' : '正在连接 Codex';
      this.store.persist(t);
      void this.execute(t);
    }
  }

  async execute(t) {
    let end;
    const ended = new Promise(resolve => { end = resolve; });
    let closed;
    const run = { end, ended, closed: new Promise(resolve => { closed = resolve; }), final: '', rpc: null };
    this.runs.set(t.id, run);
    try {
      const rpc = new Codex(t.cwd, packet => this.message(t, run, packet), reason => end({ error: reason }));
      run.rpc = rpc;
      t.pid = rpc.child.pid || null; t.birth = t.pid ? birth(t.pid) : null;
      this.store.persist(t);
      await rpc.init();
      if (t.intent) return;
      const discussion = t.kind === 'discussion';
      const model = t.model = discussion ? astra : t.model || sol;
      if (discussion || (model === sol && t.effort === 'ultra')) t.effort = 'max';
      const opts = { cwd: t.cwd, model, approvalPolicy: 'on-request', sandbox: t.mode === 'read' ? 'read-only' : 'workspace-write',
        config: { model_reasoning_effort: t.effort },
        developerInstructions: discussion ? discussionInstructions : instructions };
      const method = t.threadId ? 'thread/resume' : 'thread/start';
      const data = await rpc.request(method, t.threadId ? { ...opts, threadId: t.threadId, excludeTurns: true } : { ...opts, ephemeral: false });
      if (t.threadId && t.threadId !== data.thread.id) throw Error('Codex 返回了不同的会话。原任务已保留。');
      t.threadId = data.thread.id;
      this.store.persist(t);
      if (t.intent) return;
      const marker = '[codex-relay:' + t.runKey + ']';
      let live = false;
      if (t.recovering) {
        const history = await rpc.request('thread/turns/list', { threadId: t.threadId, limit: 6, itemsView: 'full', sortDirection: 'desc' });
        const prior = history.data.find(turn => turn.id === t.turnId || turn.items.some(i =>
          i.type === 'userMessage' && i.content.some(c => c.type === 'text' && c.text.includes(marker))));
        if (prior?.status === 'completed') {
          const text = prior.items.filter(i => i.type === 'agentMessage').at(-1)?.text;
          t.savedOutcome = outcome(text) || stoppedResult('已找到结束的执行轮次，需要反重力核对结果。', text);
          this.store.persist(t); return;
        }
        if (prior?.status === 'inProgress' && data.thread.status?.type === 'active') {
          t.turnId = prior.id; live = true;
        }
      }
      if (t.intent) return;
      if (!live) {
        const recovery = t.recovering ? '\n上次应用退出中断了执行。先核对已有改动、进程和测试结果，再继续未完成的步骤。' : '';
        this.store.log(t, 'model', model + ' · ' + t.effort);
        const start = await rpc.request('turn/start', { threadId: t.threadId, model, effort: t.effort,
          input: [{ type: 'text', text: marker + '\n' + t.prompt + recovery }], outputSchema: discussion ? discussionSchema : resultSchema });
        t.turnId = start.turn.id;
      }
      t.recovering = false;
      if (!t.intent) { t.status = 'running'; if (t.current === '正在连接 Codex' || t.current === '核对退出前的执行记录') t.current = 'Codex 正在执行'; }
      this.store.persist(t);
      if (t.intent) await this.interrupt(t, run);
      const finish = await ended;
      if (!t.intent && !t.savedOutcome) {
        t.savedOutcome = stoppedResult('Codex 执行中断。', finish?.error || '', '检查运行环境后继续原会话。');
        this.store.persist(t);
      }
    } catch (e) {
      if (!t.intent && !t.savedOutcome) t.savedOutcome = stoppedResult('Codex 需要反重力处理。', e.message, '检查错误后继续原任务。');
    } finally {
      if (run.rpc) await run.rpc.close();
      this.runs.delete(t.id);
      this.settle(t, false);
      closed();
      this.schedule();
    }
  }

  message(t, run, { method, id, params: p = {} }) {
    if (p.threadId && t.threadId && p.threadId !== t.threadId) return;
    if (id != null) {
      // Native input/approval requests transfer ownership without granting new privileges.
      const detail = [p.reason, p.command, p.message, p.questions?.map(q =>
        [q.question, ...(q.options || []).map(o => typeof o === 'string' ? o : o.label)].join(' / ')).join('\n')].filter(Boolean).join('\n');
      if (!t.intent) this.markStop(t, 'native', stoppedResult('Codex 正在等待处理 ' + method, detail || method,
        '反重力检查请求、解决阻塞，再向原会话交还处理结果。'));
      void this.interrupt(t, run);
      const result = method.endsWith('requestApproval') && method.includes('/permissions/') ? { permissions: {} }
        : method.endsWith('requestApproval') ? { decision: 'cancel' }
        : method.endsWith('requestUserInput') ? { answers: {} }
        : method === 'mcpServer/elicitation/request' ? { action: 'cancel', content: null } : null;
      run.rpc.send(result ? { id, result } : { id, error: { code: -32601, message: 'Transferred to Antigravity supervisor' } });
      return;
    }
    if (p.turnId && t.turnId && p.turnId !== t.turnId) return;
    if (method === 'turn/started') {
      t.turnId = p.turn.id; this.store.persist(t); return;
    }
    if (method === 'turn/completed') {
      if (t.turnId && p.turn.id !== t.turnId) return;
      if (!t.intent) {
        const text = p.turn.items?.filter(i => i.type === 'agentMessage').at(-1)?.text || run.final;
        t.savedOutcome = p.turn.status === 'completed' ? outcome(text) ||
          stoppedResult('Codex 已结束，交付结果需要核对。', text || '缺少结构化结果。')
          : stoppedResult('Codex 轮次' + (p.turn.status === 'failed' ? '失败' : '中断'), p.turn.error?.message || run.final);
        this.store.persist(t);
      }
      run.end(); return;
    }
    if (t.intent) return;
    if (method === 'error' && p.willRetry) {
      t.current = 'Codex 正在重试 · ' + clip(p.error?.message || p.message, 350);
      this.store.log(t,'retry',t.current); this.store.persist(t); return;
    }
    if (method === 'item/commandExecution/outputDelta' && t.command?.id === p.itemId) {
      t.command.output = tail(t.command.output + p.delta); this.store.preview(t); return;
    }
    if (!['item/started', 'item/completed'].includes(method)) return;
    const item = p.item || {}, finished = method === 'item/completed';
    if (item.type === 'agentMessage' && finished) {
      run.final = item.text || '';
      if (item.phase !== 'final_answer' && !outcome(item.text)) {
        t.current = clip(item.text, 400); this.store.log(t, 'message', t.current);
      }
    } else if (item.type === 'commandExecution') {
      const previous = t.command?.id === item.id ? t.command.output : '';
      t.command = { id: item.id, text: clip(item.command, 1200), status: item.status,
        code: item.exitCode ?? null, output: tail(item.aggregatedOutput || previous) };
      t.current = finished ? '命令结束，Codex 正在分析结果' : clip(item.command, 400);
      this.store.log(t, 'command', (finished ? '结束 ' + (item.exitCode ?? item.status) : '执行') + ' · ' + item.command);
    } else if (item.type === 'fileChange') {
      t.current = (finished ? '已处理文件 ' : '正在修改 ') + (item.changes || []).map(c => c.path).join('、');
      this.store.log(t, 'file', t.current);
    } else if (item.type === 'mcpToolCall' || item.type === 'webSearch') {
      t.current = (finished ? '已完成 ' : '正在执行 ') + (item.tool || item.query || item.type);
      this.store.log(t, 'tool', t.current);
    } else return;
    this.store.persist(t);
  }

  markStop(t, kind, details) {
    t.intent = { kind, details }; t.status = 'stopping'; t.current = '等待 Codex 停止写入';
    this.store.persist(t);
  }

  async interrupt(t, run) {
    if (run.interrupting || !run.rpc) return;
    run.interrupting = true;
    if (t.threadId && t.turnId)
      run.rpc.request('turn/interrupt', { threadId: t.threadId, turnId: t.turnId }).catch(() => {});
    // A disconnected or wedged CLI must relinquish the workspace before takeover returns.
    const timer = setTimeout(() => { run.rpc.close().catch(() => {}); run.end(); }, 2500);
    try { await run.ended; } finally { clearTimeout(timer); }
  }

  settle(t, afterCrash) {
    const intent = t.intent;
    t.pid = null; t.birth = null;
    let notify = false, message = null;
    if (intent?.kind === 'cancel') {
      t.status = 'cancelled'; t.lease = false; t.current = '任务已取消';
    } else if (intent?.kind === 'takeover') {
      t.status = 'host'; t.current = '反重力正在临时排障'; this.store.log(t, 'host', intent.details);
    } else if (intent?.kind === 'native' || t.savedOutcome) {
      t.result = intent?.kind === 'native' ? intent.details : t.savedOutcome;
      t.status = t.result.outcome === 'done' ? 'review' : 'blocked';
      t.current = t.result.summary; this.store.log(t, t.status, t.current); notify = true;
      if (t.kind === 'discussion' && t.savedOutcome && t.result.disagreement !== undefined) {
        message = { key:t.runKey+'/reply', speaker:'Astra Max',
          text:[t.result.summary,t.result.evidence,t.result.disagreement,t.result.next].filter(Boolean).join('\n\n') };
      }
    } else if (intent?.kind === 'shutdown' || afterCrash) {
      t.status = 'queued'; t.recovering = true; t.current = '已保存，重开后继续原任务';
    } else {
      t.status = 'blocked'; t.result = stoppedResult('执行意外停止。'); t.current = t.result.summary; notify = true;
    }
    t.savedOutcome = null; t.intent = null;
    this.store.persist(t, notify, message);
  }

  async control(a) {
    const t = this.owned(a), run = this.runs.get(t.id);
    if (a.expectedNotice && a.expectedNotice !== t.noticeId) throw Error('这条通知已过期，请检查任务的最新状态。');
    if (a.action === 'steer') {
      if (t.status !== 'running' || !run || !a.note?.trim()) throw Error('补充指令需要运行中的 Codex 和指令内容。');
      await run.rpc.request('turn/steer', { threadId: t.threadId, expectedTurnId: t.turnId, input: [{ type: 'text', text: a.note }] });
      this.store.log(t, 'host', a.note); this.store.persist(t);
    } else if (a.action === 'cancel' || a.action === 'takeover') {
      if (a.action === 'cancel' && terminal.has(t.status) || a.action === 'takeover' && t.status === 'host') return this.store.view(t);
      if (terminal.has(t.status) || (a.action === 'takeover' && !t.lease)) throw Error('任务尚未获得工作目录，或已结束。');
      if (t.status === 'stopping') throw Error('正在停止 Codex，请待此次接手调用完成。');
      this.markStop(t, a.action, a.note || '');
      if (run) { void this.interrupt(t, run); await run.closed; } else this.settle(t, false);
      this.schedule();
    } else if (a.action === 'resume') {
      if (!['host', 'blocked', 'waiting_user', 'review'].includes(t.status) || !a.note?.trim()) throw Error('交还任务需要待处理的任务和具体的新线索或用户答复。');
      if (t.kind === 'discussion') {
        if (a.difficulty !== undefined || (a.model !== undefined && a.model !== astra) ||
            (a.effort !== undefined && a.effort !== 'max')) throw Error('讨论固定使用 Astra/max，且不接受编码难度。');
      } else Object.assign(t, codingProfile(a.difficulty, a.effort, t, a.model));
      t.prompt = t.kind === 'discussion' ? '反重力对上一轮的追问或新证据：\n' + a.note
        : '反重力已处理上一阶段。原目标：' + t.goal + '\n继续指令：' + a.note;
      t.runKey = randomUUID(); t.turnId = null; t.intent = null; t.recovering = false; t.status = 'queued';
      t.result = null; t.noticeId = null; t.delivery = null; t.deliveryError = '';
      this.store.log(t, 'host', a.note);
      this.store.persist(t, false, t.kind === 'discussion' ? { key:t.runKey+'/question',speaker:'反重力',text:a.note } : null);
      this.schedule();
    } else if (a.action === 'ask_user') {
      if (!['blocked', 'host', 'review', 'waiting_user'].includes(t.status) || !a.note?.trim()) throw Error('请先接手阻塞，并提供需要用户回答的问题。');
      t.status = 'waiting_user'; t.current = clip(a.note); this.store.log(t, 'user', a.note); this.store.persist(t);
    } else if (a.action === 'accept') {
      if (t.status === 'done') return this.store.view(t);
      if (t.status !== 'review') throw Error('只有 Codex 已交付并待验收的任务可以标为完成。');
      if (t.kind === 'discussion' && !a.note?.trim()) throw Error('结束讨论前，请写出反重力综合后的结论或仍存的分歧。');
      t.status = 'done'; t.current = clip(a.note || '反重力已验收'); t.lease = false;
      this.store.log(t, 'accepted', t.current);
      this.store.persist(t, false, t.kind === 'discussion' ? { key:t.runKey+'/conclusion',speaker:'反重力',text:a.note } : null);
      this.schedule();
    } else throw Error('未知操作。');
    return this.store.view(t, true);
  }

  async stop() {
    this.closing = true;
    await Promise.all([...this.runs].map(async ([id, run]) => {
      const t = this.store.tasks.get(id);
      if (!t.intent && !t.savedOutcome) this.markStop(t, 'shutdown', '');
      void this.interrupt(t, run); await run.closed;
    }));
  }
}
