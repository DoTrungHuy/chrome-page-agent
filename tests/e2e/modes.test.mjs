// 三种模式是真的权限门禁，不是提示词里的君子协定：
// Plan 只读、Auto 危险操作弹确认、Always 不问。外加模型配置切换器。

import { suite } from '../helpers/assert.mjs';
import { launchWithExtension, askAndWait, panelState } from '../helpers/cdp.mjs';
import { startMock, startSite, oai } from '../helpers/mock.mjs';
import { sleep } from '../helpers/env.mjs';

const s = suite('modes');

const site = await startSite(
  '<!doctype html><meta charset=utf-8><title>模式测试页</title><h1>模式测试页</h1>' +
  '<button id="safe">查看详情</button><button id="danger">立即购买</button>' +
  '<div id="log">none</div><script>' +
  "document.getElementById('safe').onclick=()=>document.getElementById('log').textContent='safe-clicked';" +
  "document.getElementById('danger').onclick=()=>document.getElementById('log').textContent='DANGER-CLICKED';" +
  '</script>'
);

let target = 'danger';
const mock = await startMock(({ turn, reqs }) => {
  const call = (name, args) => [oai.text(`调用 ${name}`), oai.toolCall(name, args, 'c' + turn), oai.stop('tool_calls')];
  if (turn === 1) return call('read_page', '{}');
  if (turn === 2) {
    const snap = reqs[turn - 1].messages.filter((m) => m.role === 'tool').pop()?.content || '';
    const re = target === 'danger' ? /\[ref=(\d+)\] button "立即购买"/ : /\[ref=(\d+)\] button "查看详情"/;
    const m = snap.match(re);
    return call('click', JSON.stringify({ ref: m ? Number(m[1]) : 1 }));
  }
  return [oai.text('完成。'), oai.stop()];
});

const browser = await launchWithExtension();
const sw = await browser.serviceWorker();
await sw.evalJs(`chrome.storage.local.set({
  accounts: [
    { id:'x', name:'Alpha 账号', provider:'openai',    baseUrl:${JSON.stringify(mock.url)}, apiKey:'sk-t', models:['model-a','model-b'] },
    { id:'y', name:'Gamma 账号', provider:'anthropic', baseUrl:${JSON.stringify(mock.url)}, apiKey:'sk-t', models:['model-c'] }
  ],
  activeAccount:'x', provider:'openai', baseUrl:${JSON.stringify(mock.url)}, apiKey:'sk-t', model:'model-a',
  maxTokens:4096, maxSteps:6, temperature:null, tokenParam:'max_tokens' })`);

const pageTab = await browser.newTab(site.url);
await sleep(2000);
const panel = await browser.openPanel();
const page = await (async () => {
  const t = (await browser.targets()).find((x) => x.id === pageTab.id);
  const { Sess } = await import('../helpers/cdp.mjs');
  return Sess.open(t.webSocketDebuggerUrl);
})();

const setMode = async (m) => {
  await panel.evalJs(`(() => { const el = document.getElementById('modeSel');
    el.value = ${JSON.stringify(m)}; el.dispatchEvent(new Event('change')); return 1; })()`);
  await sleep(300);
};
const pageLog = () => page.evalJs(`document.getElementById('log').textContent`);
const reset = async () => {
  // 先等上一轮真的跑完再清页面日志，否则上一节的点击会在清空之后才落地
  for (let i = 0; i < 40; i++) {
    if (await panel.evalJs(`document.getElementById('stop').hidden`)) break;
    await sleep(300);
  }
  await panel.evalJs(`document.getElementById('reset').click()`);
  await sleep(600);
  await page.evalJs(`document.getElementById('log').textContent='none'`);
  await browser.activate(pageTab.id);
  await sleep(300);
};
const ask = async (text) => {
  await browser.activate(pageTab.id);
  await sleep(300);
  mock.reset();
  await askAndWait(panel, text);
};

