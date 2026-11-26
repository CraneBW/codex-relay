export const sol = 'gpt-6.2-sol';
export const astra = 'gpt-6.2-astra';
export const luna = 'gpt-6-luna';
export const terra = 'gpt-6.1-terra';
export const codingModels = [luna, terra, sol, astra];
export const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const permissions = ['default', 'auto', 'full'];
export const sandboxModes = ['read-only', 'workspace-write', 'danger-full-access'];
export const approvalPolicies = ['untrusted', 'on-request', 'never'];
export const routes = {
  simple: { model: luna, effort: 'low' },
  browser: { model: terra, effort: 'medium' },
  standard: { model: sol, effort: 'high' },
  hard: { model: sol, effort: 'xhigh' },
  exceptional: { model: sol, effort: 'max' },
};
export const difficulties = Object.keys(routes);
export function codingProfile(difficulty, effort, previous, model) {
  const requested = difficulty ?? previous?.difficulty ?? 'standard';
  const level = requested === 'complex' ? 'standard' : requested;
  if (!Object.hasOwn(routes, level)) throw Error('未知的任务难度。');
  const defaults = routes[level];
  const retained = difficulty == null ? previous : undefined;
  const selected = model ?? retained?.model ?? defaults.model;
  const depth = effort ?? retained?.effort ?? defaults.effort;
  if (!codingModels.includes(selected)) throw Error('不支持的编码模型。');
  if (!efforts.includes(depth)) throw Error('不支持的思考等级。');
  if (depth === 'ultra' && selected !== terra) throw Error(selected + ' 的思考等级最高为 max。');
  return { model:selected, effort:depth, difficulty:level };
}

export function sessionPermission({ mode, permission, sandbox, approvalPolicy }, previous) {
  if (permission !== undefined && !permissions.includes(permission)) throw Error('不支持的权限预设 permission。');
  const defaultSandbox = mode === 'read' ? 'read-only' : 'workspace-write';
  const retained = permission === undefined ? previous : undefined;
  if (sandbox === undefined) sandbox = retained?.sandbox ?? (permission === 'full' ? 'danger-full-access' : defaultSandbox);
  if (approvalPolicy === undefined) approvalPolicy = retained?.approvalPolicy ?? (permission === 'auto' || permission === 'full' ? 'never' : 'on-request');
  if (!sandboxModes.includes(sandbox)) throw Error('不支持的沙盒模式 sandbox。');
  if (!approvalPolicies.includes(approvalPolicy)) throw Error('不支持的审批策略 approvalPolicy。');
  if (mode === 'read' && (permission === 'full' || sandbox !== 'read-only'))
    throw Error('只读任务禁止使用完全开放权限（full），沙盒必须为 read-only。');

  let effective = 'custom';
  if (sandbox === 'danger-full-access' && approvalPolicy === 'never') effective = 'full';
  else if (sandbox === defaultSandbox && approvalPolicy === 'never') effective = 'auto';
  else if (sandbox === defaultSandbox && approvalPolicy === 'on-request') effective = 'default';
  return { permission:effective, sandbox, approvalPolicy };
}
