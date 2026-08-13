// 新标签页 / 浏览器内部页面上也要能正常对话。
// 页面能不能读是这一轮的**属性**，不是前置条件 —— 绝大多数问题根本不需要页面。

import { suite } from '../helpers/assert.mjs';
import { launchWithExtension, askAndWait, panelState } from '../helpers/cdp.mjs';
import { startMock, startSite, oai, configScript } from '../helpers/mock.mjs';
import { sleep } from '../helpers/env.mjs';

const s = suite('nopage');

const site = await startSite(
  '<!doctype html><meta charset=utf-8><title>普通网页</title><h1>普通网页</h1><p>正文内容。</p><button>按钮</button>'
);

// 听话的模型：有工具就先读页面，没工具就直接答
const mock = await startMock(({ turn, body }) => {
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (hasTools && turn === 1) {
    return [oai.text('我先读一下页面。'), oai.toolCall('read_page', '{}', 'c1'), oai.stop('tool_calls')];
  }
  return [oai.text('巴黎是法国的首都。'), oai.stop()];
});

const browser = await launchWithExtension();
const sw = await browser.serviceWorker();
await sw.evalJs(configScript(mock.url));

const blankTab = await browser.newTab('about:blank');
await sleep(800);
const pageTab = await browser.newTab(site.url);
await sleep(2000);
const panel = await browser.openPanel();

const ask = async (tabId, text) => {
  await browser.activate(tabId);
  await sleep(400);
  mock.reset();
  await askAndWait(panel, text);
};
const reset = async () => { await panel.evalJs(`document.getElementById('reset').click()`); await sleep(700); };

// ── 1. about:blank 上直接提问 ────────────────────────────────────
s.section('about:blank 上提问');
await ask(blankTab.id, '法国的首都是哪里？');
{
  const u = await panelState(panel);
  s.t('没有报错', u.errors.length === 0, JSON.stringify(u.errors));
  s.t('模型正常回答了', u.assistant.includes('巴黎'), u.assistant);
  s.t('没有尝试调用页面工具', u.tools.length === 0, JSON.stringify(u.tools));
  s.t('上下文条说明当前读不了页面', u.context.includes('无可读页面'), u.context);

  const req = mock.reqs[0];
  s.t('这一轮压根没下发工具', !req.tools || req.tools.length === 0,
    JSON.stringify(req.tools?.map?.((x) => x.function?.name)));
  const sys = String(req.messages[0].content);
  s.t('系统提示告诉模型这轮没有页面工具', sys.includes('没有给你任何页面工具'), sys.slice(-200));
  s.t('明确要求它别喊"需要先读取页面"', sys.includes('不要说"我需要先读取页面"'));
  s.t('没有夹带无关的页面操作规矩', !sys.includes('[ref=N]'), '没有页面工具时不该讲 ref 编号');
  s.t('没有夹带无关的模式说明', !sys.includes('自动模式'), '没有页面工具时模式段没有意义');
  s.t('核心身份仍在，且鼓励展开回答', sys.includes('通用助手') && sys.includes('该展开就展开'));
}

// ── 2. 切回普通网页 ──────────────────────────────────────────────
s.section('切回普通网页');
await reset();
await ask(pageTab.id, '这个页面在讲什么');
{
  const u = await panelState(panel);
  s.t('页面工具恢复可用',
    u.tools.some((x) => x.includes('read_page') && x.includes('✓')), JSON.stringify(u.tools));
  s.t('上下文条显示真实网址', u.context.includes(String(site.port)), u.context);
  const req = mock.reqs[0];
  s.t('这一轮下发了全部 6 个工具', (req.tools || []).length === 6, String((req.tools || []).length));
  s.t('系统提示里带上了真实网址', String(req.messages[0].content).includes(String(site.port)));
  s.t('这时才讲页面操作规矩', String(req.messages[0].content).includes('[ref=N]'));
}

// ── 3. 同一会话里切回空白页 ──────────────────────────────────────
s.section('同一会话里切回空白页');
await ask(blankTab.id, '再问一个无关的问题');
{
  const req = mock.reqs[0];
  s.t('工具随标签页切换而消失', !req.tools || req.tools.length === 0,
    JSON.stringify(req.tools?.map?.((x) => x.function?.name)));
  s.t('全程没有报错', (await panelState(panel)).errors.length === 0);
}

// ── 4. chrome:// 内部页面 ────────────────────────────────────────
s.section('chrome:// 内部页面');
await reset();
{
  const chromeTab = await browser.newTab('chrome://version');
  await sleep(1800);
  await ask(chromeTab.id, '这是什么问题都行');
  const u = await panelState(panel);
  s.t('浏览器内部页面上不再报错', u.errors.length === 0, JSON.stringify(u.errors));
  s.t('模型照常回答', u.assistant.includes('巴黎'), u.assistant);
}

browser.stop();
await mock.close();
await site.close();
s.done();
