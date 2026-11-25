import net from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { socketPath } from './paths.mjs';
import { approvalPolicies, astra, codingModels, difficulties, efforts, permissions, sandboxModes } from './models.mjs';

const server = new McpServer({ name: 'codex-relay', version: '0.1.1' });
const uri = 'ui://codex-relay/board.html';
const panelPath = join(dirname(process.argv[1]), 'board.html');
const context = {
  origin: z.string().optional().describe('由反重力钩子写入当前对话 ID。'),
  roots: z.array(z.string()).max(100).optional().describe('由反重力钩子写入挂载的目录。'),
  hostProof: z.string().optional().describe('由宿主钩子填写，调用方省略。'),
};
const graph = {
  graphId: z.string().trim().min(1).max(140).optional().describe('同一反重力对话内的任务群标识。'),
  graphTitle: z.string().trim().min(1).max(160).optional().describe('任务群在面板上的标题。'),
  nodeLabel: z.string().trim().min(1).max(80).optional().describe('依赖图节点短名，默认使用任务标题。'),
  dependsOn: z.array(z.string().trim().min(1).max(140)).max(24).optional().describe('同一对话内已有上游任务的 UUID 或 requestKey。全部验收后启动。'),
};
const taskId = z.string().uuid();
const appOnly = { ui: { visibility: ['app'] } };
const modelOnly = { ui: { visibility: ['model'] } };
const codingRoutes = 'simple 为 Luna/low（简单修改），browser 为 Terra/medium（实际点击、填表或截图验收，纯前端开发按难度选择），standard 为 Sol/high（常规开发和调试，默认），hard 为 Sol/xhigh，exceptional 为 Sol/max。';
const effortLimit = 'Terra 可用 ultra，Luna 和 Sol 最高 max。';
const permissionPresets = 'default 按 mode 选择沙盒并按需审批，auto 保留同样的沙盒并免审批，full 为完全开放权限（danger-full-access + never）。mode 为 read 时仅可使用 read-only 沙盒，禁止 full。';
const sessionPermissions = {
  permission: z.enum(permissions).optional().describe(permissionPresets + ' 仅在用户授权范围内启用 auto 或 full。'),
  sandbox: z.enum(sandboxModes).optional().describe('独立覆盖预设沙盒。read-only 为只读，workspace-write 允许工作区写入，danger-full-access 移除 Codex 沙盒限制。'),
  approvalPolicy: z.enum(approvalPolicies).optional().describe('独立覆盖预设审批策略。on-request 按需审批，untrusted 对非可信命令请求审批，never 禁止发起审批且保留所选沙盒。'),
};

