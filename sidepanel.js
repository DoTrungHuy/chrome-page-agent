// 侧边栏 UI：通过一条长连接 port 与 Service Worker 通信。
//
// 注意：模型和页面的输出一律用 textContent 写入，绝不碰 innerHTML —— 否则
// 一个恶意页面就能把脚本注进扩展的特权上下文里。

import { renderMarkdown } from './lib/markdown.js';
import { api } from './lib/api.js';

const log = document.getElementById('log');
const input = document.getElementById('input');
const form = document.getElementById('composer');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');
const stepEl = document.getElementById('step');
const usageEl = document.getElementById('usage');
const ctxEl = document.getElementById('context');
const ctxTitle = document.getElementById('ctxTitle');
const ctxUrl = document.getElementById('ctxUrl');
const modelBtn = document.getElementById('modelBtn');
const modelMenu = document.getElementById('modelMenu');
const modelName = document.getElementById('modelName');
const modelDot = document.getElementById('modelDot');
const modeSel = document.getElementById('modeSel');
const drawer = document.getElementById('drawer');
const convList = document.getElementById('convList');
const suggests = document.getElementById('suggests');
const cardsEl = document.getElementById('cards');
const suggestHint = document.getElementById('suggestHint');
const mentionBtn = document.getElementById('mention');

const MODES = ['plan', 'auto', 'always'];

let port = null;
let bubble = null;       // 当前正在流式填充的 assistant 气泡
let thinkBody = null;    // 当前的推理折叠块
let pendingTool = null;
let busy = false;

// ── port ───────────────────────────────────────────────────────

function connect() {
  if (port) return port;
  port = api.runtime.connect({ name: 'agent' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    // Service Worker 被回收会走到这里；下次发消息时自动重连
    port = null;
    setBusy(false);
  });
  return port;
}
connect();

function send(msg) {
  // port 断了（Service Worker 被回收）而 onDisconnect 还没触发时，
  // postMessage 会同步抛异常。不接住的话调用方会静默失败 ——
  // 比如点历史按钮时抽屉开了但请求没发出去，看起来就像"历史是空的"。
  try {
    connect().postMessage(msg);
    return true;
  } catch {
    port = null;
    try {
      connect().postMessage(msg);
      return true;
    } catch (e) {
      addBlock('msg error', `和后台断开了，请关掉侧边栏重新打开。（${String(e?.message || e)}）`);
      return false;
    }
  }
}

// ── 收消息 ─────────────────────────────────────────────────────

// 前端需要后台支持的能力。后台没报出来（或压根没回 hello），
// 说明 Service Worker 还是旧代码 —— 这时候干等只会看到"一直加载中"。
const NEEDED_FEATURES = ['conversations', 'profile', 'selection', 'modes'];
let backendOk = false;

function staleBackendMsg() {
  return '后台代码还是旧版本。请打开浏览器的扩展管理页，找到 Page Agent，' +
         '点卡片上的刷新按钮 ⟳，然后关掉侧边栏重新打开。';
}

