// 用量计数与预警、右键菜单入口、复制与重新生成。

import { suite } from '../helpers/assert.mjs';
import { launchWithExtension, askAndWait, panelState } from '../helpers/cdp.mjs';
import { startMock, startSite, oai, ant, sse, configScript } from '../helpers/mock.mjs';
import { sleep } from '../helpers/env.mjs';

const s = suite('usage');

const site = await startSite(
  '<!doctype html><meta charset=utf-8><title>用量测试页</title><h1>用量测试页</h1><p>正文。</p>'
);

let inputTokens = 1000;
let reply = '第一次的回答。';
const mock = await startMock(({ turn, anthropic }) => {
  if (anthropic) {
    return [
      sse({ type: 'message_start', message: { id: 'm', role: 'assistant', content: [],
        usage: { input_tokens: inputTokens, cache_read_input_tokens: 40 } } }),
      ant.text(reply),
      sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 120 } }),
    ];
  }
  return [
    oai.text(reply),
    oai.stop(),
    sse({ choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: 120, prompt_cache_hit_tokens: 40 } }),
  ];
});

const browser = await launchWithExtension();
const sw = await browser.serviceWorker();
await sw.evalJs(configScript(mock.url, { extra: { contextLimit: 10000 } }));

const pageTab = await browser.newTab(site.url);
await sleep(2000);
const panel = await browser.openPanel();

const ask = async (text) => {
  await browser.activate(pageTab.id);
  await sleep(300);
  mock.reset();
  await askAndWait(panel, text);
};
const usage = () => panel.json(`{
  hidden: document.getElementById('usage').hidden,
  text: document.getElementById('usage').textContent,
  title: document.getElementById('usage').title,
  warn: document.getElementById('usage').classList.contains('warn') }`);

// ── 1. 用量显示 ──────────────────────────────────────────────────
s.section('用量显示');
await ask('第一个问题');
{
  const u = await usage();
  s.t('用量条显示出来了', !u.hidden, JSON.stringify(u));
  s.t('显示输入与输出', u.text.includes('1.0K') && u.text.includes('120'), u.text);
  s.t('悬浮提示给出精确数字', u.title.includes('1,000') && u.title.includes('120'), u.title);
  s.t('缓存命中也报出来', u.title.includes('缓存命中'), u.title);
  s.t('未超阈值时不告警', !u.warn);

  const req = mock.reqs[0];
  s.t('OpenAI 兼容格式带上了 stream_options',
    req.stream_options?.include_usage === true, JSON.stringify(req.stream_options));
}

// ── 2. 接近上限时预警 ────────────────────────────────────────────
s.section('接近上限预警');
inputTokens = 9000;   // 上限 10000 的 90%
await ask('第二个问题');
{
  const u = await usage();
  s.t('超过 80% 时用量条变红', u.warn, JSON.stringify(u));
  s.t('悬浮提示显示百分比', u.title.includes('90%'), u.title);
  const st = await panelState(panel);
  s.t('同时给出可操作的提醒', st.infos.some((x) => x.includes('接近你设置的上限')), JSON.stringify(st.infos));
}
inputTokens = 500;
await ask('第三个问题');
{
  const st = await panelState(panel);
  s.t('预警只提醒一次，不每轮刷屏',
    st.infos.filter((x) => x.includes('接近你设置的上限')).length === 1, JSON.stringify(st.infos));
}

// ── 3. 复制与重新生成 ────────────────────────────────────────────
s.section('复制与重新生成');
{
  const acts = await panel.json(`[...document.querySelectorAll('.turn-actions .act')].map(b=>b.textContent)`);
  s.t('一轮结束后出现操作按钮', acts.join(',') === '复制,重新生成', JSON.stringify(acts));

  reply = '重新生成后的回答。';
  const usersBefore = (await panelState(panel)).users.length;
  await panel.evalJs(`[...document.querySelectorAll('.turn-actions .act')][1].click()`);
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    if (await panel.evalJs(`document.getElementById('stop').hidden`)) break;
  }
  await sleep(600);
  const st = await panelState(panel);
  s.t('重新生成没有重复插入用户消息', st.users.length === usersBefore, `${usersBefore} -> ${st.users.length}`);
  s.t('最后一条用户消息还在', st.users[st.users.length - 1] === '第三个问题', JSON.stringify(st.users));
  s.t('换成了新的回答', st.assistant.includes('重新生成后的回答'), st.assistant);
  // 只有最后一轮该被替换，前两轮的回答本来就该留着
  s.t('只替换了最后一轮的回答',
    st.assistant.split('|').filter((x) => x.includes('重新生成后的回答')).length === 1 &&
      st.assistant.split('|').filter((x) => x.includes('第一次的回答')).length === 2,
    st.assistant);

  const texts = mock.reqs[0].messages
    .filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content);
  s.t('重发的是同一句话，且历史没有重复',
    texts.filter((t) => t === '第三个问题').length === 1, JSON.stringify(texts));
}

// ── 4. 右键菜单入口 ──────────────────────────────────────────────
s.section('右键菜单入口');
{
  const menus = await sw.evalJs(`new Promise(r => chrome.contextMenus.removeAll(() => r('ok')))`);
  s.t('contextMenus 权限可用', menus === 'ok');

  // 直接走 onClicked 的处理逻辑：面板已开着，应该收到 prefill
  await panel.evalJs(`document.getElementById('reset').click()`);
  await sleep(600);
  reply = '这段讲的是……';
  mock.reset();
  await sw.evalJs(`chrome.storage.session.set({ pendingPrompt: '解释一下这段内容：\\n\\n「测试选中的文字」' })`);
  // 重开面板，验证「先点右键、面板后开」这条路径
  await browser.closeTab(panel.tabId);
  panel.close();
  await sleep(800);
}
{
  const p2 = await browser.openPanel();
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    if (await p2.evalJs(`document.getElementById('stop').hidden`)
        && (await p2.evalJs(`document.querySelectorAll('.msg.user').length`)) > 0) break;
  }
  const st = await panelState(p2);
  s.t('面板打开后取走了暂存的右键内容',
    st.users.some((x) => x.includes('测试选中的文字')), JSON.stringify(st.users));
  s.t('暂存项已清除',
    !(await sw.evalJs(`chrome.storage.session.get('pendingPrompt')`)).pendingPrompt);
}

browser.stop();
await mock.close();
await site.close();
s.done();
