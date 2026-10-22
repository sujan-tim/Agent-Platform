// A small Markdown renderer for the agent's answers.
//
// It builds DOM nodes directly and never uses innerHTML, so text from the AI,
// a document or a web page can only ever become text, never markup or script.
// Links are kept only when they are http(s) or mailto. Covers what chat
// answers use: headings, paragraphs, bold, italic, strikethrough, inline code,
// code blocks, bullet and numbered lists (nested), quotes, tables, rules,
// links, bare URLs, and [n] citations, which become links to the answer's
// sources.

/**
 * @param {string} text Markdown.
 * @param {{ sources?: Array<{ n: number, title: string, url: string }> }} [options]
 * @returns {HTMLElement} A <div class="markdown">.
 */
export function renderMarkdown(text, options = {}) {
  const root = el('div', 'markdown');
  const ctx = { sources: new Map((options.sources ?? []).map((s) => [s.n, s])) };
  renderBlocks(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'), root, ctx);
  return root;
}

/** Plain text for speaking aloud: no Markdown marks, links or citation numbers. */
export function markdownToSpeech(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[(\d+)\]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
    .replace(/[|#>*_`~]/g, ' ')
    .replace(/<br\s*\/?>/gi, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

// ── Blocks ────────────────────────────────────────────────────────────────

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function renderBlocks(lines, parent, ctx) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++; // the closing fence
      parent.append(codeBlock(body.join('\n'), fence[2]));
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      // Answers sit inside a page that has its own headings, so they start at h3.
      const h = el(`h${Math.min(6, heading[1].length + 2)}`);
      renderInline(heading[2], h, ctx);
      parent.append(h);
      i++;
      continue;
    }

    if (RULE.test(line)) {
      parent.append(el('hr'));
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])[1]);
      const quote = el('blockquote');
      renderBlocks(body, quote, ctx);
      parent.append(quote);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const rows = [line];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(lines[i++]);
      parent.append(table(rows, ctx));
      continue;
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      i = list(lines, i, parent, ctx);
      continue;
    }

    // A paragraph: consecutive lines until a blank line or another kind of block.
    const body = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) body.push(lines[i++].trim());
    const p = el('p');
    body.forEach((part, k) => {
      if (k > 0) p.append(el('br'));
      renderInline(part, p, ctx);
    });
    parent.append(p);
  }
}

function startsBlock(lines, i) {
  const line = lines[i];
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]))
  );
}

/** A list starting at line `start`, with deeper-indented items nested. Returns the next line index. */
function list(lines, start, parent, ctx) {
  const first = BULLET.exec(lines[start]) ?? NUMBERED.exec(lines[start]);
  const indent = first[1].length;
  const ordered = !BULLET.test(lines[start]);
  const node = el(ordered ? 'ol' : 'ul');
  if (ordered && Number(first[2]) !== 1) node.start = Number(first[2]);
  let i = start;
  let item = null;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line ends the list unless the next line carries on with it.
      const next = lines[i + 1] ?? '';
      const nextMatch = BULLET.exec(next) ?? NUMBERED.exec(next);
      if (nextMatch && nextMatch[1].length >= indent) {
        i++;
        continue;
      }
      break;
    }
    const match = BULLET.exec(line) ?? NUMBERED.exec(line);
    if (match && match[1].length > indent && item) {
      i = list(lines, i, item, ctx);
      continue;
    }
    if (match && match[1].length === indent && BULLET.test(line) === !ordered) {
      item = el('li');
      renderInline(match[3], item, ctx);
      node.append(item);
      i++;
      continue;
    }
    if (!match && item && /^\s+\S/.test(line)) {
      // A wrapped continuation of the current item.
      item.append(' ');
      renderInline(line.trim(), item, ctx);
      i++;
      continue;
    }
    break;
  }
  parent.append(node);
  return i;
}

