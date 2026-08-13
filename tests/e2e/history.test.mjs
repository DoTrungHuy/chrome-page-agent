// 历史对话：自动存档、列表、恢复、删除。
// 最要紧的一条是「页面快照不落盘」—— 对话里最大的一块是用户浏览过的正文。

import { suite } from '../helpers/assert.mjs';
import { launchWithExtension, askAndWait } from '../helpers/cdp.mjs';
import { startMock, startSite, oai, configScript } from '../helpers/mock.mjs';
import { sleep } from '../helpers/env.mjs';

const s = suite('history');

const site = await startSite(
  '<!doctype html><meta charset=utf-8><title>Example Domain</title>' +
  '<h1>Example Domain</h1><p>这是用于测试的正文内容。</p>'
);

const mock = await startMock(({ turn }) =>
  turn % 2 === 1
    ? [oai.text('我先读一下页面。'), oai.toolCall('read_page', '{}', 'c' + turn), oai.stop('tool_calls')]
    : [oai.text('这是一个示例页面。'), oai.stop()]
);

const browser = await launchWithExtension();
const sw = await browser.serviceWorker();
await sw.evalJs(configScript(mock.url));

const pageTab = await browser.newTab(site.url);
await sleep(2000);
const panel = await browser.openPanel();

const ask = async (text) => {
  await browser.activate(pageTab.id);
  await sleep(300);
  mock.reset();
  await askAndWait(panel, text);
};
const openDrawer = async () => {
  await panel.evalJs(`document.getElementById('history').click()`);
  await sleep(900);
  return panel.json(`{
    open: !document.getElementById('drawer').hidden,
    items: [...document.querySelectorAll('#convList .conv')].map(c => ({
      title: c.querySelector('.conv-title').textContent,
      meta: c.querySelector('.conv-meta').textContent,
      current: c.classList.contains('current') })),
    emptyText: document.querySelector('.conv-empty')?.textContent || '' }`);
};

// ── 0. 前后端握手 ────────────────────────────────────────────────
s.section('前后端握手');
await sleep(3200);   // 超过前端 2.5s 的超时窗口
{
  const errs = await panel.json(`[...document.querySelectorAll('.msg.error')].map(e=>e.textContent)`);
  s.t('后端特性齐全，没有"旧代码"告警', !errs.some((x) => x.includes('旧版本')), JSON.stringify(errs));
}

// ── 1. 自动存档 ──────────────────────────────────────────────────
s.section('自动存档');
await ask('第一个问题');
s.t('对话跑通', (await panel.evalJs(`document.querySelectorAll('.msg.user').length`)) === 1);
const idx1 = await sw.evalJs(`chrome.storage.local.get('convIndex')`);
s.t('会话结束即写入索引', (idx1.convIndex || []).length === 1, JSON.stringify(idx1.convIndex));
s.t('标题取自第一句话', idx1.convIndex?.[0]?.title === '第一个问题', idx1.convIndex?.[0]?.title);
s.t('记下了起始页域名', idx1.convIndex?.[0]?.origin === `127.0.0.1:${site.port}`, idx1.convIndex?.[0]?.origin);

// ── 2. 页面快照不落盘（核心）─────────────────────────────────────
s.section('页面快照不落盘');
{
  const cid = idx1.convIndex[0].id;
  const conv = (await sw.evalJs(`chrome.storage.local.get('conv:${cid}')`))[`conv:${cid}`];
  const wire = JSON.stringify(conv.wire);
  s.t('存了 wire 和 view 两份', !!conv.wire && !!conv.view);
  s.t('落盘内容里没有页面正文',
    !wire.includes('Example Domain') && !wire.includes('[ref='), wire.slice(0, 200));
  s.t('工具结果被替换成占位（保留配对关系）', wire.includes('页面快照已省略'), wire.slice(0, 200));
  const toolMsgs = conv.wire.filter((m) => m.role === 'tool');
  const calls = conv.wire.filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls);
  s.t('tool_call 与 tool_result 仍然一一配对',
    toolMsgs.length === calls.length && toolMsgs.length > 0, `calls=${calls.length} results=${toolMsgs.length}`);
  s.t('展示流水里有用户/助手/工具三种条目',
    new Set(conv.view.map((v) => v.role)).size === 3, JSON.stringify(conv.view.map((v) => v.role)));
  s.t('展示流水的工具预览也不含正文', !JSON.stringify(conv.view).includes('[ref='));
}

