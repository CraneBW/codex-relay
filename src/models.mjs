export const sol = 'gpt-6.2-sol';
export const astra = 'gpt-6.2-astra';
export const luna = 'gpt-6-luna';
export const terra = 'gpt-6.1-terra';
export const codingModels = [luna, terra, sol];
export const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
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
