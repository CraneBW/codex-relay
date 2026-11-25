# Codex 调度台

日常工作只和反重力交互。直接在 Antigravity 对话里描述目标、补充信息、询问进度或叫停任务。反重力自行选择执行模型、邀请 Astra 讨论、处理阻塞，并在原对话给出验收结果。Codex 在当前工作目录执行。Codex 交付或遇阻时，插件向原对话发送事件。平时可以继续聊天、切换项目或关闭任务面板。

## 安装

适用 Linux、Antigravity 桌面应用、本机已配置的 Codex CLI 和 Node.js 22.13 或更高版本。发布包包含编译好的 MCP 服务与面板。解压后进入 `codex-relay` 目录，运行

```sh
node scripts/install.mjs
```

安装器将插件复制到 `~/.gemini/config/plugins/codex-relay/`，并启用 `codex-relay/events` 后台组件。更新已有 `config.json` 前会在同目录保存备份。可重复安装或升级，安装器会按文件校验已安装版本，发现本地修改时提示具体路径。

打开反重力项目，直接说“修复登录测试，跑通后告诉我”。在侧面板的 **＋ → 插件 → Codex 任务** 打开面板，也可以在对话中说“打开 Codex 任务面板”。如果安装前应用已经打开且尚未发现新组件，重新打开桌面应用。Google 的桌面应用负责启动和停止该后台组件。[插件开发文档](https://antigravity.google/docs/build-plugins/) · [后台组件文档](https://antigravity.google/docs/sidecars)

## 任务如何流转

- 反重力按任务选择默认模型和思考等级。简单修改用 `simple`（`gpt-6-luna` / `low`），实际点击、填表或截图验收等浏览器操作用 `browser`（`gpt-6.1-terra` / `medium`），纯前端代码修改按开发难度选档。常规开发和调试用 `standard`（`gpt-6.2-sol` / `high`），也是省略 `difficulty` 时的默认值。困难任务用 `hard`（Sol / `xhigh`），极高难度或错误代价高用 `exceptional`（Sol / `max`）。
- `relay_dispatch` 支持独立指定 `model` 和 `effort`，省略的参数按难度取默认值。例如只指定 `effort: low` 时，默认仍用 Sol。编码任务 `resume` 时也可以独立指定两项。给出 `difficulty` 时，省略的参数按新难度取默认值。省略 `difficulty` 时，省略的参数沿用上一轮。Luna 和 Sol 最高 `max`，Terra 可用 `ultra`。
- 同目录只读任务可以并发，包括 Astra Max 讨论。工作目录互不包含的写任务也可并发。同一目录或上下级目录的写任务排队，面板展示排队原因及占锁任务，当前任务验收或取消后释放写锁。任务使用当前项目目录。
- `relay_dispatch` 和 `relay_discuss` 可以用同一对话内的 `graphId` 组成任务依赖图。`graphTitle` 设置任务群标题，`nodeLabel` 设置节点短名。先派独立节点，再以任务 UUID 或 `requestKey` 填写下游的 `dependsOn`。上游进入 `review` 后由反重力逐项验收，全部 `accept` 后下游自动参与调度。首次启动时会收到已验收上游的结论、证据与验收备注。
- 反重力可以主动邀请 **Astra Max** 讨论实验、结果和方案。你也可以说“请和 Astra Max 讨论这个实验的两个解释”。讨论固定使用 `gpt-6.2-astra` 和 `max`，以只读方式核对项目材料。反重力可以带着反例在同一会话追问。双方的发言和最终结论保存在 SQLite，面板可展开最近的讨论记录。
- 面板的任务列表、依赖图和详情头部都显示当前模型、思考等级和会话权限，续跑调整后随状态刷新。完全开放、免审批和严格审批均有文字标识。详情还可查看目标、目录、当前步骤、最近命令、输出片段和测试退出码。
- 有任务群时，面板按依赖层级绘制节点和箭头，可切换任务群并点击任意节点查看详情。详情中的前置任务和后续任务可直接跳转。`relay_board` 和 `relay_board_changes` 提供完整的 `graphs`，任务列表分页时图仍保留全部节点。
- 一次命令失败会记入进度。当 Codex 明确报告无法推进、请求宿主介入，或执行轮次异常结束时，插件唤醒反重力。它可以给 Codex 一条新线索，也可以先接手工作目录解决问题，再把结论交还原会话。
- Codex 报告交付后，反重力收到事件并核对文件和验证结果。只有新线索耗尽、需要用户决策或需要用户提供信息时，反重力才在原对话里提问。
- 完全退出应用时保存进度并停止执行。重开后沿用原 Codex 会话，核对退出前已完成的步骤，再安排余下工作。运行到一半的系统进程需要检查现场后续跑。

## 会话权限

反重力可在 `relay_dispatch` 派发编码任务，或在 `relay_control` 的 `resume` 续跑时，显式选择 `permission`。

| 预设 | 沙盒模式 | 审批策略 | 使用时机 |
| --- | --- | --- | --- |
| `default` | `read` 用 `read-only`，`write` 用 `workspace-write` | `on-request` 按需审批 | 日常任务，首次派单省略权限时使用 |
| `auto` | 同 `default` | `never` 免审批 | 用户已授权免审批，且操作可在所选沙盒内完成 |
| `full`（完全开放权限） | `danger-full-access` | `never` 免审批 | 用户明确要求完全开放，或任务确需跨工作区、联网等操作且用户已授权解除沙盒与免审批 |

可独立覆盖 `sandbox` 或 `approvalPolicy`。`read-only` 只读，`workspace-write` 允许在工作区写入并沿用 Codex 的联网配置，`danger-full-access` 移除 Codex 沙盒限制。`on-request` 允许按需申请审批，`untrusted` 对非可信命令请求审批，`never` 禁止发起审批并遵循所选沙盒。`mode: read` 只允许 `read-only`，禁止 `full`。目录写锁按任务的 `mode` 和工作目录调度。Astra Max 讨论及追问固定为 `default`（`read-only` + `on-request`）。

续跑时传入 `permission`，省略的沙盒或审批项按新预设选择。省略 `permission` 时，逐项沿用上一轮。`requestKey` 重试按首次派单的权限组合核对，变更首次权限时需要新的 `requestKey`。发生 `requestApproval` 且操作超出现有授权时，反重力先用 `ask_user` 标记等待并在原对话征求确认，禁止静默切换到 `full`。

面板「详细信息」显示完整的沙盒模式和审批策略。`relay_inspect`、`relay_board` 和 `relay_board_changes` 返回 `permission`、`sandbox` 和 `approvalPolicy`。`permission: custom` 表示实际组合不同于该任务模式的三个预设。

## 本地数据与事件

SQLite 的 `tasks.sqlite` 位于 Antigravity 分配给该后台组件的持久化数据目录，通常为 `~/.gemini/antigravity/sidecar_data/codex-relay/events/data/`。数据库存放任务、原对话 ID、Codex 会话 ID、队列、当前状态、近期活动和待投递事件。项目文件保存在派单工作目录。Codex 本身管理其会话历史。[Google 后台组件数据目录](https://antigravity.google/docs/sidecars) · [Codex App Server](https://developers.openai.com/codex/app-server)

任务转入“等待反重力”或“等待验收”时，状态和通知一起提交到 SQLite。后台组件调用 `agentapi send-message` 投递到原对话，失败后退避重试。极端情况下，宿主已收件但插件尚未来得及记录回执，重开会重送同一个事件 ID。接收方按事件 ID 和任务当前状态核对。外部命令的副作用由续跑时的现场检查确认。

面板使用 Antigravity 的 MCP Apps 侧栏接口。工作区和原对话由宿主钩子注入，后台组件通过仅本机当前用户可访问的 Unix 套接字与 MCP 服务通信。[MCP Apps 面板](https://antigravity.google/docs/mcp-apps/) · [宿主钩子](https://antigravity.google/docs/hooks)

## 从源码构建

```sh
npm ci
npm run build
```

MCP 服务与面板在 `dist/`。后台组件和 Codex 协议处理在 `sidecars/events/` 与 `src/`。反重力处理阻塞、验收和向用户提问的规则在 `rules/AGENTS.md`。

输入 `/codex-playbook` 查看随插件安装的中文提示词，涵盖编码派单、并行拆解与依赖图、阻塞交接、实验设计、结果复核、方案比较和同一会话追问。[提示词全文](skills/codex-playbook/SKILL.md)

运行 `npm test` 可复测派单和续跑的模型、思考等级与会话权限，以及并发与写锁、依赖图与验收门控、阻塞交接、通知重试和进程恢复。这组测试使用临时目录与可控的 Codex 进程。运行 `python3 -B tests/probe.py` 或 `python3 -B tests/discussion.py` 会分别调用真实编码模型或 Astra Max，使用本机 Codex 账户，并把测试通知送到临时接收器。
