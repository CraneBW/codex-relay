import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Codex, discussionInstructions, discussionSchema, instructions, outcome, resultSchema } from './codex.mjs';
import { astra, codingProfile, sessionPermission, sol, terra } from './models.mjs';
import { active, clip, now, tail, taskLabel, terminal } from './store.mjs';
import { inside } from './paths.mjs';
import { checkContext } from './context.mjs';
import { requireDirectChild } from './lineage.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const dependencyHeader = '\n\n已验收的上游产出。以下内容供本任务引用。\n';
const maxDependencyContext = 12000;
const maxRecentCommands = 5;
const stoppedResult = (summary, evidence = '', next = '') => ({ outcome: 'blocked', summary: clip(summary), evidence: clip(evidence), next: clip(next) });
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

function taskPermission(a, mode, discussion, previous) {
  if (!discussion) return sessionPermission({ ...a, mode }, previous);
  if ((a.permission !== undefined && a.permission !== 'default') ||
      (a.sandbox !== undefined && a.sandbox !== 'read-only') ||
      (a.approvalPolicy !== undefined && a.approvalPolicy !== 'on-request'))
    throw Error('讨论任务权限固定为 default（read-only + on-request）。');
  return sessionPermission({ mode:'read' });
}

export class Supervisor {
  constructor(store) {
    this.store = store; this.runs = new Map(); this.closing = false;
    const idleMs = Number(process.env.CODEX_RELAY_TURN_IDLE_MS || '1800000');
    this.idleMs = Number.isInteger(idleMs) && idleMs >= 0 && idleMs <= 2147483647 ? idleMs : 1800000;
  }

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

  resolveDependencies(keys, ownTasks, origin, id, requestKey) {
    const ids = new Set();
    for (const key of keys) {
      const upstream = this.store.tasks.get(key) || ownTasks.get(key);
      if (upstream?.id === id || (!upstream && key === requestKey)) throw Error('前置依赖不能指向任务自身。');
      if (upstream?.origin !== origin) throw Error('前置依赖必须是当前对话内已存在的任务：' + key);
      ids.add(upstream.id);
    }

    const path = new Set([id]), visited = new Set();
    const stack = [...ids].map(upstream => [upstream, false]);
    while (stack.length) {
      const [upstream, returning] = stack.pop();
      if (returning) { path.delete(upstream); visited.add(upstream); continue; }
      if (path.has(upstream)) throw Error('前置依赖不能成环。变更已派发任务需要新的 requestKey。');
      if (visited.has(upstream)) continue;
      path.add(upstream);
      stack.push([upstream, true]);
      for (const parent of this.store.tasks.get(upstream)?.dependsOn || []) stack.push([parent, false]);
    }
    return [...ids];
  }