function onMessage(msg) {
  if (msg.type === 'hello') {
    const missing = NEEDED_FEATURES.filter((f) => !(msg.features || []).includes(f));
    backendOk = missing.length === 0;
    if (!backendOk) addBlock('msg error', staleBackendMsg());
    return;
  }
  switch (msg.type) {
    case 'context':
      ctxEl.hidden = false;
      if (msg.pageAvailable === false) {
        // 新标签页 / 浏览器内部页面：说清楚这轮不读页面，但对话照常
        ctxTitle.textContent = '无可读页面';
        ctxUrl.textContent = '直接对话，不会读取页面';
      } else {
        ctxTitle.textContent = msg.title || '';
        ctxUrl.textContent = prettyUrl(msg.url);
      }
      break;

    case 'step':
      stepEl.hidden = false;
      stepEl.textContent = `第 ${msg.step}/${msg.max} 步`;
      break;

    case 'usage':
      renderUsage(msg);
      break;

    case 'rewind':
      // 重新生成：把界面退回到发问之前，再让新内容流进来
      pendingRenders.clear();
      bubble = null;
      thinkBody = null;
      log.replaceChildren();
      renderView(msg.view || []);
      break;

    case 'prefill':
      // 右键菜单送来的。以「…」结尾的（"就这段提问"）需要你补问题，不自动发送
      input.value = msg.text;
      autoGrow();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      if (!msg.text.trimEnd().endsWith('：') && !busy) form.requestSubmit();
      break;

    case 'restored':
      // Service Worker 被回收过，历史是从 storage.session 捞回来的。
      // 静默恢复会让人以为上下文没断，所以明说，同时把内容也画回来。
      if (msg.view?.length && !log.children.length) renderView(msg.view);
      addBlock('msg info', `已恢复上次对话（${msg.turns} 轮）。`);
      if (msg.mode) setMode(msg.mode, false);
      break;

    case 'conversations':
      renderConversations(msg.list, msg.current);
      break;

    case 'conversation_loaded':
      log.replaceChildren();
      renderView(msg.view || []);
      drawer.hidden = true;
      updateSuggests();
      scrollToBottom();
      break;

    case 'profile':
      pageProfile = msg.profile;
      renderCards();
      break;

    case 'selection':
      if (msg.text) {
        insertAtCursor(msg.text);
        mentionBtn.classList.add('on');
        setTimeout(() => mentionBtn.classList.remove('on'), 700);
      } else {
        addBlock('msg info', msg.error || '页面上没有选中任何文字。');
      }
      break;

    case 'thinking': appendThinking(msg.text); break;
    case 'delta':    appendDelta(msg.text); break;

    case 'tool':
      closeBubble();
      addTool(msg.name, msg.input);
      break;

    case 'tool_done': finishTool(msg.ok, msg.preview); break;

    case 'confirm':
      closeBubble();
      addConfirm(msg);
      break;

    case 'error':
      closeBubble();
      addBlock('msg error', msg.message);
      break;

    case 'info':
      closeBubble();
      addBlock('msg info', msg.message);
      break;

    case 'reset_done':
      // 丢掉还没画完的内容，别让它渲染进已经清空的日志里
      pendingRenders.clear();
      bubble = null;
      thinkBody = null;
      log.replaceChildren();
      ctxEl.hidden = true;
      usageEl.hidden = true;   // 新对话，用量从头算
      updateSuggests();
      requestProfile();   // 页面可能已经变了，重新取一次画像
      break;

    case 'done':
      closeBubble();
      showActions();
      stepEl.hidden = true;
      setBusy(false);
      break;
  }
  scrollToBottom();
}

// ── 渲染 ───────────────────────────────────────────────────────

function addBlock(cls, text) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  log.append(el);
  updateSuggests();
  return el;
}

// 模型吐的是 Markdown。以前直接塞 textContent，结果 ## ** ` > 全成了字面量，
// 看着就是一堆没意义的符号。现在解析成 DOM 节点渲染 —— 但绝不走 innerHTML。
let bubbleRaw = '';
// 必须按元素排队，不能只留一个槽位：消息来得快时（工具调用前后两段回复
// 可能在同一帧内到齐），单槽位会被后来的覆盖，前一个气泡就永远空着。
const pendingRenders = new Map();   // element -> raw
let renderQueued = false;

// rAF 和兜底定时器都会调它，重复执行必须无害
function flushRenders() {
  renderQueued = false;
  if (!pendingRenders.size) return;
  for (const [el, raw] of pendingRenders) el.replaceChildren(renderMarkdown(raw));
  pendingRenders.clear();
  scrollToBottom();
}

function scheduleRender(el, raw) {
  pendingRenders.set(el, raw);
  if (renderQueued) return;
  renderQueued = true;
  // 用 rAF 节流，避免每个 chunk 都重绘。
  // 但页面处于后台时 rAF 不会触发（切到别的窗口、或面板被遮住），
  // 光靠它文字就永远不出来 —— 所以再挂一个定时器兜底，谁先到算谁的。
  requestAnimationFrame(flushRenders);
  setTimeout(flushRenders, 120);
}

function appendDelta(text) {
  if (!bubble) {
    bubble = addBlock('msg assistant', '');
    bubbleRaw = '';
  }
  bubbleRaw += text;
  scheduleRender(bubble, bubbleRaw);
}

