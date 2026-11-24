import { button, el, interrupted, patch, plainPreview, queueText, stateBadge, time, withKeys } from './ui.mjs';
import { field, hasText, interruption, sameText, section } from './content.mjs';
import { prose } from './markdown.mjs';

const ag = '反重力';
const astra = 'Astra Max';
const speakerTone = speaker => speaker === ag ? 'antigravity' : speaker === astra ? 'astra' : 'sol';
const speakerBadge = speaker => el('span', speaker, `model-badge model-${speakerTone(speaker)}`);
const letters = new Intl.NumberFormat('zh-CN');
const characters = text => [...text.replace(/\s/g, '')].length;

function getRounds(task) {
  const messages = task.discussion || [];
  const final = task.status === 'done' && messages.at(-1)?.speaker === ag ? messages.at(-1) : null;
  const replies = final ? messages.slice(0, -1) : messages;
  const rounds = [];
  const keys = withKeys(replies, message => [message.at, message.speaker, message.body.slice(0, 80)]);
  for (const [key, message] of keys) {
    if (!rounds.length || message.speaker === ag) rounds.push({ key, messages:[] });
    rounds.at(-1).messages.push([key, message]);
  }
  return { rounds, final, capped:messages.length >= 8, count:replies.length };
}

function messageBody(message, repeated = false) {
  const tone = speakerTone(message.speaker);
  const article = el('article', null, `message speaker-${tone}`);
  article.dataset.scrollAnchor = '';
  const head = el('header', null, 'message-head');
  head.append(speakerBadge(message.speaker), time(message.at));
  article.append(head);
  if (repeated) {
    const source = el('details', null, 'message-source');
    source.append(el('summary', '查看 Astra Max 原始发言'), prose(message.body));
    article.append(source);
  } else article.append(prose(message.body));
  return article;
}

function consensusEntry(task, final, showEmpty) {
  const { status, result } = task;
  if (!final && ![result?.summary, result?.disagreement, result?.evidence, result?.next].some(hasText)) {
    return showEmpty ? [['no-consensus', status, () => el('p', '本轮结论将在回复后显示。', 'empty-note')]] : [];
  }
  return [['consensus', [status, final, result], ([state, closing, outcome]) => {
    const root = section(state === 'done' ? '最终共识' : '本轮结论', 'consensus');
    if (closing) {
      root.append(messageBody(closing));
      if (!sameText(closing.body, outcome?.summary)) field(root, 'Astra Max 的结论', outcome?.summary);
    } else if (hasText(outcome?.summary)) root.append(prose(outcome.summary));
    field(root, '核心分歧', outcome?.disagreement);
    field(root, '关键依据', outcome?.evidence);
    field(root, '后续检验与行动', outcome?.next);
    return root;
  }]];
}

function progressEntry(task, count, capped) {
  if (task.status === 'done' || task.status === 'cancelled') return [];
  if (interrupted.has(task.status)) return interruption(task);
  const focus = task.status === 'review' ? task.result?.next : queueText(task) || task.current;
  return [['discussion-progress', [task.status, count, capped, focus], ([status, number, windowed, text]) => {
    const root = section(null, 'discussion-progress');
    const heading = el('div', null, 'section-line');
    const round = number ? `${windowed ? '本段' : ''}第 ${number} 轮` : '讨论进度';
    heading.append(el('h3', round), stateBadge({ status, kind:'discussion' }));
    root.append(heading);
    if (hasText(text)) {
      const label = status === 'review' ? '待回应焦点' : '';
      const snippet = plainPreview(text, 220);
      root.append(el('p', label ? `${label} · ${snippet}` : snippet, 'step-text'));
    }
    return root;
  }]];
}