  async dispatch(a, discussion = false) {
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
    if (!['write', 'read'].includes(mode)) throw Error('无效的工作区模式。');
    const access = taskPermission(a, mode, discussion);
    const initialDelegate = discussion ? a.delegate ?? null : null;
    const initialDelegateOrigin = discussion ? a.delegateOrigin ?? null : null;
    if (initialDelegate && initialDelegateOrigin) throw Error('delegate 与 delegateOrigin 只能传一个。');
    const ownByRequest = () => new Map([...this.store.tasks.values()].filter(t => t.origin === origin).map(t => [t.requestKey, t]));
    let ownTasks = ownByRequest();
    if (initialDelegateOrigin && !ownTasks.has(a.requestKey)) {
      await requireDirectChild(origin, initialDelegateOrigin);
      if (this.closing) throw Error('反重力正在关闭，进度已保存。');
      ownTasks = ownByRequest();
    }
    const known = ownTasks.get(a.requestKey), id = known?.id || randomUUID();
    const graphId = a.graphId ?? null, graphTitle = a.graphTitle ?? null, nodeLabel = a.nodeLabel ?? null;
    const dependsOn = this.resolveDependencies(a.dependsOn || [], ownTasks, origin, id, a.requestKey);
    if (known) {
      const originalParents = known.dependsOn || [];
      const legacyAccess = sessionPermission({ mode:known.mode });
      if (access.sandbox !== (known.initialSandbox ?? legacyAccess.sandbox) ||
          access.approvalPolicy !== (known.initialApprovalPolicy ?? legacyAccess.approvalPolicy))
        throw Error('这个 requestKey 的首次派单权限不同。变更派单权限需要新的 requestKey。');
      if ((known.initialDelegate ?? null) !== initialDelegate || (known.initialDelegateOrigin ?? null) !== initialDelegateOrigin)
        throw Error('这个 requestKey 的首次委托参数不同。变更委托需要新的 requestKey。');
      if (known.cwd !== cwd || known.goal !== goal || known.mode !== mode || (known.initialModel ?? known.model) !== model ||
          (known.initialEffort ?? known.effort) !== effort || (known.graphId ?? null) !== graphId ||
          (known.graphTitle ?? null) !== graphTitle || (known.nodeLabel ?? null) !== nodeLabel ||
          originalParents.length !== dependsOn.length || dependsOn.some(parent => !originalParents.includes(parent)))
        throw Error('这个 requestKey 已用于另一个任务。变更任务参数需要新的 requestKey。');
      return this.store.view(known);
    }
    const t = { id, origin, cwd, title: clip(a.title, 160), goal, requestKey: a.requestKey, graphId, graphTitle, nodeLabel, dependsOn,
      kind, mode, model, effort, difficulty, initialModel:model, initialEffort:effort,
      ...access, initialSandbox:access.sandbox, initialApprovalPolicy:access.approvalPolicy,
      status: 'queued', current: '等待执行', created: now(), updated: now(),
      startedAt: null, finishedAt: null, turns: 0,
      lease: false, threadId: null, turnId: null, runKey: randomUUID(), prompt: goal, events: [], command: null, commands: [],
      result: null, savedOutcome: null, intent: null, delivery: null, noticeId: null };
    if (discussion) {
      Object.assign(t, { initialDelegate, initialDelegateOrigin, delegateOrigin: initialDelegateOrigin,
        awaitingDelegate: initialDelegate === 'subagent' });
      if (t.awaitingDelegate) this.store.log(t, 'delegate', '等待子代理认领');
      if (t.delegateOrigin) this.store.log(t, 'delegate', '已绑定直系子代理 ' + t.delegateOrigin);
    }
    this.store.persist(t, false, discussion ? { key: t.runKey + '/question', speaker: '反重力', text: goal } : null);
    this.schedule();
    return this.store.view(t);
  }

  inspect(a) {
    const caller = owner(a);
    const visible = t => t && (t.origin === caller || t.delegateOrigin === caller);
    if (a.id) {
      const t = this.store.tasks.get(a.id);
      if (!visible(t)) throw Error('当前反重力对话没有这项派单。');
      return this.store.view(t, true, a);
    }
    const all = [...this.store.tasks.values()].filter(visible)
      .sort((a,b) => Number(terminal.has(a.status)) - Number(terminal.has(b.status)) || b.updated.localeCompare(a.updated));
    const offset = a.offset || 0;
    return { total:all.length, offset, tasks:all.slice(offset,offset+40).map(t => this.store.view(t)) };
  }

  schedule() {
    if (this.closing || this.runs.size >= this.store.maxConcurrent) return;
    const owners = this.store.writeOwners();
    for (const t of this.store.tasks.values()) {
      if (this.runs.size >= this.store.maxConcurrent) break;
      if (t.status !== 'queued' || t.awaitingDelegate || this.runs.has(t.id)) continue;
      if (this.store.pendingUpstreams(t).length || this.store.writeBlockers(t, owners).length) continue;
      if (t.mode === 'write' && !t.lease) owners.push(t);
      t.lease = true;
      t.status = 'starting'; t.current = t.recovering ? '核对退出前的执行记录' : '正在连接 Codex';
      t.runStartedAt = now(); t.startedAt ??= t.runStartedAt; t.finishedAt = null;
      t.durationMs ??= 0;
      this.store.persist(t);
      void this.execute(t);
    }
  }

