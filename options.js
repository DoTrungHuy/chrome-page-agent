import { PRESETS, PROVIDERS } from './lib/providers.js';

const $ = (id) => document.getElementById(id);

const RUN_DEFAULTS = {
  maxTokens: 16000,
  maxSteps: 20,
  temperature: null,
  tokenParam: 'max_tokens',
};

// 一个账号 = 接口格式 + Base URL + API Key + 它下面的模型列表。
// 之前是「一个模型一张卡」，同一家的多个模型要把地址和密钥各填一遍 —— 那是错的。
let accounts = [];
let activeAccount = '';
let activeModel = '';

const newId = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ── 载入 + 迁移 ────────────────────────────────────────────────

const stored = await chrome.storage.local.get({
  ...RUN_DEFAULTS,
  accounts: [], activeAccount: '',
  profiles: [], activeProfile: '',           // 上一版：一模型一档
  provider: '', baseUrl: '', model: '', apiKey: '',
});

accounts = stored.accounts || [];
activeAccount = stored.activeAccount || '';
activeModel = stored.model || '';

if (!accounts.length && stored.profiles?.length) {
  // 把「一模型一档」合并成账号：接口格式 + 地址 + 密钥 相同的归为同一个账号
  const byKey = new Map();
  for (const p of stored.profiles) {
    const key = `${p.provider}|${p.baseUrl}|${p.apiKey}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        id: newId(),
        name: p.name || PROVIDERS[p.provider]?.label || '账号',
        provider: p.provider, baseUrl: p.baseUrl, apiKey: p.apiKey,
        models: [],
      });
    }
    const acc = byKey.get(key);
    if (p.model && !acc.models.includes(p.model)) acc.models.push(p.model);
    if (p.id === stored.activeProfile) { activeAccount = acc.id; activeModel = p.model; }
  }
  accounts = [...byKey.values()];
} else if (!accounts.length && stored.model) {
  // 更早的扁平配置
  accounts = [{
    id: newId(),
    name: PROVIDERS[stored.provider]?.label || '我的账号',
    provider: stored.provider || 'anthropic',
    baseUrl: stored.baseUrl || '',
    apiKey: stored.apiKey || '',
    models: [stored.model],
  }];
  activeAccount = accounts[0].id;
}

if (!activeAccount && accounts.length) activeAccount = accounts[0].id;
if (!activeModel) activeModel = accounts.find((a) => a.id === activeAccount)?.models[0] || '';

for (const f of Object.keys(RUN_DEFAULTS)) {
  const v = stored[f];
  $(f).value = v === null || v === undefined ? '' : String(v);
}

for (const [i, p] of PRESETS.entries()) {
  const o = document.createElement('option');
  o.value = String(i);
  o.textContent = p.name;
  $('presetPick').append(o);
}

// ── 渲染 ───────────────────────────────────────────────────────

function render() {
  const box = $('accounts');
  box.replaceChildren();

  if (!accounts.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '还没有账号。从下面的预设里挑一个开始。';
    box.append(p);
    return;
  }

  for (const acc of accounts) {
    const isActive = acc.id === activeAccount;
    const card = document.createElement('div');
    card.className = 'card' + (isActive ? ' active' : '');

    const head = document.createElement('div');
    head.className = 'head';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = acc.name || '(未命名)';
    head.append(nm);
    if (isActive) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '当前使用';
      head.append(tag);
    }
    const del = document.createElement('button');
    del.className = 'mini del';
    del.type = 'button';
    del.textContent = '删除';
    del.addEventListener('click', () => {
      accounts = accounts.filter((x) => x.id !== acc.id);
      if (activeAccount === acc.id) {
        activeAccount = accounts[0]?.id || '';
        activeModel = accounts[0]?.models[0] || '';
      }
      render();
    });
    head.append(del);
    card.append(head);

    const field = (label, key, type = 'text', ph = '') => {
      const l = document.createElement('label');
      l.textContent = label;
      const i = document.createElement('input');
      i.type = type;
      i.value = acc[key] ?? '';
      i.placeholder = ph;
      i.spellcheck = false;
      i.addEventListener('input', () => {
        acc[key] = i.value;
        if (key === 'name') nm.textContent = i.value || '(未命名)';
      });
      l.append(i);
      return l;
    };

    const row = document.createElement('div');
    row.className = 'row';
    row.append(field('名称', 'name', 'text', '例如 DeepSeek'));

    const provL = document.createElement('label');
    provL.textContent = '接口格式';
    const provSel = document.createElement('select');
    for (const [id, p] of Object.entries(PROVIDERS)) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = p.label;
      provSel.append(o);
    }
    provSel.value = acc.provider || 'openai';
    provSel.addEventListener('change', () => { acc.provider = provSel.value; });
    provL.append(provSel);
    row.append(provL);
    card.append(row);

    card.append(field('Base URL', 'baseUrl', 'text', PROVIDERS[acc.provider]?.defaultBaseUrl || ''));
    card.append(field('API Key', 'apiKey', 'password', 'sk-...'));

    // 模型标签
    const ml = document.createElement('label');
    ml.textContent = '模型（点一下设为当前）';
    card.append(ml);

    const chips = document.createElement('div');
    chips.className = 'chips';

    for (const m of acc.models) {
      const chip = document.createElement('span');
      const on = isActive && m === activeModel;
      chip.className = 'chip' + (on ? ' on' : '');

      const txt = document.createElement('span');
      txt.textContent = m;
      txt.title = '设为当前';
      txt.addEventListener('click', () => {
        activeAccount = acc.id;
        activeModel = m;
        render();
      });

      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '×';
      x.title = '移除这个模型';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        acc.models = acc.models.filter((v) => v !== m);
        if (on) activeModel = acc.models[0] || '';
        render();
      });

      chip.append(txt, x);
      chips.append(chip);
    }

    const add = document.createElement('span');
    add.className = 'chip-add';
    const addIn = document.createElement('input');
    addIn.placeholder = '+ 添加模型名，回车';
    addIn.spellcheck = false;
    addIn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = addIn.value.trim();
      if (!v || acc.models.includes(v)) { addIn.value = ''; return; }
      acc.models.push(v);
      if (!activeModel) { activeAccount = acc.id; activeModel = v; }
      render();
    });
    add.append(addIn);
    chips.append(add);

    card.append(chips);
    box.append(card);
  }
}

$('presetPick').addEventListener('change', (e) => {
  const p = PRESETS[Number(e.target.value)];
  e.target.value = '';
  if (!p) return;
  const acc = {
    id: newId(), name: p.name, provider: p.provider,
    baseUrl: p.baseUrl, apiKey: '', models: [p.model],
  };
  accounts.push(acc);
  if (!activeAccount) { activeAccount = acc.id; activeModel = p.model; }
  render();
});

$('addBlank').addEventListener('click', () => {
  const acc = { id: newId(), name: '新账号', provider: 'openai', baseUrl: '', apiKey: '', models: [] };
  accounts.push(acc);
  if (!activeAccount) activeAccount = acc.id;
  render();
});

// ── 保存 ───────────────────────────────────────────────────────

$('save').addEventListener('click', async () => {
  const temp = $('temperature').value.trim();
  const acc = accounts.find((a) => a.id === activeAccount);

  await chrome.storage.local.set({
    accounts,
    activeAccount,
    // 生效配置仍然是这几个扁平字段 —— Service Worker 只认它们，
    // 账号/模型结构只是"少填几遍"的外壳
    provider: acc?.provider || '',
    baseUrl: acc?.baseUrl || '',
    apiKey: acc?.apiKey || '',
    model: activeModel || '',
    maxTokens: Number($('maxTokens').value) || RUN_DEFAULTS.maxTokens,
    maxSteps: Math.min(Math.max(Number($('maxSteps').value) || RUN_DEFAULTS.maxSteps, 1), 50),
    temperature: temp === '' ? null : Number(temp),
    tokenParam: $('tokenParam').value,
    // 旧结构清掉，避免下次又走迁移
    profiles: [], activeProfile: '',
  });

  $('status').textContent = '已保存 ✓';
  setTimeout(() => ($('status').textContent = ''), 2000);
});

render();
