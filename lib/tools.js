// 工具定义（供应商无关的 JSON Schema）+ 派发到 content script。
//
// 工具描述刻意写得很啰嗦：对模型来说，"什么时候该调这个工具"比"这个工具做什么"
// 重要得多。ref 失效的提示也写在描述里，模型才会自己重新 read_page 而不是卡死。

export const TOOL_DEFS = [
  {
    name: 'read_page',
    description:
      '读取当前页面。返回带 [ref=N] 编号的结构化快照，编号可用于 click / type_text。\n' +
      '在执行任何点击或输入之前，必须先调用本工具拿到最新编号。\n' +
      '页面跳转、翻页、或点击后内容变化时，旧编号会失效，需要重新调用。',
    schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['outline', 'text'],
          description:
            'outline（默认）= 带 ref 编号的结构树，用于操作页面；' +
            'text = 纯正文，用于阅读或总结长文章（不含 ref，无法操作）',
        },
      },
    },
  },
  {
    name: 'click',
    description:
      '点击页面上的一个元素。ref 必须来自最近一次 read_page 的输出。\n' +
      '点击后页面内容通常会变化，需要重新 read_page 才能继续操作。',
    schema: {
      type: 'object',
      properties: {
        ref: { type: 'integer', description: 'read_page 输出里 [ref=N] 的编号' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'type_text',
    description:
      '在输入框、文本域或可编辑区域里输入文字。会先清空原有内容。\n' +
      'submit 为 true 时，输入完按一次回车（用于搜索框这类场景）。',
    schema: {
      type: 'object',
      properties: {
        ref: { type: 'integer', description: 'read_page 输出里 [ref=N] 的编号' },
        text: { type: 'string', description: '要输入的文字' },
        submit: { type: 'boolean', description: '输入后是否按回车提交，默认 false' },
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'scroll',
    description:
      '滚动页面。当 read_page 的输出被截断，或需要查看页面下方内容时使用。\n' +
      '滚动后需要重新 read_page 才能看到新出现的内容。',
    schema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['down', 'up', 'top', 'bottom'],
          description: 'down/up = 滚动一屏；top/bottom = 直接到顶部/底部',
        },
        amount: { type: 'integer', description: '像素数，不填则滚动一屏' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'navigate',
    description:
      '让当前标签页跳转到指定 URL（只支持 http/https）。跳转后所有旧的 ref 都会失效。',
    schema: {
      type: 'object',
      properties: { url: { type: 'string', description: '完整 URL，含 https://' } },
      required: ['url'],
    },
  },
  {
    name: 'wait',
    description:
      '等待一段时间，用于等页面异步加载完成。仅在点击后页面明显还没渲染好时使用。',
    schema: {
      type: 'object',
      properties: { ms: { type: 'integer', description: '毫秒数，最大 5000' } },
      required: ['ms'],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────
// 派发
// ─────────────────────────────────────────────────────────────────────

const BLOCKED = [
  'chrome://', 'chrome-extension://', 'edge://', 'about:', 'devtools://',
  'view-source:', 'file://',
];

export function assertInjectable(url = '') {
  if (BLOCKED.some((p) => url.startsWith(p)))
    throw new Error(`无法在 ${url.split('/')[0]}// 这类浏览器内部页面上操作，请切换到一个普通网页。`);
  if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(url))
    throw new Error('Chrome 应用商店页面禁止扩展注入脚本，请切换到其他网页。');
}

/** 幂等注入：已经注入过就直接返回，不会重复注册监听器。 */
export async function ensureContentScript(tabId) {
  const tab = await chrome.tabs.get(tabId);
  assertInjectable(tab.url || '');
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    if (pong?.ok) return;
  } catch {
    // 还没注入，往下走
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

export async function runTool(tabId, name, input = {}) {
  switch (name) {
    case 'navigate':
      return await navigate(tabId, input.url);

    case 'wait': {
      const ms = Math.min(Math.max(Number(input.ms) || 0, 0), 5000);
      await sleep(ms);
      return `已等待 ${ms}ms。`;
    }

    default:
      await ensureContentScript(tabId);
      return await sendToPage(tabId, { type: name, ...input });
  }
}

async function sendToPage(tabId, message) {
  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // 页面在工具执行途中导航了，content script 被销毁 —— 重注入再试一次
    await ensureContentScript(tabId);
    res = await chrome.tabs.sendMessage(tabId, message);
  }
  if (!res) throw new Error('页面没有响应，可能正在加载中，可以先用 wait 等一会儿再重试。');
  if (!res.ok) throw new Error(res.error || '操作失败');
  return res.data;
}

async function navigate(tabId, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`URL 格式不合法：${url}`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('只支持 http/https 链接。');

  await chrome.tabs.update(tabId, { url: u.href });
  await waitForLoad(tabId);
  await ensureContentScript(tabId);

  const tab = await chrome.tabs.get(tabId);
  return (
    `已跳转到 ${tab.url}\n标题：${tab.title || '(无)'}\n` +
    `（页面已变化，之前所有 ref 编号失效，需要重新调用 read_page）`
  );
}

function waitForLoad(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      // 给 SPA 的首屏渲染留一点时间
      setTimeout(resolve, 400);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────
// 风险判定（自动模式下用来决定要不要弹确认）
//
// 刻意用「按钮上写了什么字」而不是猜意图：模型可能判断错，但页面上明明白白
// 写着「立即购买」的按钮，点下去就是不可逆的。宁可多问一次。
// ─────────────────────────────────────────────────────────────────────

const RISKY_TEXT = new RegExp(
  [
    // 中文
    '购买', '下单', '付款', '支付', '结算', '充值', '提现', '转账', '汇款',
    '删除', '移除', '清空', '注销', '解绑', '退订', '取消订阅',
    '发送', '发布', '提交', '确认', '同意', '授权', '登录', '注册',
    // 英文
    'buy\\s?now', 'check\\s?out', 'place\\s+order', '\\bpay\\b', 'purchase',
    '\\bdelete\\b', 'remove', 'discard', 'submit', '\\bsend\\b', 'publish',
    'confirm', 'authorize', 'unsubscribe', 'deactivate', 'sign\\s?in', 'log\\s?in',
  ].join('|'),
  'i'
);

export async function assessRisk(tabId, name, input = {}) {
  if (name === 'navigate') {
    try {
      const tab = await chrome.tabs.get(tabId);
      const to = new URL(input.url);
      const from = new URL(tab.url || 'about:blank');
      if (to.origin !== from.origin) return `跳转到其他站点 ${to.host}`;
    } catch { /* URL 不合法交给 runTool 去报错 */ }
    return null;
  }

  if (name !== 'click' && name !== 'type_text') return null;

  // 问 content script 这个 ref 指的是什么，别在没看清元素的情况下点下去
  let el;
  try {
    el = await sendToPage(tabId, { type: 'peek', ref: input.ref });
  } catch {
    return null; // ref 已失效之类，交给 runTool 报错
  }
  if (!el) return null;

  const label = `${el.name || ''} ${el.value || ''}`.trim();
  if (RISKY_TEXT.test(label)) return `「${(el.name || '该元素').slice(0, 24)}」看起来是不可逆操作`;
  if (name === 'type_text' && input.submit && el.inForm) return '提交表单';
  if (el.tag === 'A' && el.external) return `跳转到其他站点 ${el.external}`;
  return null;
}
