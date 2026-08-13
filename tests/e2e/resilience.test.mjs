// 韧性：一轮内并行工具调用、Service Worker 被回收后的恢复、
// 关掉面板重新打开后历史仍在。

import { suite } from '../helpers/assert.mjs';
import { launchWithExtension, askAndWait, panelState } from '../helpers/cdp.mjs';
import { startMock, startSite, oai, configScript } from '../helpers/mock.mjs';
import { sleep } from '../helpers/env.mjs';

const s = suite('resilience');

const site = await startSite(
  '<!doctype html><meta charset=utf-8><title>Example Domain</title><h1>Example Domain</h1><p>正文。</p>'
);

let mode = 'single';
const mock = await startMock(({ turn }) => {
  if (turn > 1) return [oai.text('完成。'), oai.stop()];
  if (mode === 'parallel') {
    return [
      oai.text('我并行做三件事。'),
      oai.toolCall('read_page', '{}', 'p1', 0),
      oai.toolCall('scroll', '{"direction":"bottom"}', 'p2', 1),
      oai.toolCall('wait', '{"ms":200}', 'p3', 2),
      oai.stop('tool_calls'),
    ];
  }
  return [oai.text('调用 read_page'), oai.toolCall('read_page', '{}', 's1'), oai.stop('tool_calls')];
});

const browser = await launchWithExtension();
const sw = await browser.serviceWorker();
await sw.evalJs(configScript(mock.url));

const pageTab = await browser.newTab(site.url);
await sleep(2000);
let panel = await browser.openPanel();

const ask = async (text) => {
  await browser.activate(pageTab.id);
  await sleep(300);
  mock.reset();
  await askAndWait(panel, text, { timeout: 50000 });
};
const openDrawer = async (p) => {
  await p.evalJs(`document.getElementById('history').click()`);
  await sleep(1100);
  return p.json(`{
    items: [...document.querySelectorAll('#convList .conv-title')].map(e=>e.textContent),
    emptyText: document.querySelector('.conv-empty')?.textContent || '' }`);
};

// ── 1. 一轮内并行工具调用 ────────────────────────────────────────
s.section('并行工具调用');
mode = 'parallel';
await ask('并行做三件事');
{
  const u = await panelState(panel);
  s.t('三个工具全部执行', u.tools.length === 3, JSON.stringify(u.tools));
  s.t('三个都成功', u.tools.filter((x) => x.includes('✓')).length === 3, JSON.stringify(u.tools));
  s.t('无错误', u.errors.length === 0, JSON.stringify(u.errors));

  const last = mock.reqs[mock.reqs.length - 1];
  const toolMsgs = last.messages.filter((m) => m.role === 'tool');
  const asst = last.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  s.t('三个结果都回填了', toolMsgs.length === 3, String(toolMsgs.length));
  s.t('tool_call_id 全部一一配对',
    JSON.stringify(asst.tool_calls.map((c) => c.id).sort()) ===
      JSON.stringify(toolMsgs.map((m) => m.tool_call_id).sort()));
  s.t('结果紧跟在 assistant 消息之后',
    last.messages.indexOf(asst) + 1 === last.messages.indexOf(toolMsgs[0]));
}

// ── 2. Service Worker 被回收 ─────────────────────────────────────
s.section('Service Worker 回收后恢复');
mode = 'single';
await panel.evalJs(`document.getElementById('reset').click()`);
await sleep(700);
await ask('第一次');
s.t('回收前正常工作', (await panelState(panel)).tools.some((x) => x.includes('✓')));

const before = (await browser.targets()).find((x) => x.url.endsWith('/background.js'));
await browser.browser.send('Target.closeTarget', { targetId: before.id }).catch(() => {});
await sleep(3000);
const after = (await browser.targets()).find((x) => x.url.endsWith('/background.js'));
s.t('Service Worker 已被终止', !after || after.id !== before.id,
  `${before?.id?.slice(0, 8)} -> ${after?.id?.slice(0, 8)}`);

await ask('回收之后再问一次');
{
  const u = await panelState(panel);
  s.t('回收后侧边栏自动重连并继续工作',
    u.tools.some((x) => x.includes('✓')) && u.assistant.includes('完成'), JSON.stringify(u.tools));
  s.t('回收后无错误气泡', u.errors.length === 0, JSON.stringify(u.errors));

  const texts = mock.reqs[mock.reqs.length - 1].messages
    .filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content);
  s.t('SW 重启后对话历史仍然保留',
    texts.includes('第一次') && texts.includes('回收之后再问一次'), JSON.stringify(texts));
  s.t('恢复历史时明确告知用户（不静默）',
    u.infos.some((x) => x.includes('已恢复')), JSON.stringify(u.infos));
}

// ── 3. 关掉面板重新打开 ──────────────────────────────────────────
s.section('关掉面板重新打开');
{
  const d1 = await openDrawer(panel);
  s.t('聊完不点新对话，历史里就已经有了', d1.items.length >= 1, JSON.stringify(d1));

  await browser.closeTab(panel.tabId);
  panel.close();
  await sleep(1200);
  panel = await browser.openPanel();
  const d2 = await openDrawer(panel);
  s.t('重开面板后历史还在', d2.items.length >= 1, JSON.stringify(d2));

  // 再杀一次 SW，验证历史存的是 storage.local 而不是进程内存
  await browser.closeTab(panel.tabId);
  panel.close();
  await sleep(600);
  const cur = (await browser.targets()).find((x) => x.url.endsWith('/background.js'));
  if (cur) await browser.browser.send('Target.closeTarget', { targetId: cur.id }).catch(() => {});
  await sleep(2500);
  panel = await browser.openPanel();
  const d3 = await openDrawer(panel);
  s.t('SW 回收后历史仍在', d3.items.length >= 1, JSON.stringify(d3));
}

browser.stop();
await mock.close();
await site.close();
s.done();
