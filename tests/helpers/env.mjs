// 环境探测：仓库路径、Chrome 位置、空闲端口。
// 之前这些在每个测试脚本里都是硬编码的（D:\github项目\... 和固定端口），
// 换台机器就跑不了，端口还撞过本机其它服务。

import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录，也就是要加载的扩展目录。 */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const CANDIDATES = {
  win32: [
    `${process.env.ProgramFiles || ''}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)'] || ''}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
};

export function findChrome() {
  if (process.env.CHROME_PATH) {
    if (!existsSync(process.env.CHROME_PATH)) {
      throw new Error(`CHROME_PATH 指向的文件不存在：${process.env.CHROME_PATH}`);
    }
    return process.env.CHROME_PATH;
  }
  for (const p of CANDIDATES[process.platform] || []) {
    if (p && existsSync(p)) return p;
  }
  throw new Error(
    '找不到 Chrome。请设置环境变量 CHROME_PATH 指向 Chrome 可执行文件后重试。'
  );
}

/**
 * 让操作系统分配一个空闲端口。
 * 固定端口撞过本机第三方服务（有个软件占着 9410，返回 JWT 而不是 CDP JSON，
 * 排查了半天），所以一律动态分配。
 */
export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