/**
 * 收尾当前气泡：立刻把待渲染的内容画出来，再断开引用。
 * 不能等 rAF/定时器 —— 后台标签页里两者都会被节流，一轮都结束了
 * 文字还没出现。而这时候已经没有后续流式了，同步渲染没有性能问题。
 */
function closeBubble() {
  flushRenders();
  bubble = null;
  thinkBody = null;
}

/**
 * 一轮结束后在末尾放「复制 / 重新生成」。
 * 答得不好只能重打一遍问题，是最容易被抱怨的地方。
 */
function showActions() {
  log.querySelector('.turn-actions')?.remove();
  const bubbles = [...log.querySelectorAll('.msg.assistant')];
  if (!bubbles.length) return;

  const row = document.createElement('div');
  row.className = 'turn-actions';

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'act';
  copy.textContent = '复制';
  copy.addEventListener('click', async () => {
    // 复制整轮的助手文本，而不是只复制最后一个气泡
    const text = bubbles.map((b) => b.textContent).join('\n\n').trim();
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = '已复制';
    } catch {
      copy.textContent = '复制失败';
    }
    setTimeout(() => { copy.textContent = '复制'; }, 1500);
  });

  const again = document.createElement('button');
  again.type = 'button';
  again.className = 'act';
  again.textContent = '重新生成';
  again.addEventListener('click', () => { if (!busy) send({ type: 'regenerate' }); });

  row.append(copy, again);
  log.append(row);
}

/** 历史恢复用：一次性渲染一整段 Markdown。 */
function addMarkdown(text) {
  const el = addBlock('msg assistant', '');
  el.replaceChildren(renderMarkdown(text));
  return el;
}

function appendThinking(text) {
  if (!thinkBody) {
    const d = document.createElement('details');
    d.className = 'thinking';
    const s = document.createElement('summary');
    s.textContent = '推理过程';
    thinkBody = document.createElement('div');
    thinkBody.className = 'body';
    d.append(s, thinkBody);
    log.append(d);
    bubble = null;
    updateSuggests();
  }
  thinkBody.textContent += text;
}

function addTool(name, inputObj) {
  const el = document.createElement('div');
  el.className = 'tool';

  const n = document.createElement('span');
  n.className = 'name';
  n.textContent = name;

  const args = document.createElement('span');
  args.className = 'args';
  const a = compactArgs(inputObj);
  args.textContent = a ? ' ' + a : '';

  el.append(n, args);
  log.append(el);
  pendingTool = el;
  updateSuggests();
}

function finishTool(ok, preview) {
  if (!pendingTool) return;
  if (!ok) pendingTool.classList.add('fail');
  const r = document.createElement('span');
  r.className = 'result';
  r.textContent = (ok ? '✓ ' : '✗ ') + (preview || '');
  pendingTool.append(r);
  pendingTool = null;
}

/** 自动模式拦下不可逆操作时的确认卡。 */
function addConfirm(msg) {
  const el = document.createElement('div');
  el.className = 'confirm';

  const head = document.createElement('div');
  head.className = 'c-head';
  head.textContent = '需要你确认';

  const body = document.createElement('div');
  body.className = 'c-body';
  body.textContent = `这一步${msg.risk}，执行后可能无法撤销。`;

  const what = document.createElement('code');
  what.className = 'c-what';
  what.textContent = `${msg.name} ${compactArgs(msg.input)}`;

  const acts = document.createElement('div');
  acts.className = 'c-acts';
  const no = document.createElement('button');
  no.className = 'c-no';
  no.textContent = '拒绝';
  const yes = document.createElement('button');
  yes.className = 'c-yes';
  yes.textContent = '允许执行';

  const answer = (ok) => {
    send({ type: 'approve', id: msg.id, ok });
    el.classList.add('answered');
    const v = document.createElement('span');
    v.className = 'c-verdict';
    v.textContent = ok ? '✓ 你允许了这一步' : '✗ 你拒绝了这一步';
    el.append(v);
  };
  no.addEventListener('click', () => answer(false));
  yes.addEventListener('click', () => answer(true));

  acts.append(no, yes);
  el.append(head, body, what, acts);
  log.append(el);
  updateSuggests();
  scrollToBottom();
}

