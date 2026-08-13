// 端到端主链路：设置页、侧边栏 UI、各工具真实派发、步数上限、中断、
// 特权页面、配置缺失、Anthropic 适配器。

import { suite } from '../helpers/assert.mjs';
import { launchWithExtension, askAndWait, panelState, Sess } from '../helpers/cdp.mjs';
import { startMock, startSite, oai, ant, configScript } from '../helpers/mock.mjs';
import { sleep } from '../helpers/env.mjs';

const s = suite('core');

const site = await startSite(
  '<!doctype html><meta charset=utf-8><title>示例页</title><h1>示例页</h1>' +
  '<p>这里是正文内容，用于测试读取。</p><a href="/other">站内链接</a>' +
  '<button id="b">普通按钮</button>'
);

let scenario = 'read';
const mock = await startMock(({ turn, anthropic }) => {
  const call = (name, args = '{}') =>
    anthropic
      ? [ant.text(`调用 ${name}`), ant.toolCall(name, args, 't' + turn), ant.stop('tool_use')]
      : [oai.text(`调用 ${name}`), oai.toolCall(name, args, 'c' + turn), oai.stop('tool_calls')];
  const done = (txt = '完成。') =>
    anthropic ? [ant.text(txt), ant.stop()] : [oai.text(txt), oai.stop()];

  if (scenario === 'slow') return sleep(20000).then(() => done('慢完了。'));
  if (scenario === 'loop') return call('scroll', '{"direction":"down"}');
  if (scenario === 'click') return turn === 1 ? call('read_page') : turn === 2 ? call('click', '{"ref":1}') : done('点完了。');
  if (scenario === 'scroll') return turn === 1 ? call('scroll', '{"direction":"bottom"}') : done('滚完了。');
  if (scenario === 'wait') return turn === 1 ? call('wait', '{"ms":200}') : done('等完了。');
  if (scenario === 'navigate') return turn === 1 ? call('navigate', `{"url":"${site.url}"}`) : done('跳完了。');
  if (scenario === 'badref') return turn === 1 ? call('click', '{"ref":99999}') : done('收到错误了。');
  return turn === 1 ? call('read_page') : done('读完了。');
});
const setScenario = (v) => { scenario = v; mock.reset(); };

const browser = await launchWithExtension();
const sw = await browser.serviceWorker();
const swErrors = await sw.watchExceptions();
// 刻意**不**预置配置：下面的设置页那节要从零开始，完全通过 UI 配出来，
// 这样才算真的验证了设置页。预置了的话"从预设添加一张卡"会变成两张。

const pageTab = await browser.newTab(site.url);
await sleep(2000);

// ── 1. hidden 元素真的不可见 ─────────────────────────────────────
s.section('基础渲染');
{
  const p0 = await browser.openPanel();
  const vis = await p0.json(`{
    stop: getComputedStyle(document.getElementById('stop')).display,
    ctx: getComputedStyle(document.getElementById('context')).display,
    step: getComputedStyle(document.getElementById('step')).display }`);
  // 作者样式里的显式 display 会盖过 UA 的 [hidden]{display:none}，
  // 只断言 .hidden 属性抓不到这个 bug
  s.t('初始状态下 hidden 元素计算样式确实为 none',
    vis.stop === 'none' && vis.ctx === 'none' && vis.step === 'none', JSON.stringify(vis));
  await browser.closeTab(p0.tabId);
  p0.close();
  await sleep(300);
}

