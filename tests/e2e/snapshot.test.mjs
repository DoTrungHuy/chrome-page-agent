// 页面快照算法：可见性过滤、可访问名、行内合并、截断，以及按 ref 操作。
// 走真实扩展的注入路径（chrome.scripting + content script 消息往返），
// 测的就是出货代码，不是另做一份探针。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { suite } from '../helpers/assert.mjs';
import { launchWithExtension, Sess } from '../helpers/cdp.mjs';
import { startSite } from '../helpers/mock.mjs';
import { REPO, sleep } from '../helpers/env.mjs';

const s = suite('snapshot');

const site = await startSite(readFileSync(join(REPO, 'tests', 'fixtures', 'stress-page.html'), 'utf8'));
const browser = await launchWithExtension();
const sw = await browser.serviceWorker();

const tab = await browser.newTab(site.url);
await sleep(2500);
await browser.activate(tab.id);
await sleep(400);

/** 通过 Service Worker 走真实派发：注入 content script，再发一条工具消息。 */
async function tool(type, extra = {}) {
  const res = await sw.evalJs(`(async () => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find(x => x.url && x.url.includes(${JSON.stringify(`127.0.0.1:${site.port}`)}));
    if (!t) return JSON.stringify({ ok:false, error:'找不到测试页' });
    await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] });
    const r = await chrome.tabs.sendMessage(t.id, ${JSON.stringify({ type, ...extra })});
    return JSON.stringify(r);
  })()`);
  return JSON.parse(res);
}
// 直接连页面 target 求值。不能从 Service Worker 里 new Function ——
// MV3 的 CSP 禁 eval（这一点本身是对的，扩展就该这样）。
const page = await Sess.open((await browser.targets()).find((x) => x.id === tab.id).webSocketDebuggerUrl);
const pageEval = (expr) => page.json(`(${expr})`);

const t0 = Date.now();
const snapRes = await tool('read_page');
const elapsed = Date.now() - t0;
if (!snapRes.ok) { s.t('read_page 成功', false, snapRes.error); s.done(); }
const snap = snapRes.data;
const refOf = (re) => { const m = snap.match(re); return m ? Number(m[1]) : null; };

// ── 可见性过滤 ───────────────────────────────────────────────────
s.section('可见性过滤');
for (const bad of ['NEVERdisplaynone', 'NEVERtext1', 'NEVERvisibilityhidden',
                   'NEVERopacity0', 'NEVERclipped', 'NEVERhiddeninput']) {
  s.t(`过滤不可见：${bad}`, !snap.includes(bad));
}
s.t('祖先 overflow:hidden 且零尺寸 → 子元素被过滤', !snap.includes('NEVERclipped'));
s.t('回归：塌陷容器(overflow:visible)的子元素未被误伤', snap.includes('MUSTAPPEARcollapsed'));

// ── 可访问名 ─────────────────────────────────────────────────────
s.section('可访问名');
s.t('aria-label 命名', snap.includes('"来自arialabel"'));
s.t('aria-labelledby 命名', snap.includes('"来自arialabelledby"'));
s.t('title 兜底命名', snap.includes('"来自title"'));
s.t('img alt 兜底命名', snap.includes('"来自imgalt"'));
s.t('label 关联输入框命名', snap.includes('"带label的输入框"'));
s.t('placeholder 命名', snap.includes('"仅有placeholder"'));
s.t('输入框显示 value', snap.includes('value="预填值"'));
s.t('checkbox 已选中状态', /checkbox[^\n]*\[已选中\]/.test(snap));
s.t('checkbox 未选中状态', /checkbox[^\n]*\[未选中\]/.test(snap));
s.t('checkbox 不输出无意义的 value="on"', !snap.includes('checkbox "已勾选项" value="on"'));
s.t('select 显示当前选中项', /select[^\n]*value="选项甲"/.test(snap));
s.t('disabled 标记', snap.includes('[不可用]'));
s.t('aria-expanded 标记', snap.includes('[展开=false]'));
s.t('label 文本不与控件名重复',
  (snap.match(/text "带label的输入框"/g) || []).length === 0);

// ── 结构 ─────────────────────────────────────────────────────────
s.section('结构');
s.t('heading 层级正确',
  snap.includes('heading1 "快照压测页"') && snap.includes('heading2 "命名来源"'));