function compactArgs(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return Object.entries(obj)
    .map(([k, v]) => {
      let s = typeof v === 'string' ? v : JSON.stringify(v);
      if (s.length > 40) s = s.slice(0, 40) + '…';
      return `${k}=${s}`;
    })
    .join(' ');
}

function scrollToBottom() { log.scrollTop = log.scrollHeight; }

const kilo = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

/**
 * 头部的用量。输入显示的是**这一轮发出去的整个对话有多长** ——
 * 那才是衡量离上下文上限还有多远的指标；输出是累计值。
 * 端点不报 usage（很多兼容端点不支持 stream_options）时整块不显示。
 */
function renderUsage(u) {
  if (!u || (!u.lastInput && !u.output)) { usageEl.hidden = true; return; }
  usageEl.hidden = false;
  usageEl.textContent = `↑${kilo(u.lastInput)} ↓${kilo(u.output)}`;

  const pct = u.limit > 0 ? Math.round((u.lastInput / u.limit) * 100) : 0;
  usageEl.classList.toggle('warn', pct >= 80);
  usageEl.title =
    `本轮输入上下文：${u.lastInput.toLocaleString()} token` +
    (u.limit > 0 ? `（上限 ${u.limit.toLocaleString()}，已用 ${pct}%）` : '') +
    `\n累计输出：${u.output.toLocaleString()} token` +
    (u.cacheRead ? `\n缓存命中：${u.cacheRead.toLocaleString()} token` : '') +
    `\n对话轮次：${u.turns}` +
    '\n\n上限在设置里配，只用于预警，不影响请求。';
}

/** 去掉协议和末尾斜杠，长了从中间省略 —— 上下文条只有一行的宽度。 */
function prettyUrl(url) {
  const s = String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return s.length > 60 ? s.slice(0, 34) + '…' + s.slice(-22) : s;
}

// ── 历史对话 ───────────────────────────────────────────────────

/** 把存下来的展示流水重新画出来。流水是与厂商无关的，所以不用解析消息结构。 */
function renderView(view) {
  for (const item of view) {
    if (item.role === 'user') addBlock('msg user', item.text);
    else if (item.role === 'assistant') addMarkdown(item.text);
    else if (item.role === 'tool') {
      addTool(item.name, item.input);
      finishTool(item.ok, item.preview);
    }
  }
}