  dependencyContext(t) {
    if (!t.dependsOn?.length) return '';
    const sources = t.dependsOn.map(id => {
      const upstream = this.store.tasks.get(id);
      const source = { 节点: taskLabel(upstream), 结论: clip(upstream.result?.summary, 1200),
        证据: clip(upstream.result?.evidence, 1600), 反重力验收备注: clip(upstream.current, 1000) };
      if (upstream.kind === 'discussion') {
        source.分歧与限制 = clip(upstream.result?.disagreement, 1000);
        if (upstream.handoff?.note) source.子代理交接纪要 = clip(upstream.handoff.note, 1000);
      }
      return source;
    });
    const budget = maxDependencyContext - dependencyHeader.length;
    let payload = JSON.stringify(sources, null, 2);
    // Shorten all sources together so a long first result cannot crowd out later dependencies.
    for (let fieldLimit = 1600; payload.length > budget;) {
      fieldLimit = Math.floor(fieldLimit * budget / payload.length);
      payload = JSON.stringify(sources.map(source => Object.fromEntries(
        Object.entries(source).map(([key, value]) => [key, clip(value, fieldLimit)]))), null, 2);
    }
    return dependencyHeader + payload;
  }

  async execute(t) {
    let end;
    const ended = new Promise(resolve => { end = resolve; });
    let closed;
    const run = { end, ended, closed: new Promise(resolve => { closed = resolve; }), final: '', rpc: null, commandIds: new Set() };
    this.runs.set(t.id, run);
    try {
      const rpc = new Codex(t.cwd, packet => this.message(t, run, packet), reason => end({ error: reason }),
        () => { if (!t.intent) run.idleTimer?.refresh(); });
      run.rpc = rpc;
      t.pid = rpc.child.pid || null; t.birth = t.pid ? birth(t.pid) : null;
      this.store.persist(t);
      await rpc.init();
      if (t.intent) return;
      const discussion = t.kind === 'discussion';
      const model = t.model = discussion ? astra : t.model || sol;
      if (discussion || (model !== terra && t.effort === 'ultra')) t.effort = 'max';
      const { permission, sandbox, approvalPolicy } = taskPermission({}, t.mode, discussion, t);
      const opts = { cwd: t.cwd, model, approvalPolicy, sandbox,
        config: { model_reasoning_effort: t.effort },
        developerInstructions: discussion ? discussionInstructions : instructions };
      // A crash can persist the thread before the initial turn is sent.
      const initialPrompt = !t.threadId || (t.recovering && (t.prompt === t.goal || t.runKey === t.initialRunKey));
      const method = t.threadId ? 'thread/resume' : 'thread/start';
      const data = await rpc.request(method, t.threadId ? { ...opts, threadId: t.threadId, excludeTurns: true } : { ...opts, ephemeral: false });
      if (t.threadId && t.threadId !== data.thread.id) throw Error('Codex 返回了不同的会话。原任务已保留。');
      t.threadId = data.thread.id;
      this.store.log(t, 'permission', `${permission} · ${sandbox} · ${approvalPolicy}`);
      this.store.persist(t);
      if (t.intent) return;
      const marker = '[codex-relay:' + t.runKey + ']';
      let live = false;
      if (t.recovering) {
        const history = await rpc.request('thread/turns/list', { threadId: t.threadId, limit: 6, itemsView: 'full', sortDirection: 'desc' });
        const prior = history.data.find(turn => turn.id === t.turnId || turn.items.some(i =>
          i.type === 'userMessage' && i.content.some(c => c.type === 'text' && c.text.includes(marker))));
        if (prior) this.recordTurn(t, prior.id);
        if (prior?.status === 'completed') {
          const text = prior.items.filter(i => i.type === 'agentMessage').at(-1)?.text;
          t.savedOutcome = outcome(text) || stoppedResult('已找到结束的执行轮次，需要反重力核对结果。', text);
          this.store.persist(t); return;
        }
        if (prior?.status === 'inProgress' && data.thread.status?.type === 'active') {
          live = true;
        }
      }
      if (t.intent) return;
      this.watchIdle(t, run);
      if (!live) {
        const recovery = t.recovering ? '\n上次应用退出中断了执行。先核对已有改动、进程和测试结果，再继续未完成的步骤。' : '';
        const context = initialPrompt ? this.dependencyContext(t) : '';
        this.store.log(t, 'model', model + ' · ' + t.effort);
        // Keep workspace-write's writable roots and network access from the thread configuration.
        const sandboxOverride = sandbox === 'danger-full-access' ? { sandboxPolicy:{ type:'dangerFullAccess' } } : {};
        const start = await rpc.request('turn/start', { threadId: t.threadId, model, effort: t.effort,
          approvalPolicy, ...sandboxOverride,
          input: [{ type: 'text', text: marker + '\n' + t.prompt + context + recovery }], outputSchema: discussion ? discussionSchema : resultSchema });
        this.recordTurn(t, start.turn.id);
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
      clearTimeout(run.idleTimer);
      run.idleTimer = undefined;
      if (run.rpc) await run.rpc.close();
      this.runs.delete(t.id);
      this.settle(t, false);
      closed();
      this.schedule();
    }
  }

  watchIdle(t, run) {
    if (!this.idleMs || t.intent) return;
    run.idleTimer = setTimeout(() => {
      run.idleTimer = undefined;
      if (this.closing || t.intent || t.savedOutcome) return;
      this.markStop(t, 'stall', stoppedResult('Codex 轮次无活动超时，已中断。',
        `连续 ${this.idleMs} 毫秒未收到 Codex RPC 活动。`, '检查最后的命令、输出和工作区进度，确认现场后用 resume 继续原任务。'));
      void this.interrupt(t, run);
    }, this.idleMs);
  }

  recordTurn(t, id) {
    if (id && t.turnId !== id) {
      t.turnId = id;
      t.turns = (t.turns ?? 0) + 1;
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
      this.recordTurn(t, p.turn.id); this.store.persist(t); return;
    }
    if (method === 'turn/completed') {
      if (t.turnId && p.turn.id !== t.turnId) return;
      this.recordTurn(t, p.turn.id);
      clearTimeout(run.idleTimer);
      run.idleTimer = undefined;
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
    if (method === 'item/commandExecution/outputDelta') {
      const command = t.commands.find(command => command.id === p.itemId);
      if (command) {
        command.output = tail(command.output + p.delta);
        this.store.preview(t);
      }
      return;
    }
    if (!['item/started', 'item/completed'].includes(method)) return;
    const item = p.item || {}, finished = method === 'item/completed';
    if (item.type === 'agentMessage' && finished) {
      run.final = item.text || '';
      if (item.phase !== 'final_answer' && !outcome(item.text)) {
        t.current = clip(item.text, 400); this.store.log(t, 'message', t.current);
      }
    } else if (item.type === 'commandExecution') {
      const index = t.commands.findIndex(command => command.id === item.id);
      if (index < 0 && run.commandIds.has(item.id)) return;
      run.commandIds.add(item.id);
      const command = { id: item.id, text: clip(item.command, 1200), status: item.status,
        code: item.exitCode ?? null, output: tail(item.aggregatedOutput || t.commands[index]?.output) };
      if (index >= 0) t.commands[index] = command;
      else {
        t.commands.push(command);
        if (t.commands.length > maxRecentCommands) t.commands.shift();
      }
      t.command = t.commands.at(-1);
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
    if (t.runStartedAt) {
      t.finishedAt = afterCrash ? t.updated : now();
      t.durationMs = (t.durationMs ?? 0) + Math.max(0, Date.parse(t.finishedAt) - Date.parse(t.runStartedAt));
      delete t.runStartedAt;
    }
    t.pid = null; t.birth = null;
    let notify = false, message = null;
    if (intent?.kind === 'cancel') {
      t.status = 'cancelled'; t.lease = false; t.current = '任务已取消';
      this.store.log(t, 'cancelled', intent.details || t.current);
    } else if (intent?.kind === 'takeover') {
      t.status = 'host'; t.current = '反重力正在临时排障'; this.store.log(t, 'host', intent.details);
    } else if (intent?.kind === 'native' || intent?.kind === 'stall' || t.savedOutcome) {
      t.result = ['native', 'stall'].includes(intent?.kind) ? intent.details : t.savedOutcome;
      if (intent?.kind === 'stall') {
        t.lease = false;
        if (t.delegateOrigin) {
          t.delegateOrigin = null; t.awaitingDelegate = false;
          this.store.log(t, 'handover', '讨论轮次无活动超时，控制权已交还主对话');
        }
      }
      t.status = t.result.outcome === 'done' ? 'review' : 'blocked';
      t.current = t.result.summary; this.store.log(t, t.status, t.current); notify = true;
      if (t.kind === 'discussion' && t.savedOutcome && t.result.disagreement !== undefined) {
        message = { key:t.runKey+'/reply', speaker:'Astra Max', actor:'astra',
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

  cancelQueuedDownstreams(root) {
    const downstreams = new Map();
    for (const task of this.store.tasks.values()) {
      if (task.origin !== root.origin) continue;
      for (const id of task.dependsOn || []) {
        if (!downstreams.has(id)) downstreams.set(id, []);
        downstreams.get(id).push(task);
      }
    }
    const visited = new Set([root.id]);
    const details = `从上游任务「${taskLabel(root)}」(${root.id}) 级联取消排队任务。`;
    for (const id of visited) {
      for (const task of downstreams.get(id) || []) {
        if (visited.has(task.id)) continue;
        visited.add(task.id);
        if (task.status !== 'queued') continue;
        this.settle({ ...task, events: [...task.events], delegateOrigin: null, awaitingDelegate: false,
          intent: { kind: 'cancel', details } }, false);
      }
    }
  }

  async control(a) {
    const caller = owner(a), t = this.store.tasks.get(a.id);
    if (!t) throw Error('当前反重力对话没有这项派单。');
    const main = t.origin === caller;
    const discussion = t.kind === 'discussion';
    if (discussion && !main && ['accept', 'cancel'].includes(a.action))
      throw Error('只有主对话可以验收或取消讨论。请先调用 handover 交还主对话。');
    if (a.action !== 'claim' && !main && t.delegateOrigin !== caller) throw Error('当前反重力对话没有这项派单。');
    if ((a.action === 'claim' || a.action === 'handover') && !discussion) throw Error('只有讨论任务支持认领和交接。');
    if (!main && !['claim', 'handover', 'resume'].includes(a.action)) throw Error('此操作仅限主对话。');
    if (a.action !== 'resume' && (a.permission !== undefined || a.sandbox !== undefined || a.approvalPolicy !== undefined))
      throw Error('会话权限参数仅用于 resume。');
    if (a.action === 'claim' && t.delegateOrigin !== caller) {
      await requireDirectChild(t.origin, caller);
      if (this.closing) throw Error('反重力正在关闭，进度已保存。');
    }
    if (a.expectedNotice && a.expectedNotice !== t.noticeId) throw Error('这条通知已过期，请检查任务的最新状态。');
    const run = this.runs.get(t.id);
    if (a.action === 'claim') {
      if (terminal.has(t.status)) throw Error('讨论已结束，无法认领。');
      if (t.delegateOrigin === caller) return this.store.view(t, true);
      if (t.delegateOrigin) throw Error('讨论已由另一位子代理认领。');
      if (t.status !== 'queued' || !t.awaitingDelegate) throw Error('讨论当前未等待子代理认领。');
      t.delegateOrigin = caller; t.awaitingDelegate = false;
      const note = a.note?.trim();
      if (note) {
        t.initialRunKey = t.runKey;
        t.prompt = t.goal + '\n\n反重力子代理认领时补充的材料\n' + note;
      }
      this.store.log(t, 'delegate', '直系子代理已认领讨论 ' + caller);
      this.store.persist(t, false, note ? { key:t.runKey+'/question', speaker:'反重力', actor:'main', text:t.prompt, amend:true } : null);
      this.schedule();
    } else if (a.action === 'handover') {
      if (terminal.has(t.status) || (!main && !['queued', 'review', 'blocked', 'waiting_user'].includes(t.status)))
        throw Error('子代理须等待当前轮次结束后交接。主对话可收回未结束的讨论。');
      t.delegateOrigin = null; t.awaitingDelegate = false;
      const note = a.note?.trim();
      if (note) t.handoff = { note, by: caller, at: now() };
      this.store.log(t, 'handover', main ? '主对话已收回讨论控制权' : '子代理已交还讨论控制权');
      this.store.persist(t);
      if (t.status === 'queued') this.schedule();
    } else if (a.action === 'steer') {
      if (t.status !== 'running' || !run || !a.note?.trim()) throw Error('补充指令需要运行中的 Codex 和指令内容。');
      run.idleTimer?.refresh();
      await run.rpc.request('turn/steer', { threadId: t.threadId, expectedTurnId: t.turnId, input: [{ type: 'text', text: a.note }] });
      this.store.log(t, 'host', a.note); this.store.persist(t);
    } else if (a.action === 'cancel' || a.action === 'takeover') {
      const cascade = a.action === 'cancel' && a.cascade;
      if (a.action === 'cancel' && terminal.has(t.status) || a.action === 'takeover' && t.status === 'host') {
        if (cascade) this.cancelQueuedDownstreams(t);
        return this.store.view(t);
      }
      if (terminal.has(t.status) || (a.action === 'takeover' && !t.lease)) throw Error('任务尚未获得工作目录，或已结束。');
      if (t.status === 'stopping') throw Error('正在停止 Codex，请待此次接手调用完成。');
      if (discussion) { t.delegateOrigin = null; t.awaitingDelegate = false; }
      this.markStop(t, a.action, a.note || '');
      if (run) { void this.interrupt(t, run); await run.closed; } else this.settle(t, false);
      if (cascade) this.cancelQueuedDownstreams(t);
      this.schedule();
    } else if (a.action === 'resume') {
      if (!['host', 'blocked', 'waiting_user', 'review'].includes(t.status) || !a.note?.trim()) throw Error('交还任务需要待处理的任务和具体的新线索或用户答复。');
      const access = taskPermission(a, t.mode, discussion, t);
      if (discussion) {
        if (a.difficulty !== undefined || (a.model !== undefined && a.model !== astra) ||
            (a.effort !== undefined && a.effort !== 'max')) throw Error('讨论固定使用 Astra/max，且不接受编码难度。');
        if (main) { t.delegateOrigin = null; t.awaitingDelegate = false; }
      } else Object.assign(t, codingProfile(a.difficulty, a.effort, t, a.model));
      const legacyAccess = sessionPermission({ mode:t.mode });
      t.initialSandbox ??= legacyAccess.sandbox;
      t.initialApprovalPolicy ??= legacyAccess.approvalPolicy;
      Object.assign(t, access);
      t.prompt = discussion ? `反重力${main ? '主对话' : '子代理'}对上一轮的追问或新证据：\n` + a.note
        : '反重力已处理上一阶段。原目标：' + t.goal + '\n继续指令：' + a.note;
      t.runKey = randomUUID(); t.turnId = null; t.intent = null; t.recovering = false; t.status = 'queued';
      t.result = null; t.noticeId = null; t.delivery = null; t.deliveryError = '';
      this.store.log(t, 'host', a.note);
      this.store.persist(t, false, discussion ? { key:t.runKey+'/question', speaker:'反重力', actor:main ? 'main' : 'subagent', text:a.note } : null);
      this.schedule();
    } else if (a.action === 'ask_user') {
      if (!['blocked', 'host', 'review', 'waiting_user'].includes(t.status) || !a.note?.trim()) throw Error('请先接手阻塞，并提供需要用户回答的问题。');
      if (discussion) { t.delegateOrigin = null; t.awaitingDelegate = false; }
      t.status = 'waiting_user'; t.current = clip(a.note); this.store.log(t, 'user', a.note); this.store.persist(t);
    } else if (a.action === 'accept') {
      if (t.status === 'done') return this.store.view(t);
      if (t.status !== 'review') throw Error('只有 Codex 已交付并待验收的任务可以标为完成。');
      if (discussion && !a.note?.trim()) throw Error('结束讨论前，请写出主对话独立综合后的结论或仍存的分歧。');
      if (discussion) { t.delegateOrigin = null; t.awaitingDelegate = false; }
      t.status = 'done'; t.current = clip(a.note || '反重力已验收'); t.lease = false;
      this.store.log(t, 'accepted', t.current);
      this.store.persist(t, false, discussion ? { key:t.runKey+'/conclusion', speaker:'反重力', actor:'main', text:a.note } : null);
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