// ── 2. 设置页：账号 → 模型 ───────────────────────────────────────
s.section('设置页');
const opt = await browser.openOptions();
{
  s.t('预设下拉已填充', (await opt.evalJs(`document.getElementById('presetPick').options.length`)) > 5);

  await opt.evalJs(`(() => { const el = document.getElementById('presetPick');
    el.value = '2'; el.dispatchEvent(new Event('change')); return 1; })()`);
  const after = await opt.json(`{
    cards: document.querySelectorAll('#accounts .card').length,
    baseUrl: document.querySelectorAll('#accounts .card input')[1]?.value || '',
    chips: [...document.querySelectorAll('#accounts .chip')].map(c => c.textContent.replace('×','')) }`);
  s.t('从预设添加出一张账号卡', after.cards === 1, JSON.stringify(after));
  s.t('预设填好 baseUrl 且带默认模型',
    after.baseUrl.includes('deepseek') && after.chips.length === 1, JSON.stringify(after));

  // 关键：同一账号下加第二个模型，不该新增一张卡（不用重填地址密钥）
  await opt.evalJs(`(() => { const i = document.querySelector('#accounts .chip-add input');
    i.value = 'second-model';
    i.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true })); return 1; })()`);
  await sleep(300);
  const two = await opt.json(`{
    cards: document.querySelectorAll('#accounts .card').length,
    chips: document.querySelectorAll('#accounts .chip').length }`);
  s.t('加第二个模型不会新增账号卡', two.cards === 1, JSON.stringify(two));
  s.t('两个模型挂在同一个账号下', two.chips === 2, JSON.stringify(two));

  await opt.evalJs(`(() => {
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input')); };
    const card = document.querySelector('#accounts .card');
    const texts = card.querySelectorAll('input[type=text]');
    set(texts[0], 'E2E 账号');
    set(texts[1], ${JSON.stringify(mock.url)});
    set(card.querySelector('input[type=password]'), 'sk-e2e');
    const sel = card.querySelector('select'); sel.value = 'openai'; sel.dispatchEvent(new Event('change'));
    card.querySelectorAll('.chip')[0].firstChild.click();
    document.getElementById('maxTokens').value = '4096';
    document.getElementById('maxSteps').value = '4';
    document.getElementById('temperature').value = '';
    document.getElementById('save').click(); return 1; })()`);
  await sleep(1000);

  const saved = await sw.evalJs(
    `chrome.storage.local.get(['provider','baseUrl','apiKey','model','maxSteps','temperature','accounts','activeAccount'])`);
  s.t('生效配置写成扁平字段（SW 只认这几个）',
    saved.apiKey === 'sk-e2e' && saved.baseUrl === mock.url && saved.maxSteps === 4,
    JSON.stringify({ k: saved.apiKey, u: saved.baseUrl, n: saved.maxSteps }));
  s.t('账号结构存下来了，两个模型在同一账号里',
    saved.accounts?.length === 1 && saved.accounts[0].models.length === 2,
    JSON.stringify(saved.accounts?.[0]?.models));
  s.t('temperature 留空存为 null（不发送）', saved.temperature === null);

  // 后面的用例用固定模型名和自动模式，直接写生效字段
  await sw.evalJs(`chrome.storage.local.set({ model: 'mock-model', mode: 'auto' })`);
  await sleep(300);
}

const panel = await browser.openPanel();
const panelErrors = await panel.watchExceptions();
await browser.activate(pageTab.id);
await sleep(400);

const ask = async (text) => {
  await browser.activate(pageTab.id);
  await sleep(300);
  await askAndWait(panel, text);
};
const reset = async () => {
  for (let i = 0; i < 40; i++) {
    if (await panel.evalJs(`document.getElementById('stop').hidden`)) break;
    await sleep(300);
  }
  await panel.evalJs(`document.getElementById('reset').click()`);
  await sleep(600);
};

// ── 3. 侧边栏 UI ─────────────────────────────────────────────────
s.section('侧边栏 UI');
setScenario('read');
await ask('这个页面在讲什么？');
{
  const u = await panelState(panel);
  s.t('用户消息气泡已渲染', u.users.length === 1);
  s.t('助手流式文本已渲染',
    u.assistant.includes('调用 read_page') && u.assistant.includes('读完了'), u.assistant);
  s.t('工具卡已渲染并标记成功',
    u.tools.length === 1 && u.tools[0].includes('read_page') && u.tools[0].includes('✓'), JSON.stringify(u.tools));
  s.t('上下文条显示当前页面', u.context.includes(String(site.port)), u.context);
  s.t('结束后恢复可输入', !u.busy);
  s.t('无错误气泡', u.errors.length === 0, JSON.stringify(u.errors));
}

setScenario('read');
await ask('再看一次');
{
  const hist = mock.reqs[mock.reqs.length - 1].messages
    .filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content);
  s.t('多轮对话历史正确累积',
    hist.includes('这个页面在讲什么？') && hist.includes('再看一次'), JSON.stringify(hist));
}
await panel.evalJs(`document.getElementById('reset').click()`);
await sleep(600);
s.t('新对话清空了界面', (await panel.evalJs(`document.querySelectorAll('.msg').length`)) === 0);

// ── 4. 工具真实派发 ──────────────────────────────────────────────
s.section('工具真实派发');
s.t('默认模式是自动', (await panel.evalJs(`document.getElementById('modeSel').value`)) === 'auto');
// 这里测的是派发链路本身；门禁由 modes 套件专门覆盖
await panel.evalJs(`(() => { const el = document.getElementById('modeSel');
  el.value = 'always'; el.dispatchEvent(new Event('change')); return 1; })()`);
await sleep(400);

for (const [name, label] of [['click', 'click'], ['scroll', 'scroll'], ['wait', 'wait'], ['navigate', 'navigate']]) {
  setScenario(name);
  await ask(`执行 ${name}`);
  const u = await panelState(panel);
  s.t(`${label} 经消息往返执行成功`,
    u.tools.some((x) => x.includes(label) && x.includes('✓')), JSON.stringify(u.tools));
  if (name === 'navigate') {
    const fed = mock.reqs.flatMap((r) => (r.messages || []).filter((m) => m.role === 'tool').map((m) => m.content)).join('');
    s.t('navigate 返回值提示 ref 已失效', fed.includes('read_page'), fed.slice(0, 140));
  }
  await reset();
}

