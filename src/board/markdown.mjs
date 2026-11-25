import { Marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import sql from 'highlight.js/lib/languages/sql';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import diff from 'highlight.js/lib/languages/diff';
import yaml from 'highlight.js/lib/languages/yaml';
import temml from 'temml';
import DOMPurify from 'dompurify';
import { copyButton, el } from './ui.mjs';

for (const [name, language] of Object.entries({ javascript, typescript, python, bash, json, sql, css, xml, markdown, diff, yaml })) {
  hljs.registerLanguage(name, language);
}
hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName:'bash' });

const replaceHtml = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
const escapeHtml = text => text.replace(/[&<>"']/g, char => replaceHtml[char]);
const markdownPolicy = {
  ALLOWED_TAGS: ['a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt',
    'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'input', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's',
    'samp', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul'],
  ALLOWED_ATTR: ['href', 'title', 'class', 'start', 'value', 'align', 'rowspan', 'colspan', 'scope', 'type',
    'checked', 'disabled', 'open', 'data-board-math'],
  ADD_URI_SAFE_ATTR: ['start', 'align', 'rowspan', 'colspan', 'scope', 'type', 'data-board-math'],
  ALLOWED_URI_REGEXP: /^(?:https?:\/\/|mailto:)/i,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
};
const mathPolicy = {
  USE_PROFILES: { mathMl:true },
  FORBID_ATTR: ['href', 'src', 'xlink:href'],
  ALLOW_DATA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
};

function mathToken(src, block, literal) {
  if (literal) return;
  const indent = block ? /^ {0,3}/.exec(src)[0] : '';
  const input = src.slice(indent.length);
  const display = input.startsWith('$$') || input.startsWith('\\[');
  let match;
  if (input.startsWith('$$')) match = /^\$\$((?:\\[\s\S]|[^\\$]|\$(?!\$))+?)\$\$/.exec(input);
  else if (input.startsWith('\\[')) match = /^\\\[((?:\\(?!\])[\s\S]|[^\\])+?)\\\]/.exec(input);
  else if (!block && input.startsWith('\\(')) match = /^\\\(((?:\\(?!\))[^\r\n]|[^\\`\r\n])+?)\\\)/.exec(input);
  else if (!block && input.startsWith('$')) {
    match = /^\$((?:\\[^\r\n]|[^\\$`\r\n])+?)\$(?![A-Za-z0-9_$])/.exec(input);
    if (match && (/^\s|\s$/.test(match[1]) || /^[A-Z_][A-Z0-9_]{1,}$/.test(match[1]))) return;
  }
  if (!match?.[1].trim() || (!block && /[\r\n]/.test(match[0]))) return;
  if (/(?:^|\n) {0,3}(?:`{3,}|~{3,})/.test(match[1])) return;
  let raw = indent + match[0];
  if (block) {
    const end = /^[ \t]*(?:\n|$)/.exec(src.slice(raw.length));
    if (!end) return;
    raw += end[0];
  }
  return { type:block ? 'displayMath' : 'inlineMath', raw, formula:match[1].trim(), display };
}

function mathExtension(block, formulas) {
  return {
    name:block ? 'displayMath' : 'inlineMath',
    level:block ? 'block' : 'inline',
    start(src) {
      if (!block) return src.search(/\$|\\[([]/);
      const newline = src.search(/\n(?= {0,3}(?:\$\$|\\\[))/);
      return newline < 0 ? undefined : newline + 1;
    },
    tokenizer(src) {
      return mathToken(src, block, this.lexer.state.inRawBlock);
    },
    renderer(token) {
      const i = formulas.push(token) - 1;
      const tag = block ? 'div' : 'span';
      return `<${tag} data-board-math="${i}"></${tag}>`;
    },
  };
}

const fullWidthPunctuation = /^[“”‘’「」『』（）［］｛｝《》〈〉【】〔〕、，。；：！？]$/u;
const endsWithHan = /\p{Script=Han}$/u;
const startsWithHan = /^\p{Script=Han}/u;
const cjkStrong = {
  name:'cjkStrong',
  level:'inline',
  childTokens:['tokens'],
  tokenizer(src, tokens) {
    const previous = tokens.at(-1)?.raw ?? '';
    if (!/^\*\*(?![\s*])/.test(src) || previous.endsWith('*') || this.lexer.state.inRawBlock) return;
    const line = src.split('\n', 1)[0];
    const opensAfterHan = endsWithHan.test(previous) && fullWidthPunctuation.test(line[2]);
    // Only look for an unescaped closing pair on this line, outside literal spans.
    const delimiters = /\*{2,}|`+|\$|\\/g;
    delimiters.lastIndex = 2;
    for (let match; (match = delimiters.exec(line));) {
      const index = match.index;
      const rest = line.slice(index);
      if (rest.startsWith('*')) {
        const text = line.slice(2, index);
        const closesBeforeHan = fullWidthPunctuation.test(text.at(-1)) && startsWithHan.test(rest.slice(2));
        if (match[0] !== '**' || !text || /\s$/.test(text) || !(opensAfterHan || closesBeforeHan)) return;
        return { type:'cjkStrong', raw:line.slice(0, index + 2), tokens:this.lexer.inlineTokens(text) };
      }
      const literal = rest.startsWith('`') ? this.lexer.tokenizer.codespan(rest) : mathToken(rest, false);
      if (literal) delimiters.lastIndex = index + literal.raw.length;
      else if (rest.startsWith('\\')) delimiters.lastIndex = index + 2;
    }
  },
  renderer({ tokens }) {
    return this.parser.renderer.strong({ tokens });
  },
};

function code({ text, lang }) {
  const name = lang?.trim().split(/\s+/, 1)[0].toLowerCase();
  const safeName = name && /^[a-z0-9_+#.-]{1,24}$/.test(name) ? name : '';
  const language = safeName ? ` class="language-${safeName}"` : '';
  const highlighted = safeName && hljs.getLanguage(safeName) ? hljs.highlight(text, {
    language:safeName, ignoreIllegals:true,
  }).value : escapeHtml(text);
  return `<pre><code${language}>${highlighted}</code></pre>\n`;
}

function formulaNode(token) {
  try {
    const text = temml.renderToString(token.formula, {
      displayMode:token.display, throwOnError:true, trust:false, maxExpand:500, maxSize:[8, 8], macros:{},
    });
    const wrapper = el('span', null, token.display ? 'math-scroll' : 'math-inline');
    wrapper.append(DOMPurify.sanitize(text, mathPolicy));
    return wrapper;
  } catch {
    return document.createTextNode(token.raw.trim());
  }
}

function decorate(fragment, formulas) {
  for (const node of fragment.querySelectorAll('[class]')) {
    const classes = [...node.classList].filter(name => /^(?:hljs-[\w-]+|language-[a-z0-9_+#.-]+|task-list-item)$/.test(name));
    if (classes.length) node.className = classes.join(' ');
    else node.removeAttribute('class');
  }
  for (const node of fragment.querySelectorAll('[data-board-math]')) {
    const index = node.getAttribute('data-board-math');
    if (/^\d+$/.test(index) && formulas[index]) node.replaceWith(formulaNode(formulas[index]));
    else node.removeAttribute('data-board-math');
  }
  for (const link of fragment.querySelectorAll('a[href]')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.referrerPolicy = 'no-referrer';
  }
  for (const input of fragment.querySelectorAll('input')) {
    if (input.type === 'checkbox') input.disabled = true;
    else input.remove();
  }
  for (const table of fragment.querySelectorAll('table')) {
    const scroll = el('div', null, 'table-scroll');
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', '表格');
    table.before(scroll);
    scroll.append(table);
  }
  for (const pre of fragment.querySelectorAll('pre')) {
    const name = [...(pre.firstElementChild?.classList || [])].find(cls => cls.startsWith('language-'))?.slice(9);
    const wrapper = el('div', null, 'code-box');
    const head = el('div', null, 'code-head');
    head.append(el('span', name || '纯文本', 'mono'), copyButton(pre.textContent, '代码'));
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', name ? `${name} 代码` : '代码');
    pre.before(wrapper);
    wrapper.append(head, pre);
  }
}

export function prose(value) {
  const formulas = [];
  const parser = new Marked({
    gfm:true,
    renderer:{ code, image:({ text }) => escapeHtml(text) },
    extensions:[mathExtension(true, formulas), mathExtension(false, formulas), cjkStrong],
  });
  const content = el('div', null, 'prose');
  try {
    const fragment = DOMPurify.sanitize(parser.parse(value), markdownPolicy);
    decorate(fragment, formulas);
    content.append(fragment);
  } catch {
    content.append(el('p', value, 'step-text'));
  }
  return content;
}
