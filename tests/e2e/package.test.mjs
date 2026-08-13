// 打包产物：结构必须是「解压后第一层就是 manifest.json」，路径必须用正斜杠。
// 这两条是 Chrome 应用商店最常见的上传被拒原因。
//
// 只解析 ZIP 的中央目录，不解压 —— 要验的就是条目清单和路径写法本身。
// 「解压出来能不能跑」由其它套件覆盖：它们加载的就是同一份源码目录。

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { suite } from '../helpers/assert.mjs';
import { REPO } from '../helpers/env.mjs';

const s = suite('package');

const manifest = JSON.parse(readFileSync(join(REPO, 'manifest.json'), 'utf8'));
const ZIP = join(REPO, `page-agent-v${manifest.version}.zip`);
const OPERA_ZIP = join(REPO, `page-agent-v${manifest.version}-opera.zip`);
if (existsSync(ZIP)) rmSync(ZIP);
if (existsSync(OPERA_ZIP)) rmSync(OPERA_ZIP);

s.section('打包');
execFileSync(process.execPath, [join(REPO, 'pack.mjs')], { cwd: REPO, stdio: 'pipe' });
s.t('pack.mjs 产出了 zip', existsSync(ZIP), ZIP);

/** 只读中央目录，拿到条目名和原始大小。 */
function zipEntries(path) {
  const buf = readFileSync(path);
  // 从尾部找 End Of Central Directory 签名
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('这不是一个合法的 zip：找不到中央目录');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录项签名不对');
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    out.push({
      name: buf.toString('utf8', off + 46, off + 46 + nameLen),
      size: buf.readUInt32LE(off + 24),
      flags: buf.readUInt16LE(off + 8),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const entries = zipEntries(ZIP);
const names = entries.map((e) => e.name).sort();

s.section('结构');
s.t('解压后第一层就是 manifest.json（没套文件夹）', names.includes('manifest.json'),
  JSON.stringify(names.slice(0, 4)));
s.t('没有任何条目被包在同一个顶层目录下',
  new Set(names.map((n) => n.split('/')[0])).size > 1, JSON.stringify([...new Set(names.map((n) => n.split('/')[0]))]));
s.t('路径分隔符是正斜杠（Compress-Archive 会写成反斜杠，商店可能拒收）',
  names.every((n) => !n.includes('\\')), JSON.stringify(names.filter((n) => n.includes('\\'))));
s.t('文件名标记为 UTF-8', entries.every((e) => (e.flags & 0x0800) !== 0));

s.section('内容');
const REQUIRED = [
  'manifest.json', 'background.js', 'content.js',
  'sidepanel.html', 'sidepanel.css', 'sidepanel.js',
  'options.html', 'options.js',
  'lib/api.js', 'lib/providers.js', 'lib/sse.js', 'lib/tools.js', 'lib/markdown.js',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png',
];
for (const f of REQUIRED) s.t(`包含 ${f}`, names.includes(f));
s.t('128×128 图标非空（商店列表页要用）',
  (entries.find((e) => e.name === 'icons/icon128.png')?.size || 0) > 500);

s.section('不该进包的东西');
s.t('没打包测试', !names.some((n) => n.startsWith('tests/')), JSON.stringify(names.filter((n) => n.startsWith('tests/'))));
s.t('没打包文档', !names.some((n) => n.endsWith('.md')), JSON.stringify(names.filter((n) => n.endsWith('.md'))));
s.t('没打包打包脚本自己', !names.includes('pack.mjs'));
s.t('没有嵌套的 zip', !names.some((n) => n.endsWith('.zip')));
s.t('条目数与必需清单一致（没有夹带）', names.length === REQUIRED.length,
  JSON.stringify(names.filter((n) => !REQUIRED.includes(n))));

s.section('清单元信息');
s.t('manifest 声明了图标', Object.keys(manifest.icons || {}).includes('128'));
s.t('action 声明了图标', Object.keys(manifest.action?.default_icon || {}).includes('128'));
s.t('声明了最低 Chrome 版本', !!manifest.minimum_chrome_version);
s.t('有 homepage_url（商店和扩展详情页会显示）', !!manifest.homepage_url, JSON.stringify(manifest.homepage_url));

s.section('Opera 打包');
execFileSync(process.execPath, [join(REPO, 'pack.mjs'), 'opera'], { cwd: REPO, stdio: 'pipe' });
s.t('pack.mjs opera 产出 Opera zip', existsSync(OPERA_ZIP), OPERA_ZIP);
const operaEntries = zipEntries(OPERA_ZIP);
const operaNames = operaEntries.map((e) => e.name).sort();
s.t('Opera zip 解压后第一层是 manifest.json', operaNames.includes('manifest.json'));
s.t('Opera zip 不包含 manifest.opera.json 源文件名', !operaNames.includes('manifest.opera.json'));
s.t('Opera zip 包含 sidepanel.html', operaNames.includes('sidepanel.html'));

s.done();