setScenario('badref');
await ask('点一个不存在的元素');
{
  const u = await panelState(panel);
  s.t('无效 ref 标记为失败但循环继续',
    u.tools.some((x) => x.includes('click') && x.includes('✗')), JSON.stringify(u.tools));
  const fed = mock.reqs.flatMap((r) => (r.messages || []).filter((m) => m.role === 'tool').map((m) => m.content)).join('');
  s.t('工具错误回填给模型并引导重读', fed.includes('read_page'), fed.slice(0, 160));
}
await reset();

// ── 5. 步数上限 ──────────────────────────────────────────────────
s.section('步数上限');
setScenario('loop');
await ask('停不下来');
{
  const u = await panelState(panel);
  s.t('达到 maxSteps 后自动停止', u.infos.some((x) => x.includes('上限')), JSON.stringify(u.infos));
  s.t('步数恰好等于配置的 4 步', u.tools.length === 4, String(u.tools.length));
}
await reset();

// ── 6. 中断 ──────────────────────────────────────────────────────
s.section('中断');
setScenario('slow');
await browser.activate(pageTab.id);
await sleep(300);
await panel.evalJs(`(() => { document.getElementById('input').value='慢请求';
  document.getElementById('composer').requestSubmit(); return 1; })()`);
await sleep(2000);
s.t('运行中停止按钮可见', !(await panel.evalJs(`document.getElementById('stop').hidden`)));
await panel.evalJs(`document.getElementById('stop').click()`);
await sleep(2500);
{
  const u = await panelState(panel);
  s.t('点停止后中断并恢复输入', !u.busy);
  s.t('中断显示为提示而非报错',
    u.infos.some((x) => x.includes('中断')) || u.errors.length === 0, JSON.stringify(u));
}
await reset();

// ── 7. 浏览器内部页面 ────────────────────────────────────────────
s.section('浏览器内部页面');
{
  const chromeTab = await browser.newTab('chrome://version');
  await sleep(1800);
  await browser.activate(chromeTab.id);
  await sleep(400);
  setScenario('read');
  await askAndWait(panel, '随便问点什么');
  const u = await panelState(panel);
  // 行为已变更：以前直接报错拒绝，现在照常对话、只是不给页面工具
  s.t('chrome:// 页面上不再报错', u.errors.length === 0, JSON.stringify(u.errors));
  s.t('上下文条说明当前读不了页面', u.context.includes('无可读页面'), u.context);
  const fed = mock.reqs.flatMap((r) => (r.messages || []).filter((m) => m.role === 'tool').map((m) => m.content)).join('');
  s.t('模型硬报页面工具时理由是"页面读不了"而非"模式受限"',
    !fed.includes('受限模式'), fed.slice(0, 160));
  await browser.closeTab(chromeTab.id);
  await reset();
}

// ── 8. 配置缺失 ──────────────────────────────────────────────────
s.section('配置缺失');
{
  await browser.activate(pageTab.id);
  await sleep(300);
  await sw.evalJs(`chrome.storage.local.set({ apiKey: '' })`);
  await askAndWait(panel, '测试');
  const u = await panelState(panel);
  s.t('缺 API Key 给出可操作的提示',
    u.errors.some((x) => x.includes('API Key')), JSON.stringify(u.errors));
  await reset();
}

// ── 9. Anthropic 适配器 ──────────────────────────────────────────
s.section('Anthropic 适配器');
{
  await sw.evalJs(`chrome.storage.local.set({ provider:'anthropic', apiKey:'sk-ant',
    baseUrl:${JSON.stringify(mock.url)}, model:'claude-opus-5', maxSteps:4 })`);
  setScenario('read');
  await browser.activate(pageTab.id);
  await sleep(300);
  await askAndWait(panel, '用 Anthropic 读页面');
  const u = await panelState(panel);
  s.t('Anthropic 格式端到端跑通', u.assistant.includes('读完了'), u.assistant);
  s.t('Anthropic 工具调用成功',
    u.tools.some((x) => x.includes('read_page') && x.includes('✓')), JSON.stringify(u.tools));
  s.t('Anthropic 无错误', u.errors.length === 0, JSON.stringify(u.errors));

  const last = mock.reqs[mock.reqs.length - 1];
  const asst = last.messages.find((m) => m.role === 'assistant');
  const tail = last.messages[last.messages.length - 1];
  const useIds = (asst?.content || []).filter((b) => b.type === 'tool_use').map((b) => b.id);
  const resIds = (tail?.content || []).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
  s.t('tool_result 与 tool_use 配对正确',
    useIds.length === 1 && JSON.stringify(useIds) === JSON.stringify(resIds),
    JSON.stringify({ useIds, resIds }));
}

s.t('Service Worker 无未捕获异常', swErrors.length === 0, swErrors.slice(0, 2).join(' | '));
s.t('侧边栏无未捕获异常', panelErrors.length === 0, panelErrors.slice(0, 2).join(' | '));

browser.stop();
await mock.close();
await site.close();
s.done();