function roundEntry(round, preferences) {
  const update = (root, value) => {
    const { number, windowed, messages, repeated } = value;
    const speakers = [...new Set(messages.map(([, message]) => message.speaker))];
    const first = messages[0][1];
    const last = messages.at(-1)[1];
    const count = letters.format(messages.reduce((sum, [, message]) => sum + characters(message.body), 0));
    const heading = el('span', null, 'round-heading');
    heading.append(el('strong', `${windowed ? '本段' : ''}第 ${number} 轮`), ...speakers.map(speakerBadge),
      el('span', `${count} 字`, 'count'), time(last.at));
    const preview = el('span', plainPreview(first.body, 135), 'round-preview');
    root.querySelector('summary').replaceChildren(heading, preview);
    patch(root.querySelector('.round-messages'), messages.map(([key, message]) => {
      const repeat = repeated && message.speaker === astra && message.body === repeated;
      return [key, [message, repeat], ([item, duplicate]) => messageBody(item, duplicate)];
    }));
  };
  const { key, ...data } = round;
  return [key, data, value => {
    const root = el('details', null, 'round');
    root.dataset.scrollAnchor = '';
    root.dataset.roundKey = key;
    const summary = el('summary');
    summary.onclick = event => {
      event.preventDefault();
      root.open = !root.open;
      preferences.rounds.set(key, root.open);
    };
    root.append(summary, el('div', null, 'round-messages'));
    update(root, value);
    return root;
  }, update];
}

function historyEntry(data, preferences) {
  if (!data.rounds.length) return [];
  const update = (root, value) => {
    const list = root.querySelector('.round-list');
    const actions = root.querySelector('.round-actions');
    const capped = root.querySelector('.history-window');
    actions.hidden = value.count <= 2;
    capped.hidden = !value.capped;

    function paintRounds() {
      patch(list, value.rounds.map((round, i) => roundEntry({
        ...round, number:i + 1, windowed:value.capped, repeated:i === value.rounds.length - 1 ? value.repeated : '',
      }, preferences)));
      value.rounds.forEach(({ key }, i) => {
        const defaultOpen = preferences.discussionMode === 'all' || value.count <= 2 || i === value.rounds.length - 1;
        list.children[i].open = preferences.rounds.get(key) ?? defaultOpen;
      });
    }
    for (const option of actions.children) {
      option.setAttribute('aria-pressed', String(preferences.discussionMode === option.dataset.mode));
      option.onclick = () => {
        preferences.discussionMode = option.dataset.mode;
        preferences.rounds.clear();
        for (const control of actions.children) control.setAttribute('aria-pressed', String(control === option));
        paintRounds();
      };
    }
    paintRounds();
  };

  return [['rounds', data, value => {
    const root = section(null, 'discussion-history');
    const header = el('div', null, 'section-line');
    const actions = el('div', null, 'round-actions');
    for (const [mode, label] of [['all', '展开全部轮次'], ['recent', '仅看最近']]) {
      const control = button(label, 'text-control');
      control.dataset.mode = mode;
      actions.append(control);
    }
    header.append(el('h3', '讨论记录'), actions);
    root.append(header, el('p', '面板最多显示最近 8 条发言。', 'history-window'), el('div', null, 'round-list'));
    update(root, value);
    return root;
  }, update]];
}

export function discussionEntries(task, tab, { state }) {
  const { rounds, final, capped, count } = getRounds(task);
  const consensus = consensusEntry(task, final, tab === 'consensus');
  if (tab === 'consensus') return consensus;
  const result = task.result;
  const last = rounds.at(-1)?.messages.at(-1)?.[1];
  const concatenated = [result?.summary, result?.evidence, result?.disagreement, result?.next].filter(Boolean).join('\n\n');
  const repeated = task.status === 'done' && last?.speaker === astra && last.body === concatenated.slice(0, 16000)
    ? last.body : '';
  return [
    ...progressEntry(task, rounds.length, capped),
    ...(task.status === 'done' ? consensus : []),
    ...historyEntry({ rounds, capped, count, repeated }, state),
  ];
}