// ── 1. 模型配置切换器 ────────────────────────────────────────────
s.section('模型配置切换器');
s.t('胶囊显示当前档的模型', (await panel.evalJs(`document.getElementById('modelName').textContent`)) === 'model-a');
s.t('胶囊按接口格式着色', (await panel.evalJs(`document.getElementById('modelDot').className`)).includes('openai'));
s.t('菜单默认收起', await panel.evalJs(`document.getElementById('modelMenu').hidden`));

await panel.evalJs(`document.getElementById('modelBtn').click()`);
await sleep(400);
{
  const m = await panel.json(`{
    open: !document.getElementById('modelMenu').hidden,
    groups: [...document.querySelectorAll('#modelMenu .menu-group')].map(g=>g.textContent),
    rows: [...document.querySelectorAll('#modelMenu .menu-row')].map(r=>r.querySelector('.m-name').textContent),
    checked: document.querySelector('#modelMenu .menu-row[aria-selected="true"] .m-name')?.textContent,
    hasManage: !!document.getElementById('manageProfiles') }`);
  s.t('点击展开菜单', m.open);
  s.t('按账号分组', m.groups.length === 2 && m.groups[0].includes('Alpha'), JSON.stringify(m.groups));
  s.t('同一账号下的多个模型都列出来', m.rows.join(',') === 'model-a,model-b,model-c', JSON.stringify(m.rows));
  s.t('当前模型打勾', m.checked === 'model-a', String(m.checked));
  s.t('菜单里有管理入口', m.hasManage);
}
// 切到 model-c（anthropic 账号），验证"模型 + 账号地址密钥"一起换
await panel.evalJs(`[...document.querySelectorAll('#modelMenu .menu-row')][2].click()`);
await sleep(700);
{
  const after = await sw.evalJs(`chrome.storage.local.get(['model','provider','activeAccount'])`);
  s.t('切模型时连账号的接口格式一起换掉',
    after.model === 'model-c' && after.provider === 'anthropic' && after.activeAccount === 'y',
    JSON.stringify(after));
  s.t('切换后菜单自动收起', await panel.evalJs(`document.getElementById('modelMenu').hidden`));
  s.t('胶囊跟着更新', (await panel.evalJs(`document.getElementById('modelName').textContent`)) === 'model-c');
}
await panel.evalJs(`document.getElementById('modelBtn').click()`);
await sleep(300);
await panel.evalJs(`[...document.querySelectorAll('#modelMenu .menu-row')][0].click()`);
await sleep(600);
s.t('切回 openai 账号成功', (await sw.evalJs(`chrome.storage.local.get('provider')`)).provider === 'openai');

// ── 2. 模式切换 ──────────────────────────────────────────────────
s.section('模式切换');
await setMode('plan');
s.t('模式胶囊带 data-mode（用于配色）',
  (await panel.evalJs(`document.getElementById('modeSel').dataset.mode`)) === 'plan');
// 之前用 background 简写配色，把画箭头的 background-image 一起重置了，
// 胶囊看起来不像能点 —— 只有肉眼看图才发现，补成断言
s.t('模式胶囊保留下拉箭头（background-image）',
  (await panel.evalJs(`getComputedStyle(document.getElementById('modeSel')).backgroundImage`)).includes('gradient'));
s.t('模型胶囊有下拉箭头（内联 SVG）', await panel.evalJs(`!!document.querySelector('#modelBtn svg')`));