/** rows[0] is the header row; the divider line is already skipped. */
function table(rows, ctx) {
  const split = (row) => {
    let cells = row.trim();
    if (cells.startsWith('|')) cells = cells.slice(1);
    if (cells.endsWith('|')) cells = cells.slice(0, -1);
    return cells.split('|').map((c) => c.trim());
  };
  const wrap = el('div', 'table-wrap');
  const t = el('table');
  const head = el('thead');
  const headRow = el('tr');
  for (const cell of split(rows[0])) {
    const th = el('th');
    renderInline(cell, th, ctx);
    headRow.append(th);
  }
  head.append(headRow);
  const body = el('tbody');
  for (const row of rows.slice(1)) {
    const tr = el('tr');
    for (const cell of split(row)) {
      const td = el('td');
      renderInline(cell, td, ctx);
      tr.append(td);
    }
    body.append(tr);
  }
  t.append(head, body);
  wrap.append(t);
  return wrap;
}

function codeBlock(code, language) {
  const wrap = el('div', 'code-block');
  const bar = el('div', 'code-bar');
  const label = el('span');
  label.textContent = language || 'code';
  const copy = el('button', 'link copy-code');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => copyText(code, copy));
  bar.append(label, copy);
  const pre = el('pre');
  const c = el('code');
  c.textContent = code;
  pre.append(c);
  wrap.append(bar, pre);
  return wrap;
}

export async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const before = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = before), 1500);
  } catch {
    button.textContent = 'Copy failed';
  }
}

// ── Inline ────────────────────────────────────────────────────────────────

// Tried in order at each position; the earliest match in the text wins.
const INLINE = [
  { type: 'code', re: /`([^`\n]+)`/ },
  { type: 'link', re: /\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/ },
  { type: 'cite', re: /\[(\d{1,3})\](?!\()/ },
  { type: 'bold', re: /\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__/ },
  { type: 'strike', re: /~~(?=\S)([\s\S]*?\S)~~/ },
  { type: 'italic', re: /\*(?=[^\s*])([^*\n]*?[^\s*])\*|(?<![\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w])/ },
  { type: 'br', re: /<br\s*\/?>/i },
  { type: 'url', re: /\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/ },
];

function renderInline(text, parent, ctx) {
  let rest = text;
  while (rest) {
    let best = null;
    for (const rule of INLINE) {
      const m = rule.re.exec(rest);
      if (m && (best === null || m.index < best.m.index)) best = { rule, m };
    }
    if (!best) {
      parent.append(rest);
      return;
    }
    if (best.m.index > 0) parent.append(rest.slice(0, best.m.index));
    appendInline(best.rule.type, best.m, parent, ctx);
    rest = rest.slice(best.m.index + best.m[0].length);
  }
}

function appendInline(type, m, parent, ctx) {
  switch (type) {
    case 'code': {
      const c = el('code');
      c.textContent = m[1];
      parent.append(c);
      return;
    }
    case 'link': {
      const a = safeLink(m[2]);
      if (!a) {
        renderInline(m[1], parent, ctx);
        return;
      }
      renderInline(m[1], a, ctx);
      parent.append(a);
      return;
    }
    case 'url': {
      const a = safeLink(m[0]);
      a.textContent = m[0];
      parent.append(a);
      return;
    }
    case 'cite': {
      const source = ctx.sources.get(Number(m[1]));
      if (!source) {
        parent.append(m[0]);
        return;
      }
      const a = safeLink(source.url);
      if (!a) return;
      a.className = 'cite';
      a.textContent = m[1];
      a.title = `${source.title} — ${hostOf(source.url)}`;
      parent.append(a);
      return;
    }
    case 'bold':
    case 'strike':
    case 'italic': {
      const node = el({ bold: 'strong', strike: 's', italic: 'em' }[type]);
      renderInline(m[1] ?? m[2], node, ctx);
      parent.append(node);
      return;
    }
    case 'br':
      parent.append(el('br'));
  }
}

function safeLink(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null;
  const a = el('a');
  a.href = url.href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
