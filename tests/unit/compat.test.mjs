// 跨浏览器清单与 API 适配层的回归检查。
// 这套检查不启动浏览器，避免把“清单目标正确”误当成某个浏览器的实机通过。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { suite } from '../helpers/assert.mjs';
import { REPO } from '../helpers/env.mjs';

const s = suite('compat');
const chromium = JSON.parse(readFileSync(join(REPO, 'manifest.json'), 'utf8'));
const opera = JSON.parse(readFileSync(join(REPO, 'manifest.opera.json'), 'utf8'));

s.section('Chromium 清单');
s.t('Chromium 目标仍使用 MV3', chromium.manifest_version === 3);
s.t('声明 sidePanel 权限', chromium.permissions.includes('sidePanel'));
s.t('声明 side_panel 入口', chromium.side_panel?.default_path === 'sidepanel.html');
s.t('使用 Service Worker', chromium.background?.service_worker === 'background.js');
s.t('没有混入 Opera sidebar_action', !chromium.sidebar_action);

s.section('Opera 清单');
s.t('Opera 目标仍使用 MV3', opera.manifest_version === 3);
s.t('不声明 Chromium 专属 sidePanel 权限', !opera.permissions.includes('sidePanel'));
s.t('不声明 Chromium 专属 side_panel 入口', !opera.side_panel);
s.t('声明 Opera sidebar_action 入口', opera.sidebar_action?.default_panel === 'sidepanel.html');
s.t('快捷键使用 Opera sidebar action 命令', Boolean(opera.commands?._execute_sidebar_action));
s.t('使用同一个后台入口', opera.background?.service_worker === 'background.js');

s.section('运行时代码');
const runtime = ['background.js', 'sidepanel.js', 'options.js', 'lib/tools.js', 'content.js']
  .map((file) => readFileSync(join(REPO, file), 'utf8'));
s.t('后台、面板、设置页和工具层接入共享 API 适配',
  runtime.slice(0, 4).every((text) => text.includes('api.js')));
s.t('内容脚本使用 browser/chrome 兼容探测',
  runtime[4].includes('globalThis.browser ?? globalThis.chrome'));

s.done();