// ── 3. 新对话与列表 ──────────────────────────────────────────────
s.section('新对话与列表');
await panel.evalJs(`document.getElementById('reset').click()`);
await sleep(800);
s.t('新对话清空了界面', (await panel.evalJs(`document.querySelectorAll('.msg').length`)) === 0);

await ask('第二个问题');
let d = await openDrawer();
s.t('抽屉打开', d.open);
s.t('没有卡在「正在读取历史」',
  !JSON.stringify(d).includes('正在读取历史') && !JSON.stringify(d).includes('没有响应'), JSON.stringify(d));
s.t('列出两条对话', d.items.length === 2, JSON.stringify(d.items.map((i) => i.title)));
s.t('最新的排在最前', d.items[0].title === '第二个问题', d.items[0].title);
s.t('当前对话有标记', d.items[0].current);
s.t('副标题显示域名和时间', d.items[0].meta.includes('127.0.0.1'), d.items[0].meta);

// ── 4. 恢复历史 ──────────────────────────────────────────────────
s.section('恢复历史对话');
await panel.evalJs(`[...document.querySelectorAll('#convList .conv')][1].querySelector('.conv-body').click()`);
await sleep(1200);
{
  const r = await panel.json(`{
    drawerClosed: document.getElementById('drawer').hidden,
    users: [...document.querySelectorAll('.msg.user')].map(e=>e.textContent),
    asst: [...document.querySelectorAll('.msg.assistant')].map(e=>e.textContent).join('|'),
    tools: [...document.querySelectorAll('.tool')].map(e=>e.textContent.trim()) }`);
  s.t('恢复后抽屉自动关闭', r.drawerClosed);
  s.t('用户消息画回来了', r.users.join(',') === '第一个问题', JSON.stringify(r.users));
  s.t('助手回复画回来了', r.asst.includes('这是一个示例页面'), r.asst);
  s.t('工具卡也画回来了（带成功标记）',
    r.tools.some((x) => x.includes('read_page') && x.includes('✓')), JSON.stringify(r.tools));
}

await ask('接着上面继续');
{
  const last = mock.reqs[mock.reqs.length - 1];
  const texts = last.messages.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content);
  s.t('恢复后继续对话，旧上下文仍在',
    texts.includes('第一个问题') && texts.includes('接着上面继续'), JSON.stringify(texts));
  s.t('发给模型的历史里工具结果是占位而非正文',
    !JSON.stringify(last.messages).includes('Example Domain') ||
      JSON.stringify(last.messages).includes('页面快照已省略'));
}

// ── 5. 删除 ──────────────────────────────────────────────────────
s.section('删除对话');
d = await openDrawer();
const before = d.items.length;
await panel.evalJs(`[...document.querySelectorAll('#convList .conv')][1].querySelector('.conv-del').click()`);
await sleep(1200);
{
  const after = await panel.evalJs(`document.querySelectorAll('#convList .conv').length`);
  s.t('列表里少了一条', after === before - 1, `${before} -> ${after}`);
  const keys = await panel.evalJs(
    `chrome.storage.local.get(null).then(o => Object.keys(o).filter(k => k.startsWith('conv:')).length)`);
  s.t('对应的正文也从磁盘删掉了（没留孤儿）', keys === after, `${keys} 份正文 / ${after} 条索引`);
}

browser.stop();
await mock.close();
await site.close();
s.done();
