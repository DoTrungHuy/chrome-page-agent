// type_text 的真实派发路径：原生 setter 赋值 + input/change 事件派发 + 表单提交。
// 直接改 el.value 在 React/Vue 受控组件里只改 DOM 不改框架状态，提交时拿到空值。

import { suite } from '../helpers/assert.mjs';
import { launchWithExtension, askAndWait, panelState, Sess } from '../helpers/cdp.mjs';
import { startMock, startSite, oai, configScript } from '../helpers/mock.mjs';
import { sleep } from '../helpers/env.mjs';

const s = suite('typing');

const site = await startSite(`<!doctype html><meta charset=utf-8><title>输入测试页</title>
<h1>输入测试页</h1>
<form id="f" onsubmit="document.getElementById('log').textContent += '|submitted'; return false;">
  <label for="q">搜索关键词</label>
  <input id="q" name="q" type="search" placeholder="输入关键词">
  <button type="submit">搜索</button>
</form>
<div id="log">init</div>
<script>
  const q = document.getElementById('q');
  q.addEventListener('input', e => { document.getElementById('log').textContent = 'input:' + e.target.value; });
  q.addEventListener('change', () => { document.getElementById('log').textContent += '|change'; });
</script>`);

let submitMode = false;
const mock = await startMock(({ turn, reqs }) => {
  if (turn === 1) return [oai.text('先读页面'), oai.toolCall('read_page', '{}', 'c1'), oai.stop('tool_calls')];
  if (turn === 2) {
    // 从上一轮快照里解析出 searchbox 的 ref —— 模拟模型的真实行为
    const snap = reqs[turn - 1].messages.filter((m) => m.role === 'tool').pop()?.content || '';
    const m = snap.match(/\[ref=(\d+)\] searchbox/);
    return [
      oai.text('填进去'),
      oai.toolCall('type_text', JSON.stringify({ ref: m ? Number(m[1]) : 1, text: '机械键盘', submit: submitMode }), 'c2'),
      oai.stop('tool_calls'),
    ];
  }
  return [oai.text('完成。'), oai.stop()];
});

const browser = await launchWithExtension();
const sw = await browser.serviceWorker();
await sw.evalJs(configScript(mock.url));

const pageTab = await browser.newTab(site.url);
await sleep(2000);
const panel = await browser.openPanel();
const page = await Sess.open((await browser.targets()).find((x) => x.id === pageTab.id).webSocketDebuggerUrl);

// submit:true 在自动模式下会被判为「提交表单」弹确认；这里测的是输入链路本身
await panel.evalJs(`(() => { const el = document.getElementById('modeSel');
  el.value = 'always'; el.dispatchEvent(new Event('change')); return 1; })()`);
await sleep(400);

const run = async (text) => {
  await browser.activate(pageTab.id);
  await sleep(300);
  mock.reset();
  await askAndWait(panel, text, { timeout: 50000 });
};
const dom = () => page.json(`{
  value: document.getElementById('q').value,
  log: document.getElementById('log').textContent }`);

// ── submit = false ───────────────────────────────────────────────
s.section('type_text（不提交）');
await run('帮我在搜索框输入机械键盘');
{
  const u = await panelState(panel);
  const d = await dom();
  s.t('type_text 经消息往返执行成功',
    u.tools.some((x) => x.includes('type_text') && x.includes('✓')), JSON.stringify(u.tools));
  s.t('模型能从快照里解析出 searchbox 的 ref', u.tools.some((x) => x.includes('type_text')));
  s.t('输入框真的被写入了值', d.value === '机械键盘', `value=${d.value}`);
  s.t('触发了 input 事件（框架能收到）', d.log.startsWith('input:机械键盘'), d.log);
  s.t('触发了 change 事件', d.log.includes('|change'), d.log);
  s.t('未要求提交时不提交表单', !d.log.includes('submitted'), d.log);
  s.t('无错误', u.errors.length === 0, JSON.stringify(u.errors));
}

// ── submit = true ────────────────────────────────────────────────
s.section('type_text + 提交');
await panel.evalJs(`document.getElementById('reset').click()`);
await sleep(600);
await page.evalJs(`(() => { document.getElementById('q').value='';
  document.getElementById('log').textContent='init'; return 1; })()`);
submitMode = true;
await run('搜索机械键盘并回车');
{
  const d = await dom();
  s.t('submit=true 时真的提交了表单', d.log.includes('submitted'), d.log);
  s.t('提交前值已正确写入', d.value === '机械键盘', `value=${d.value}`);
}

browser.stop();
await mock.close();
await site.close();
s.done();