function request(method, args, signal) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    const abort = () => socket.destroy(new Error('视图或请求已关闭。'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.setEncoding('utf8');
    socket.setTimeout(40000, () => socket.destroy(new Error('任务进程未及时响应。')));
    socket.on('connect', () => socket.write(JSON.stringify({ method, args }) + '\n'));
    socket.on('data', part => { response += part; });
    socket.once('end', () => {
      try { const value = JSON.parse(response); if (value.error) reject(Error(value.error)); else resolve(value.result); }
      catch (e) { reject(e); }
    });
    socket.on('close', () => signal?.removeEventListener('abort', abort));
    socket.on('error', error => reject(['ENOENT','ECONNREFUSED'].includes(error.code)
      ? Error('任务进程未连接。请启用 codex-relay/events 后台组件，并检查反重力能找到 node 和 codex。') : error));
    if (signal?.aborted) abort();
  });
}
const result = (data, text) => ({ content: [{ type: 'text', text: text || JSON.stringify(data) }], structuredContent: data });
const failure = error => ({ isError: true, content: [{ type: 'text', text: error.message }] });
function register(name, description, shape, method) {
  server.registerTool(name, { description, inputSchema: shape, _meta: modelOnly }, async (a, extra) => {
    try { return result(await request(method, a, extra.signal)); } catch (e) { return failure(e); }
  });
}
register('relay_dispatch', '将实现、修复或测试交给 Codex。' + codingRoutes + ' 可独立覆盖 model 和 effort，省略的参数按难度取默认值。会话权限省略时使用 default。' + permissionPresets + ' 立即返回任务 ID，完成或阻塞会唤醒原对话。收到回执后结束本轮，不调用状态工具等待。', {
  requestKey: z.string().trim().min(1).max(140).describe('本对话内唯一且可重试的任务标识；重试用原值。'),
  title: z.string().trim().min(1).max(160), goal: z.string().trim().min(1).max(24000),
  cwd: z.string().max(4096).optional(), mode: z.enum(['read','write']).default('write').describe('read 默认只读沙盒，write 默认工作区写入沙盒并参与目录写锁。'),
  difficulty: z.enum(difficulties).optional().describe(codingRoutes),
  model: z.enum(codingModels).optional().describe('独立指定编码模型。省略时使用难度对应的默认模型。'),
  effort: z.enum(efforts).optional().describe('独立指定思考等级。省略时使用难度对应的默认等级。' + effortLimit), ...sessionPermissions, ...graph, ...context,
}, 'dispatch');
register('relay_discuss', '邀请 Astra Max 与反重力讨论实验、结果或方案。可由反重力主动邀请；Astra 在只读项目中核对材料，返回时唤醒原对话。', {
  requestKey:z.string().trim().min(1).max(140), title:z.string().trim().min(1).max(160),
  question:z.string().trim().min(1).max(6000), position:z.string().trim().min(1).max(7000).describe('反重力当前的判断、怀疑或候选解释。'),
  materials:z.string().max(10000).optional().describe('相关文件路径、已运行的结果或约束。'),
  cwd:z.string().max(4096).optional(), ...graph, ...context,
}, 'discuss');
register('relay_inspect', '读取本对话所派任务。省略 id 可找回该对话的任务列表，指定 id 查看结果、证据与活动。按事件或用户请求查询。', {
  id:taskId.optional(), offset:z.number().int().nonnegative().optional(), ...context,
}, 'inspect');
register('relay_control', 'steer 追加指令，takeover 等 Codex 停止后交出工作区，resume 在原会话续跑，ask_user 标记等待用户，accept 验收并释放写锁及满足条件的下游，cancel 取消。编码续跑可独立覆盖 model 和 effort。给出 difficulty 时，省略的参数按新难度取默认值，否则沿用上一轮对应值。权限参数仅用于 resume。给出 permission 时，省略的权限项按预设取值，否则逐项沿用上轮。' + permissionPresets + ' 讨论续跑固定 Astra/max、read-only、on-request。', {
  id: taskId, action: z.enum(['steer','takeover','resume','ask_user','accept','cancel']),
  note: z.string().max(10000).optional(), expectedNotice: z.string().uuid().optional().describe('从通知操作任务时填写通知事件 ID。'), ...context,
  difficulty: z.enum(difficulties).optional().describe('用于编码续跑。省略时保留上一轮难度。' + codingRoutes),
  model: z.enum([...codingModels, astra]).optional().describe('resume 独立指定下一轮模型。编码任务省略时按新难度取默认模型，未改难度时沿用上一轮。Astra 仅用于讨论任务。'),
  effort: z.enum(efforts).optional().describe('resume 独立指定下一轮思考等级。编码任务省略时按新难度取默认等级，未改难度时沿用上一轮。' + effortLimit + ' Astra 讨论固定 max。'),
  ...sessionPermissions,
}, 'control');

server.registerResource('Codex 任务面板', uri, { mimeType: 'text/html;profile=mcp-app', _meta: { ui: { prefersBorder: false } } },
  async () => ({ contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: readFileSync(panelPath, 'utf8'), _meta: { ui: { prefersBorder: false } } }] }));
server.registerTool('relay_board', { title: 'Codex 任务', description: '打开反重力所派 Codex 任务的只读侧面板。', inputSchema: {},
  _meta: { ui: { resourceUri: uri }, 'com.google.antigravity/ui': { entrypoints: [{ type: 'aux_pane', title: 'Codex 任务' }] } },
}, async (_, extra) => {
  try { const data = await request('board', {}, extra.signal); return result(data, '任务面板，共 ' + data.total + ' 项。'); }
  catch (e) { return result({ offline: e.message }, e.message); }
});
server.registerTool('relay_board_changes', { description: '面板读取或等待任务状态变化。', _meta: appOnly,
  inputSchema: { selected: taskId.optional(), revision: z.string().max(100).optional(),
    offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(40) },
}, async (args, extra) => {
  try { return result(await request('board', args, extra.signal), '任务视图已更新。'); } catch (e) { return failure(e); }
});
server.connect(new StdioServerTransport()).catch(e => { console.error(e.message); process.exitCode = 1; });
