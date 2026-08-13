// 极简 Markdown 渲染器，只覆盖模型实际会吐的那些语法。
//
// 硬性约束：**全程 createElement + textContent，绝不碰 innerHTML**。
// 侧边栏是有 chrome.* 权限的扩展页，而模型的输出里可能夹带它从页面上读到的
// 内容 —— 把那些东西当 HTML 插进来等于把注入通道直接开给恶意网页。
// 所以这里不做"先生成 HTML 再消毒"，而是根本不生成 HTML。

/** 只放行 http/https。javascript: data: 这些一律不给。 */
function safeHref(url) {
  try {
    const u = new URL(url, 'https://invalid.local');
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

// 行内语法。顺序即优先级：代码优先，它内部不再解析别的。
//
// 只存正则**源码**而不是共享一个 RegExp 实例：inline() 是递归的
// （**粗体**里还要继续解析），共用一个带 /g 的正则会让内层调用把
// lastIndex 重置掉，外层回来后从头再匹配同一段 —— 死循环，直接爆内存。
const INLINE_SRC =
  [
    '(`+)([\\s\\S]*?)\\1',                      // `code`
    '\\*\\*([\\s\\S]+?)\\*\\*',                 // **bold**
    '__([\\s\\S]+?)__',                         // __bold__
    '~~([\\s\\S]+?)~~',                         // ~~strike~~
    '(?<![*\\w])\\*([^*\\n]+?)\\*(?!\\*)',      // *italic*
    '\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+"[^"]*")?\\)', // [text](url)
  ].join('|');

/** 把一段行内文本解析成节点，追加到 parent。 */
function inline(text, parent) {
  let last = 0;
  const re = new RegExp(INLINE_SRC, 'g');   // 每次调用一个独立实例，递归安全
  let m;
  while ((m = re.exec(text))) {
    // 零宽匹配会让 lastIndex 不前进，保险起见推一格
    if (m[0] === '') { re.lastIndex++; continue; }
    if (m.index > last) parent.append(text.slice(last, m.index));
    const [, , codeBody, bold1, bold2, strike, italic, linkText, linkUrl] = m;

    if (codeBody !== undefined) {
      const el = document.createElement('code');
      el.textContent = codeBody.trim();
      parent.append(el);
    } else if (bold1 !== undefined || bold2 !== undefined) {
      const el = document.createElement('strong');
      inline(bold1 ?? bold2, el);
      parent.append(el);
    } else if (strike !== undefined) {
      const el = document.createElement('s');
      inline(strike, el);
      parent.append(el);
    } else if (italic !== undefined) {
      const el = document.createElement('em');
      inline(italic, el);
      parent.append(el);
    } else if (linkUrl !== undefined) {
      const href = safeHref(linkUrl);
      if (href) {
        const a = document.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = linkText || href;
        parent.append(a);
      } else {
        // 协议不安全就退化成纯文本，别默默丢掉内容
        parent.append(`${linkText}(${linkUrl})`);
      }
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

/** Markdown → DocumentFragment。 */
export function renderMarkdown(src) {
  const frag = document.createDocumentFragment();
  const lines = String(src ?? '').split('\n');
  let i = 0;

  const para = [];
  const flushPara = () => {
    if (!para.length) return;
    const p = document.createElement('p');
    inline(para.join('\n'), p);
    frag.append(p);
    para.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块。流式过程中结尾的 ``` 还没到，就把剩下的全当代码 ——
    // 和主流渲染器一致，也避免半截语法闪烁。
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // 跳过收尾的 ```
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (fence[1]) code.dataset.lang = fence[1];
      code.textContent = body.join('\n');
      pre.append(code);
      frag.append(pre);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      const h = document.createElement(`h${Math.min(heading[1].length + 2, 6)}`);
      inline(heading[2], h);
      frag.append(h);
      i++;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
      flushPara();
      frag.append(document.createElement('hr'));
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      const q = document.createElement('blockquote');
      inline(body.join('\n'), q);
      frag.append(q);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered;
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length) {
        const m = ordered
          ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i])
          : /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        const li = document.createElement('li');
        inline(m[1], li);
        list.append(li);
        i++;
      }
      frag.append(list);
      continue;
    }

    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return frag;
}
