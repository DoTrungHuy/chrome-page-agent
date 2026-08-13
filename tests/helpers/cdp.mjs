// CDP 客户端与 Chrome 生命周期。
//
// 注意：Chrome 137+ 已经不再响应 --load-extension 命令行开关（实测 151 上
// 加任何 flag 组合都装不上），必须用 CDP 的 Extensions.loadUnpacked。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome, freePort, sleep, REPO } from './env.mjs';

/** 一条 CDP 连接。send() 是带超时的请求-响应。 */
export class Sess {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    this.exceptions = [];
  }

  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error(`CDP 连接失败：${wsUrl}`));
    });
    const s = new Sess(ws);
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') {
        s.exceptions.push(
          m.params?.exceptionDetails?.exception?.description || JSON.stringify(m.params)
        );
        return;
      }
      const w = s.waiting.get(m.id);
      if (!w) return;
      s.waiting.delete(m.id);
      m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result);
    });
    return s;
  }

  send(method, params = {}, timeout = 60000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiting.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.delete(id)) rej(new Error(`${method} 超时`));
      }, timeout);
    });
  }

  /** 在页面/Worker 上下文求值。表达式的最后一个值会被返回（支持 await）。 */
  async evalJs(expression, { gesture = false } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: gesture,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || '求值抛异常');
    }
    return r.result.value;
  }

  /** evalJs 的 JSON 版：表达式返回对象时用它，省去手动 JSON.stringify。 */
  async json(expression) {
    return JSON.parse(await this.evalJs(`JSON.stringify(${expression})`));
  }

  /** 开始收集该上下文的未捕获异常。 */
  async watchExceptions() {
    await this.send('Runtime.enable');
    return this.exceptions;
  }

  close() {
    try { this.ws.close(); } catch { /* 已经关了 */ }
  }
}

/**
 * 启一个干净的 Chrome，装上本仓库的扩展。
 * 返回的 stop() 会关掉浏览器并清理临时 profile。
 */
export async function launchWithExtension({ extraArgs = [], extension = REPO } = {}) {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'page-agent-test-'));
  const chrome = spawn(
    findChrome(),
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=DialMediaRouteProvider',
      ...extraArgs,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { await fetch(`${base}/json/version`); break; } catch { await sleep(400); }
  }

  const ver = await (await fetch(`${base}/json/version`)).json();
  const browser = await Sess.open(ver.webSocketDebuggerUrl);

  // --load-extension 在新版 Chrome 上已失效，只能走这条
  const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: extension });

  const api = {
    port, base, chrome, browser, extId,
    targets: () => fetch(`${base}/json/list`).then((r) => r.json()),
    newTab: (url) =>
      fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((r) => r.json()),
    activate: (id) => fetch(`${base}/json/activate/${id}`),
    closeTab: (id) => fetch(`${base}/json/close/${id}`),

    /** 连上扩展的 Service Worker（它是懒启动的，要轮询等它出现）。 */
    async serviceWorker() {
      for (let i = 0; i < 60; i++) {
        const t = (await api.targets()).find(
          (x) => x.url === `chrome-extension://${extId}/background.js`
        );
        if (t) return Sess.open(t.webSocketDebuggerUrl);
        await sleep(400);
      }
      throw new Error('Service Worker 没有启动');
    },

    /** 把侧边栏当普通标签页打开并等它就绪。 */
    async openPanel() {
      const tab = await api.newTab(`chrome-extension://${extId}/sidepanel.html`);
      await sleep(1200);
      const target = (await api.targets()).find((x) => x.id === tab.id);
      if (!target) throw new Error('找不到侧边栏 target');
      const s = await Sess.open(target.webSocketDebuggerUrl);
      s.tabId = tab.id;
      for (let i = 0; i < 40; i++) {
        try {
          if (await s.evalJs(`!!document.getElementById('input')`)) return s;
        } catch { /* 还在加载 */ }
        await sleep(300);
      }
      throw new Error('侧边栏页面没能就绪');
    },

    /** 打开扩展的设置页。 */
    async openOptions() {
      const tab = await api.newTab(`chrome-extension://${extId}/options.html`);
      await sleep(1500);
      const target = (await api.targets()).find((x) => x.id === tab.id);
      const s = await Sess.open(target.webSocketDebuggerUrl);
      s.tabId = tab.id;
      return s;
    },

    stop() {
      try { browser.close(); } catch { /* ignore */ }
      try { chrome.kill(); } catch { /* ignore */ }
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
  return api;
}

/** 面板的常用操作：发一句话并等这一轮跑完。 */
export async function askAndWait(panel, text, { timeout = 40000 } = {}) {
  await panel.evalJs(
    `(() => { document.getElementById('input').value = ${JSON.stringify(text)};
      document.getElementById('composer').requestSubmit(); return 1; })()`
  );
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    await sleep(400);
    if (await panel.evalJs(`document.getElementById('stop').hidden`)) break;
    // 等待用户确认时也算停下来了，交给调用方处理
    if (await panel.evalJs(`!!document.querySelector('.confirm:not(.answered)')`)) break;
  }
  await sleep(500);
}

/** 面板当前渲染出来的东西，测试里到处都要读。 */
export function panelState(panel) {
  return panel.json(`{
    users: [...document.querySelectorAll('.msg.user')].map(e => e.textContent),
    assistant: [...document.querySelectorAll('.msg.assistant')].map(e => e.textContent).join('|'),
    tools: [...document.querySelectorAll('.tool')].map(e => e.textContent.trim()),
    infos: [...document.querySelectorAll('.msg.info')].map(e => e.textContent),
    errors: [...document.querySelectorAll('.msg.error')].map(e => e.textContent),
    confirms: [...document.querySelectorAll('.confirm')].map(e => e.textContent.trim()),
    pendingConfirm: !!document.querySelector('.confirm:not(.answered)'),
    context: document.getElementById('context').textContent,
    busy: !document.getElementById('stop').hidden
  }`);
}