s.t('外层链接有 ref', /\[ref=\d+\] link "外层链接文字/.test(snap));
s.t('内层按钮也有 ref', snap.includes('"内层按钮"'));
s.t('深层嵌套的链接仍被捕获', snap.includes('"深处的链接"'));
s.t('shadow DOM 按钮被捕获', snap.includes('"Shadow按钮"'));
s.t('shadow DOM 文本被捕获', snap.includes('shadow里的文字'));
s.t('display:contents 容器的子文本不被剪掉', snap.includes('CONTENTSCHILDMUSTAPPEAR'));
s.t('display:contents 容器里的按钮仍被编号', snap.includes('"contents里的按钮"'));

s.section('行内混排');
s.t('句子不被行内元素撕碎',
  snap.includes('The fetchfn method of the WindowIface interface starts a request.'),
  (snap.match(/.*method of the.*/) || [''])[0]);
s.t('句中的链接仍然拿到 ref', /\[ref=\d+\] link "WindowIface"/.test(snap));
s.t('行内 <code> 不再单独成行', !snap.includes('text "fetchfn"'));
s.t('混合容器只输出自己的散落文本', snap.includes('text "散落文本"'));
s.t('混合容器的块级后代单独成行', snap.includes('text "块级后代文字ALPHA"'));

s.section('规模与性能');
s.t('大列表触发截断', snap.includes('快照已截断'));
s.t('快照长度受控 (<27000)', snap.length < 27000, `len=${snap.length}`);
s.t('整体耗时可接受 (<3s，含注入)', elapsed < 3000, `${elapsed}ms`);

// ── 按 ref 操作 ──────────────────────────────────────────────────
s.section('按 ref 操作');
{
  const innerRef = refOf(/\[ref=(\d+)\] button "内层按钮"/);
  await pageEval('window.__clicks = []');
  const r = await tool('click', { ref: innerRef });
  s.t('click 真的触发了点击',
    (await pageEval('window.__clicks')).includes('inner-btn'), JSON.stringify(await pageEval('window.__clicks')));
  s.t('click 返回值提示重新 read_page', String(r.data).includes('read_page'), String(r.data));
}
{
  const ref = refOf(/\[ref=(\d+)\] textbox "受控输入框"/);
  await tool('type_text', { ref, text: '机械键盘' });
  const d = await pageEval(`({ v: document.getElementById('controlled').value, log: document.getElementById('clog').textContent })`);
  s.t('typeText 写入了 DOM value', d.v === '机械键盘', `value=${d.v}`);
  s.t('typeText 触发了 input 事件（框架能收到）', d.log.startsWith('input:机械键盘'), d.log);
  s.t('typeText 触发了 change 事件', d.log.includes('|change'), d.log);
}
{
  const ref = refOf(/\[ref=(\d+)\] select/);
  await tool('type_text', { ref, text: '选项乙' });
  s.t('select 按选项文本选中',
    (await pageEval(`document.getElementById('sel1').value`)) === 'b');
  const bad = await tool('type_text', { ref, text: '不存在的选项' });
  s.t('select 选项不存在时报错并列出可选项',
    !bad.ok && /没有.*这个选项/.test(bad.error), JSON.stringify(bad));
}
{
  const gone = await tool('click', { ref: 999999 });
  s.t('不存在的 ref 报错引导重新 read_page',
    !gone.ok && gone.error.includes('read_page'), JSON.stringify(gone));

  const disRef = refOf(/\[ref=(\d+)\] button "禁用按钮"/);
  await pageEval(`(document.getElementById('dis1').remove(), 1)`);
  const removed = await tool('click', { ref: disRef });
  s.t('元素已移除时报错引导重新 read_page',
    !removed.ok && removed.error.includes('read_page'), JSON.stringify(removed));
}
{
  const before = await pageEval('window.scrollY');
  const r = await tool('scroll', { direction: 'bottom' });
  s.t('scroll 真的滚动了', (await pageEval('window.scrollY')) > before,
    `${before} -> ${await pageEval('window.scrollY')}`);
  s.t('scroll 返回当前滚动位置', String(r.data).includes('滚动位置'), String(r.data));
}

browser.stop();
await site.close();
s.done();