function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} 小时前`;
  if (d < 7 * 86400e3) return `${Math.floor(d / 86400e3)} 天前`;
  return new Date(ts).toLocaleDateString();
}

let convTimer = null;

function renderConversations(list, current) {
  clearTimeout(convTimer);
  convList.replaceChildren();
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'conv-empty';
    p.textContent = '还没有历史对话。聊过之后会自动存在这里。';
    convList.append(p);
    return;
  }
  for (const c of list) {
    const row = document.createElement('div');
    row.className = 'conv' + (c.id === current ? ' current' : '');

    const body = document.createElement('button');
    body.type = 'button';
    body.className = 'conv-body';
    body.style.cssText = 'border:none;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;padding:0';
    const t = document.createElement('span');
    t.className = 'conv-title';
    t.textContent = c.title || '(无标题)';
    const m = document.createElement('span');
    m.className = 'conv-meta';
    m.textContent = [c.origin, relTime(c.updatedAt)].filter(Boolean).join(' · ');
    body.append(t, m);
    body.addEventListener('click', () => send({ type: 'load_conversation', id: c.id }));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'conv-del';
    del.textContent = '×';
    del.title = '删除这条对话';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      send({ type: 'delete_conversation', id: c.id });
    });

    row.append(body, del);
    convList.append(row);
  }
}

document.getElementById('history').addEventListener('click', () => {
  drawer.hidden = false;
  // 先摆一个"加载中"，这样"请求没发出去"和"确实没有历史"在界面上是可区分的 ——
  // 一直停在加载中就说明后台没回，而不是列表为空
  convList.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'conv-empty';
  loading.textContent = '正在读取历史…';
  convList.append(loading);

  // 后台不回就别让它一直转 —— 把真正的原因说出来
  clearTimeout(convTimer);
  convTimer = setTimeout(() => {
    loading.textContent = backendOk
      ? '后台没有响应。关掉侧边栏重新打开再试；还不行就到浏览器的扩展管理页点刷新 ⟳。'
      : staleBackendMsg();
  }, 2500);

  send({ type: 'list_conversations' });
});
document.getElementById('drawerClose').addEventListener('click', () => { drawer.hidden = true; });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !drawer.hidden) drawer.hidden = true;
});

// ── 建议卡 ─────────────────────────────────────────────────────
//
// prompt 末尾留空格的表示还要你补完内容，不会一点就发；
// write:true 的需要点击/输入权限，在计划模式下会被置灰。

const ICONS = {
  list:   'M4 6h16M4 12h16M4 18h10',
  search: 'M20 20l-3.5-3.5M4 11a7 7 0 1 0 14 0 7 7 0 0 0-14 0',
  down:   'M12 5v14M6 13l6 6 6-6',
  link:   'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  zap:    'M13 2L4.5 13H11l-1 9 8.5-11H12l1-9z',
  pen:    'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z',
  bullets: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  quote:  'M7 7h4v5a4 4 0 0 1-4 4M14 7h4v5a4 4 0 0 1-4 4',
};

// 按优先级排列。when() 决定这条在当前页面上有没有意义 ——
// 没有表单就不该出现「帮我填表」，所以显示几条是页面说了算，不是固定 3 条。
const CANDIDATES = [
  { label: '解释选中', icon: 'quote',   cls: 'p', prompt: '解释一下我选中的这段内容',
    when: (p) => p.hasSelection },
  { label: '总结',     icon: 'list',    cls: 'g', prompt: '这个页面在讲什么？帮我总结要点',
    when: (p) => p.textLen > 400 },
  { label: '搜索',     icon: 'zap',     cls: 'b', prompt: '帮我在这个页面的搜索框搜索 ',
    write: true, when: (p) => p.searchBoxes > 0 },
  { label: '填表',     icon: 'pen',     cls: 'p', prompt: '帮我把这个表单填完，内容是 ',
    write: true, when: (p) => p.forms > 0 && p.fields >= 2 },
  { label: '找元素',   icon: 'search',  cls: 'b', prompt: '页面上有哪些可以点击和输入的元素？',
    when: (p) => p.buttons + p.fields > 3 },
  { label: '提取',     icon: 'bullets', cls: 'o', prompt: '把页面里的关键信息整理成条目列表',
    when: (p) => p.textLen > 1500 },
  { label: '外链',     icon: 'link',    cls: 'b', prompt: '列出页面上所有指向站外的链接',
    when: (p) => p.externalLinks >= 8 },
  { label: '翻到底',   icon: 'down',    cls: 'o', prompt: '翻到页面底部，看看还有什么内容',
    when: (p) => p.scrollable },
];

const MAX_CARDS = 4;
let pageProfile = null;

function renderCards() {
  const mode = modeSel.value;
  cardsEl.replaceChildren();

  if (!pageProfile) {
    // 当前不是普通网页。重点是让用户知道**照样可以问** —— 以前这里会让人
    // 以为扩展在这种页面上完全不能用。
    suggestHint.textContent = '当前页面读不了，但你可以直接问我任何问题。';
    return;
  }
  const picked = CANDIDATES.filter((c) => c.when(pageProfile)).slice(0, MAX_CARDS);
  suggestHint.textContent = picked.length ? '根据这个页面能做的：' : '';

  for (const item of picked) {
    const blocked = item.write && mode === 'plan';
    // 荐 = 一点就能直接发（提示词完整），且当前模式下能完整执行
    const recommended = !blocked && !item.prompt.endsWith(' ');

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card';
    card.dataset.prompt = item.prompt;
    if (blocked) {
      card.disabled = true;
      card.title = '计划模式下不能点击或输入，切到「自动」再用';
    }

    const ic = document.createElement('span');
    ic.className = `c-ic ${item.cls}`;
    ic.innerHTML =
      `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ` +
      `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="${ICONS[item.icon]}"/></svg>`;

    const label = document.createElement('span');
    label.className = 'c-label';
    label.textContent = item.label;

    const prompt = document.createElement('span');
    prompt.className = 'c-prompt';
    prompt.textContent = item.prompt.trim();

    card.append(ic, label, prompt);
    if (recommended) {
      const b = document.createElement('span');
      b.className = 'c-badge';
      b.textContent = '荐';
      card.append(b);
    }
    cardsEl.append(card);
  }
}

function updateSuggests() {
  suggests.hidden = log.children.length > 0;
}

cardsEl.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card || card.disabled || busy) return;
  const text = card.dataset.prompt || '';
  input.value = text;
  autoGrow();
  input.focus();
  // 末尾留空格的表示还要用户补内容，不直接发
  if (!text.endsWith(' ')) form.requestSubmit();
});

// 只在对话为空（也就是建议卡真的会显示）时才去问页面画像 ——
// 不为了做点装饰就往每个页面注脚本。
// 注意别再加 document.hidden 判断：面板刚打开时这个值可能还是 true，
// 那样首次画像就永远取不到，建议卡一直是空的。
let profileTimer = null;
function requestProfile() {
  if (log.children.length) return;
  clearTimeout(profileTimer);
  profileTimer = setTimeout(() => send({ type: 'profile' }), 250);
}

api.tabs.onActivated.addListener(requestProfile);
api.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete') requestProfile(); });

// ── 模式与模型 ─────────────────────────────────────────────────

function setMode(mode, notify = true) {
  if (!MODES.includes(mode)) mode = 'auto';
  modeSel.value = mode;
  modeSel.dataset.mode = mode;
  input.placeholder =
    mode === 'plan' ? '先看看页面，给你一份计划' :
    mode === 'always' ? '不会再弹确认，直接执行' :
    '问点什么，或让我操作这个页面';
  if (notify) send({ type: 'mode', mode });
  api.storage.local.set({ mode });
  renderCards();
}

modeSel.addEventListener('change', () => setMode(modeSel.value));

// 借 grok-build 的手势：Shift+Tab 循环切换模式
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !e.shiftKey) return;
  e.preventDefault();
  setMode(MODES[(MODES.indexOf(modeSel.value) + 1) % MODES.length]);
});

// 一个配置档 = 接口格式 + Base URL + 模型 + Key。切换时把整档写进生效配置，
// 所以从 DeepSeek 换到 Claude 是一次点击，而不是回设置页改四个字段。

async function loadModels() {
  const { accounts = [], activeAccount = '', model = '', provider = '' } =
    await api.storage.local.get(['accounts', 'activeAccount', 'model', 'provider']);

  const active = accounts.find((a) => a.id === activeAccount);
  modelName.textContent = model || '未配置';
  modelDot.className = 'dot ' + (active?.provider || provider || '');
  modelBtn.title = active ? `${active.name} · ${model}` : '还没配置模型，点这里去设置';

  modelMenu.replaceChildren();

  // 按账号分组：账号名做小标题，模型排在下面。
  // 同一家的多个模型共用地址和密钥，这里也就不用重复展示。
  for (const acc of accounts) {
    if (!acc.models?.length) continue;

    const gh = document.createElement('div');
    gh.className = 'menu-group';
    const gdot = document.createElement('span');
    gdot.className = `dot ${acc.provider}`;
    const gtx = document.createElement('span');
    gtx.textContent = acc.name + (acc.apiKey ? '' : ' · 缺 API Key');
    gh.append(gdot, gtx);
    modelMenu.append(gh);

    for (const m of acc.models) {
      const on = acc.id === activeAccount && m === model;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'menu-row indent';
      row.dataset.account = acc.id;
      row.dataset.model = m;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(on));

      const body = document.createElement('span');
      body.className = 'm-body';
      const nm = document.createElement('span');
      nm.className = 'm-name';
      nm.textContent = m;
      body.append(nm);
      row.append(body);

      if (on) {
        const ck = document.createElement('span');
        ck.className = 'm-check';
        ck.textContent = '✓';
        row.append(ck);
      }
      modelMenu.append(row);
    }
  }

  if (accounts.some((a) => a.models?.length)) {
    const sep = document.createElement('div');
    sep.className = 'menu-sep';
    modelMenu.append(sep);
  }
  const manage = document.createElement('button');
  manage.type = 'button';
  manage.className = 'menu-manage';
  manage.id = 'manageProfiles';
  manage.textContent = accounts.length ? '管理账号与模型…' : '去设置里添加账号…';
  modelMenu.append(manage);
}

function closeMenu() {
  modelMenu.hidden = true;
  modelBtn.setAttribute('aria-expanded', 'false');
}

modelBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = modelMenu.hidden;
  modelMenu.hidden = !open;
  modelBtn.setAttribute('aria-expanded', String(open));
});

modelMenu.addEventListener('click', async (e) => {
  if (e.target.closest('#manageProfiles')) {
    closeMenu();
    api.runtime.openOptionsPage();
    return;
  }
  const row = e.target.closest('.menu-row');
  if (!row) return;
  const { accounts = [] } = await api.storage.local.get('accounts');
  const acc = accounts.find((a) => a.id === row.dataset.account);
  if (!acc) return;
  // 选中的模型 + 它所属账号的地址密钥，一起写进生效配置
  await api.storage.local.set({
    activeAccount: acc.id,
    provider: acc.provider,
    baseUrl: acc.baseUrl,
    apiKey: acc.apiKey,
    model: row.dataset.model,
  });
  closeMenu();
});

document.addEventListener('click', (e) => {
  if (!modelMenu.hidden && !e.target.closest('.picker')) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modelMenu.hidden) closeMenu();
});

api.storage.onChanged.addListener((ch) => {
  if (ch.accounts || ch.activeAccount || ch.model || ch.provider) loadModels();
});

// ── 交互 ───────────────────────────────────────────────────────

// @ ：把页面上选中的文字插进输入框
mentionBtn.addEventListener('click', () => send({ type: 'get_selection' }));

function insertAtCursor(text) {
  const s = input.selectionStart ?? input.value.length;
  const e = input.selectionEnd ?? s;
  const quoted = `「${text.trim()}」`;
  input.value = input.value.slice(0, s) + quoted + input.value.slice(e);
  const pos = s + quoted.length;
  input.setSelectionRange(pos, pos);
  input.focus();
  autoGrow();
}

function setBusy(v) {
  busy = v;
  sendBtn.hidden = v;
  stopBtn.hidden = !v;
  input.disabled = v;
  if (!v) {
    stepEl.hidden = true;
    input.focus();
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  log.querySelector('.turn-actions')?.remove();   // 上一轮的操作按钮该收了
  addBlock('msg user', text);
  input.value = '';
  autoGrow();
  setBusy(true);
  send({ type: 'user_message', text, mode: modeSel.value });
  scrollToBottom();
});

stopBtn.addEventListener('click', () => send({ type: 'abort' }));
document.getElementById('reset').addEventListener('click', () => send({ type: 'reset' }));
document.getElementById('settings').addEventListener('click', () => api.runtime.openOptionsPage());

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener('input', autoGrow);

function autoGrow() {
  input.style.height = 'auto';
  const h = Math.min(input.scrollHeight, 150);
  input.style.height = h + 'px';
  // 只有顶到 max-height 时才需要滚动条
  input.style.overflowY = input.scrollHeight > 150 ? 'auto' : 'hidden';
  // 有内容才点亮发送键
  sendBtn.classList.toggle('ready', input.value.trim().length > 0);
}

// 开面板就握手一次。旧后端不认识 ping，也就永远不会回 hello ——
// 超时没等到就直接把原因摆出来，别等用户点了功能才发现是坏的。
send({ type: 'ping' });
setTimeout(() => { if (!backendOk) addBlock('msg error', staleBackendMsg()); }, 2500);

api.storage.local.get('mode').then((c) => setMode(c.mode || 'auto', false));
loadModels();
renderCards();
updateSuggests();
requestProfile();
input.focus();