const seq = [];
for (let i = 0; i < 3; i++) {
  await panel.evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true}))`);
  await sleep(250);
  seq.push(await panel.evalJs(`document.getElementById('modeSel').value`));
}
s.t('Shift+Tab 循环 plan→auto→always→plan', seq.join('→') === 'auto→always→plan', seq.join('→'));

// ── 3. Plan 只读 ─────────────────────────────────────────────────
s.section('Plan（只读）');
await reset(); await setMode('plan');
target = 'danger';
await ask('帮我买下这个东西');
{
  const names = (mock.reqs[0].tools || []).map((x) => x.function.name).sort();
  s.t('计划模式只暴露只读工具', names.join(',') === 'read_page,scroll,wait', names.join(','));
  s.t('click/type_text/navigate 完全不给', !names.includes('click') && !names.includes('navigate'));
  s.t('系统提示声明了计划模式', String(mock.reqs[0].messages[0].content).includes('计划模式'));
  // mock 故意无视工具列表硬报一个 click —— 模拟模型犯浑或被页面注入
  s.t('模型硬报未授权工具时被执行侧拦下', (await pageLog()) === 'none', await pageLog());
  const u = await panelState(panel);
  s.t('被拦下的调用标记为失败', u.tools.some((x) => x.includes('click') && x.includes('✗')), JSON.stringify(u.tools));
  const fed = mock.reqs.flatMap((r) => (r.messages || []).filter((m) => m.role === 'tool').map((m) => m.content)).join('');
  s.t('拦截原因回填给模型并列出可用工具',
    fed.includes('计划模式，不允许') && fed.includes('read_page'), fed.slice(0, 160));
}

// ── 4. Auto 拒绝 ─────────────────────────────────────────────────
s.section('Auto —— 拒绝');
await reset(); await setMode('auto');
await ask('帮我买下这个东西');
{
  let u = await panelState(panel);
  s.t('点「立即购买」触发确认卡', u.confirms.length === 1, JSON.stringify(u.confirms));
  s.t('确认卡说明了风险', u.confirms[0]?.includes('立即购买'), u.confirms[0]);
  s.t('确认前页面没有被点击', (await pageLog()) === 'none');

  await panel.evalJs(`document.querySelector('.confirm .c-no').click()`);
  await sleep(2500);
  s.t('拒绝后页面仍未被点击', (await pageLog()) === 'none', await pageLog());
  u = await panelState(panel);
  s.t('拒绝被标记为失败', u.tools.some((x) => x.includes('click') && x.includes('✗')), JSON.stringify(u.tools));
  const fed = mock.reqs.flatMap((r) => (r.messages || []).filter((m) => m.role === 'tool').map((m) => m.content)).join('');
  s.t('拒绝理由已回填给模型', fed.includes('用户拒绝'), fed.slice(0, 120));
}

// ── 5. Auto 允许 ─────────────────────────────────────────────────
s.section('Auto —— 允许');
await reset(); await setMode('auto');
await ask('帮我买下这个东西');
s.t('再次弹出确认', (await panelState(panel)).pendingConfirm);
await panel.evalJs(`document.querySelector('.confirm .c-yes').click()`);
await sleep(2500);
s.t('允许后真的点了', (await pageLog()) === 'DANGER-CLICKED', await pageLog());

// ── 5b. 确认挂起时点停止 ─────────────────────────────────────────
s.section('Auto —— 挂起时中断');
await reset(); await setMode('auto');
await ask('帮我买下这个东西');
s.t('确认卡处于挂起状态', (await panelState(panel)).pendingConfirm);
await panel.evalJs(`document.getElementById('stop').click()`);
await sleep(2500);
{
  const u = await panelState(panel);
  s.t('点停止后循环脱身、恢复可输入', !u.busy, JSON.stringify({ busy: u.busy }));
  s.t('停止后页面未被操作', (await pageLog()) === 'none', await pageLog());
}

// ── 6. Auto 安全操作不打扰 ───────────────────────────────────────
s.section('Auto —— 安全操作');
await reset(); await setMode('auto');
target = 'safe';
await ask('帮我看看详情');
{
  const u = await panelState(panel);
  s.t('点「查看详情」不弹确认', u.confirms.length === 0, JSON.stringify(u.confirms));
  s.t('安全操作直接执行', (await pageLog()) === 'safe-clicked', await pageLog());
}

// ── 7. Always ────────────────────────────────────────────────────
s.section('Always');
await reset(); await setMode('always');
target = 'danger';
await ask('帮我买下这个东西');
{
  const u = await panelState(panel);
  s.t('危险操作也不弹确认', u.confirms.length === 0, JSON.stringify(u.confirms));
  s.t('直接执行了', (await pageLog()) === 'DANGER-CLICKED', await pageLog());
  s.t('工具全集可用', (mock.reqs[0].tools || []).length === 6, String((mock.reqs[0].tools || []).length));
}

browser.stop();
await mock.close();
await site.close();
s.done();
