// 注入到页面里运行。通过 chrome.scripting.executeScript 以 classic script 加载，
// 所以这里不能用 import/export。
//
// 职责：
//   1. buildSnapshot()  —— 把 DOM 变成带 [ref=N] 编号的、模型能读懂的文本
//   2. click / type_text / scroll —— 按 ref 操作页面
//
// ref 编号只在一次 read_page 之内有效：每次 read_page 都会清空重编。
// 这是刻意的 —— 页面一变旧编号就没意义，与其让模型点错，不如明确报错让它重读。

(() => {
  // 幂等守卫：重复注入不会重复注册监听器
  if (window.__pageAgentInstalled) return;
  window.__pageAgentInstalled = true;

  const MAX_SNAPSHOT = 24000; // 快照字符上限，防止炸上下文
  const MAX_TEXT = 30000;     // mode:"text" 的正文上限
  const MAX_NAME = 160;       // 单个元素名称的截断长度

  const refs = new Map();
  let nextRef = 1;

  // ── 消息入口 ────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        sendResponse({ ok: true, data: await handle(msg) });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true; // 保持通道打开以便异步响应
  });

  async function handle(msg) {
    switch (msg.type) {
      case 'ping':      return 'pong';
      case 'peek':      return peek(msg.ref);
      case 'get_selection': return clean(String(getSelection() || ''), 2000);
      case 'page_profile':  return pageProfile();
      case 'read_page': return msg.mode === 'text' ? readText() : buildSnapshot();
      case 'click':     return click(msg.ref);
      case 'type_text': return typeText(msg.ref, msg.text, msg.submit);
      case 'scroll':    return scroll(msg.direction, msg.amount);
      default:          throw new Error(`未知工具：${msg.type}`);
    }
  }

  // ── 页面快照 ────────────────────────────────────────────────────

  const INTERACTIVE_SEL = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
    '[contenteditable=""]', '[contenteditable="true"]',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="switch"]',
    '[role="combobox"]', '[role="textbox"]', '[role="searchbox"]', '[role="option"]',
    '[role="slider"]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE',
    'BR', 'HR', 'SVG', 'PATH', 'CANVAS', 'OBJECT', 'EMBED', 'AUDIO', 'VIDEO',
  ]);

  function buildSnapshot() {
    refs.clear();
    nextRef = 1;

    const out = { lines: [], len: 0, truncated: false };
    walk(document.body, 0, out);

    const head = [
      `# ${clean(document.title, 120) || '(无标题)'}`,
      `url: ${location.href}`,
      scrollInfo(),
      '',
    ];
    const tail = out.truncated
      ? '\n\n[快照已截断。用 scroll 换个位置再 read_page，或用 read_page(mode:"text") 读纯正文。]'
      : '';

    return head.join('\n') + out.lines.join('\n') + tail;
  }

  // refsOnly：祖先已经把整段文字输出过了，这层往下只再捞可交互元素的编号，
  // 不要重复吐文本。
  function walk(root, depth, out, refsOnly) {
    for (const child of root.children) {
      if (out.len > MAX_SNAPSHOT) {
        out.truncated = true;
        return;
      }
      if (SKIP_TAGS.has(child.tagName)) continue;
      if (isHidden(child)) continue;

      const d = describe(child, refsOnly);
      if (d) {
        const line = '  '.repeat(Math.min(depth, 10)) + d.line;
        out.lines.push(line);
        out.len += line.length + 1;
        if (d.recurse) walk(child, depth + 1, out, d.refsOnly || refsOnly);
      } else {
        // 没有信息量的容器：不输出行，也不增加缩进层级
        walk(child, depth, out, refsOnly);
      }

      // Web Component 内部（open 模式的 shadow DOM）
      if (child.shadowRoot) walk(child.shadowRoot, depth + 1, out, refsOnly);
    }
  }

  // 判断一个元素是不是"纯文本块"：内部只有行内内容，没有块级后代。
  // 只有这种元素才适合整段输出 innerText。
  const BLOCK_SEL =
    'div,section,article,p,ul,ol,li,table,tr,td,th,h1,h2,h3,h4,h5,h6,' +
    'header,footer,nav,aside,form,main,figure,figcaption,blockquote,pre,dl,dt,dd';

  /** 决定一个元素是否值得输出一行，以及是否还要往下钻。 */
  function describe(el, refsOnly) {
    const tag = el.tagName;

    if (tag === 'IFRAME') {
      return refsOnly ? null : { line: '[iframe：本版本不读取内嵌框架的内容]', recurse: false };
    }

    const interactive = el.matches(INTERACTIVE_SEL) && hasBox(el);
    if (interactive) {
      const ref = nextRef++;
      refs.set(ref, el);

      let line = `[ref=${ref}] ${roleOf(el)} "${accName(el)}"`;

      if (tag === 'A') {
        const href = el.getAttribute('href');
        if (href) line += ` → ${shortHref(href)}`;
      }
      const isToggle = tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio');
      if ((tag === 'INPUT' && !isToggle) || tag === 'TEXTAREA') {
        line += ` value="${clean(el.value, 80)}"`;
      }
      if (tag === 'SELECT') {
        // 显示当前选中项，否则模型看不出下拉框的状态
        const sel = el.selectedOptions && el.selectedOptions[0];
        if (sel) line += ` value="${clean(sel.text, 60)}"`;
      }
      // checkbox/radio 的 value 恒为 "on" 之类的无用值，只报选中状态
      if (isToggle) line += el.checked ? ' [已选中]' : ' [未选中]';
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' [不可用]';
      const expanded = el.getAttribute('aria-expanded');
      if (expanded) line += ` [展开=${expanded}]`;

      // 按钮里的文字已经进名称了，不必再钻进去；
      // 但如果内部还嵌着别的可交互元素，就得继续。
      return { line, recurse: !!el.querySelector(INTERACTIVE_SEL) };
    }

    // 文本已由祖先整段输出过，这层只负责给可交互元素编号
    if (refsOnly) return null;

    if (/^H[1-6]$/.test(tag)) {
      const t = clean(el.innerText, 200);
      return t ? { line: `heading${tag[1]} "${t}"`, recurse: false } : null;
    }

    // 直接文本子节点（不含后代），避免父容器重复吐出整页文字
    const own = ownText(el);
    if (own) {
      // <label> 的文字已经作为它所标注控件的名称输出过了，重复一遍纯属浪费 token。
      // 用 el.control 判断而不是"是否已编号"，因为 label 可能出现在控件之前。
      if (tag === 'LABEL' && el.control) return null;

      // 句子里夹着 <code>/<em>/<a> 这类行内元素时，只取直接文本子节点会把句子撕碎：
      //   <p>The <code>fetch()</code> method of the <a>Window</a> interface…</p>
      // 会变成 text "The  method of the  interface…" 外加两条孤立的子行，语义全丢。
      // 所以对"没有块级后代"的纯文本块，整段输出 innerText，再只把可交互后代
      // 作为缩进的 ref 列出来（链接文字会重复一次，但换来句子完整，值得）。
      if (!el.querySelector(BLOCK_SEL)) {
        const full = clean(el.innerText || '', 600);
        if (full.length > own.length + 2) {
          return {
            line: `text "${full}"`,
            recurse: !!el.querySelector(INTERACTIVE_SEL),
            refsOnly: true,
          };
        }
      }
      return { line: `text "${own}"`, recurse: true };
    }

    return null;
  }

  function readText() {
    const el =
      document.querySelector('main, article, [role="main"]') || document.body;
    let t = (el.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    let note = '';
    if (t.length > MAX_TEXT) {
      t = t.slice(0, MAX_TEXT);
      note = '\n\n[正文已截断]';
    }
    return `# ${clean(document.title, 120)}\nurl: ${location.href}\n\n${t}${note}`;
  }

  // ── 页面操作 ────────────────────────────────────────────────────

  function getRef(ref) {
    const el = refs.get(Number(ref));
    if (!el) {
      throw new Error(
        `ref=${ref} 不存在。ref 编号只在最近一次 read_page 之后有效，` +
          `请重新调用 read_page 获取当前页面的编号。`
      );
    }
    if (!el.isConnected) {
      throw new Error(`ref=${ref} 指向的元素已经从页面上消失，请重新调用 read_page。`);
    }
    return el;
  }

  /**
   * 页面画像：只数数量，不取内容。侧边栏用它决定该给哪些建议 ——
   * 没有表单就不该出现「帮我填表」。
   */
  function pageProfile() {
    const vis = (el) => !isHidden(el) && hasBox(el);

    const fields = [...document.querySelectorAll('input:not([type="hidden"]),textarea,select')].filter(vis);
    const searchBoxes = fields.filter((el) => {
      if (el.type === 'search') return true;
      const hint = `${el.name} ${el.id} ${el.placeholder || ''} ${attr(el, 'aria-label') || ''}`;
      return /search|query|keyword|\bq\b|搜索|查找/i.test(hint);
    });

    const links = [...document.querySelectorAll('a[href]')].filter(vis);
    let external = 0;
    for (const a of links) {
      try {
        if (new URL(a.getAttribute('href'), location.href).origin !== location.origin) external++;
      } catch { /* 伪协议或畸形 href，当站内 */ }
    }

    const main = document.querySelector('main, article, [role="main"]') || document.body;

    return {
      fields: fields.length,
      searchBoxes: searchBoxes.length,
      forms: document.querySelectorAll('form').length,
      buttons: [...document.querySelectorAll('button,[role="button"]')].filter(vis).length,
      links: links.length,
      externalLinks: external,
      textLen: (main.innerText || '').length,
      scrollable: document.documentElement.scrollHeight - innerHeight > 240,
      hasSelection: String(getSelection() || '').trim().length > 0,
    };
  }

  /** 只看不碰：告诉 Service Worker 这个 ref 指的是什么，用于风险判定。 */
  function peek(ref) {
    const el = getRef(ref);
    let external = '';
    if (el.tagName === 'A' && el.getAttribute('href')) {
      try {
        const u = new URL(el.getAttribute('href'), location.href);
        if (u.origin !== location.origin) external = u.host;
      } catch { /* 相对路径或伪协议，当作站内 */ }
    }
    return {
      tag: el.tagName,
      role: roleOf(el),
      name: accName(el),
      value: el.value != null ? clean(el.value, 60) : '',
      inForm: !!el.form,
      external,
    };
  }

  function click(ref) {
    const el = getRef(ref);
    const desc = `${roleOf(el)} "${accName(el)}"`;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    try { el.focus({ preventScroll: true }); } catch { /* 有些元素不可聚焦 */ }
    el.click();
    return `已点击 [ref=${ref}] ${desc}。\n（页面内容可能已变化，继续操作前请重新 read_page）`;
  }

  function typeText(ref, text, submit) {
    const el = getRef(ref);
    const str = String(text ?? '');
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus({ preventScroll: true });

    if (el.isContentEditable) {
      el.textContent = '';
      // execCommand 能让富文本编辑器（Quill / ProseMirror 等）正确收到输入
      const ok = document.execCommand && document.execCommand('insertText', false, str);
      if (!ok || el.textContent !== str) el.textContent = str;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: str }));
    } else if (el.tagName === 'SELECT') {
      const opt = [...el.options].find(
        (o) => o.text.trim() === str || o.value === str
      );
      if (!opt) throw new Error(`下拉框里没有 "${str}" 这个选项。可选：${[...el.options].map((o) => o.text.trim()).slice(0, 20).join(' / ')}`);
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return `已在 [ref=${ref}] 选中 "${opt.text.trim()}"。`;
    } else {
      // 直接赋 el.value 在 React/Vue 受控组件里只改了 DOM，框架状态不变，
      // 提交时会拿到空值。必须走原型链上的原生 setter 再派发事件。
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, str);
      else el.value = str;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (submit) {
      const form = el.form;
      if (form && typeof form.requestSubmit === 'function') {
        // 真实表单：requestSubmit 会正常触发 submit 事件（含框架的拦截逻辑）
        form.requestSubmit();
      } else {
        // SPA 搜索框：多半监听的是 keydown
        for (const type of ['keydown', 'keypress', 'keyup']) {
          el.dispatchEvent(
            new KeyboardEvent(type, {
              key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
              bubbles: true, cancelable: true,
            })
          );
        }
      }
    }

    return `已在 [ref=${ref}] 输入 "${clean(str, 80)}"${submit ? '，并提交' : ''}。`;
  }

  function scroll(direction, amount) {
    const step = Number(amount) > 0 ? Number(amount) : Math.round(innerHeight * 0.85);
    const doc = document.documentElement;
    if (direction === 'top') scrollTo({ top: 0, behavior: 'instant' });
    else if (direction === 'bottom') scrollTo({ top: doc.scrollHeight, behavior: 'instant' });
    else scrollBy({ top: direction === 'up' ? -step : step, behavior: 'instant' });

    // 给懒加载留点时间
    return new Promise((r) =>
      setTimeout(
        () => r(`已滚动。${scrollInfo()}\n（新内容可能刚加载出来，需要 read_page 才能看到）`),
        350
      )
    );
  }

  // ── 小工具 ──────────────────────────────────────────────────────

  function isHidden(el) {
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
        // display:contents 的元素自身不生成布局盒子，按规范 checkVisibility() 一律
        // 返回 false —— 但它的子元素照常显示。现代 Grid 布局大量使用这个属性
        // （MDN 的 <main> 就是），当成隐藏会把整棵正文子树剪掉。
        if (getComputedStyle(el).display !== 'contents') return true;
      }
    } else {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return true;
    }
    return isClippedAway(el);
  }

  // 被祖先的 overflow:hidden + 零尺寸完全裁掉。
  // 这是 .sr-only、折叠面板（height:0;overflow:hidden）的常见写法：
  // 元素自身 rect 非零、checkVisibility 也返回 true，只看自己发现不了。
  // 先做零成本的尺寸判断，命中了才去查 computed style。
  function isClippedAway(el) {
    for (let p = el.parentElement, hops = 0; p && hops < 6; p = p.parentElement, hops++) {
      if (p.clientWidth !== 0 && p.clientHeight !== 0) continue;
      const s = getComputedStyle(p);
      // display:contents 没有盒子，也就无从裁剪；它的 clientW/H 恒为 0，
      // 不排除的话会误判整棵子树。
      if (s.display === 'contents') continue;
      // overflow:visible 的塌陷容器（如浮动导致的 height:0）不算隐藏，
      // 它的子元素依然正常显示。
      if (s.overflow !== 'visible' || s.overflowX !== 'visible' || s.overflowY !== 'visible') {
        return true;
      }
    }
    return false;
  }

  function hasBox(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  function attr(el, name) {
    return el.getAttribute ? el.getAttribute(name) : null;
  }

  function clean(s, n = MAX_NAME) {
    return String(s ?? '')
      .replace(/\s+/g, ' ')
      .replace(/"/g, "'")
      .trim()
      .slice(0, n);
  }

  function ownText(el) {
    let s = '';
    for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) s += n.nodeValue;
    return clean(s, 300);
  }

  function accName(el) {
    const aria = attr(el, 'aria-label');
    if (aria) return clean(aria);

    const by = attr(el, 'aria-labelledby');
    if (by) {
      const t = by
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => n.innerText || n.textContent || '')
        .join(' ');
      if (t.trim()) return clean(t);
    }

    const tag = el.tagName;
    if (tag === 'IMG') return clean(el.alt);
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const lbl = el.labels && el.labels[0];
      return clean(
        (lbl && (lbl.innerText || lbl.textContent)) ||
          el.placeholder ||
          attr(el, 'aria-placeholder') ||
          attr(el, 'title') ||
          attr(el, 'name') ||
          ''
      );
    }

    const own = ownText(el);
    if (own) return clean(own);

    const inner = clean(el.innerText || '');
    if (inner) return inner;

    // 元素自身的 title（无障碍命名规范里的标准兜底，纯图标按钮常用）
    const ownTitle = attr(el, 'title');
    if (ownTitle) return clean(ownTitle);

    // 再退一步：找里面 img 的 alt / 后代的 title
    const img = el.querySelector('img[alt], [title]');
    if (img) return clean(img.getAttribute('alt') || img.getAttribute('title'));

    return '';
  }

  function roleOf(el) {
    const r = attr(el, 'role');
    if (r) return r;
    const tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (['submit', 'button', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'clickable';
  }

  function shortHref(href) {
    try {
      const u = new URL(href, location.href);
      if (u.origin === location.origin) return (u.pathname + u.search).slice(0, 120);
      return (u.origin + u.pathname).slice(0, 120);
    } catch {
      return String(href).slice(0, 120);
    }
  }

  function scrollInfo() {
    const y = Math.round(scrollY);
    const max = Math.round(
      Math.max(0, document.documentElement.scrollHeight - innerHeight)
    );
    if (max <= 0) return '滚动位置：整页一屏可见，无需滚动';
    return `滚动位置：${y} / ${max} px（${Math.round((y / max) * 100)}%）`;
  }
})();
