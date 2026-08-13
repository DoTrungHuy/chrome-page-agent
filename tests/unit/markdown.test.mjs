// Markdown 渲染器：结构正确性 + 注入安全 + 死循环回归。
// 用最小 DOM 打桩在 Node 里跑，不需要浏览器。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO } from '../helpers/env.mjs';
import { suite } from '../helpers/assert.mjs';

const s = suite('markdown');
const SRC = join(REPO, 'lib', 'markdown.js');

// ── 源码层面的硬约束 ─────────────────────────────────────────────
s.section('源码约束');
{
  const code = readFileSync(SRC, 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  s.t('没有 innerHTML / outerHTML', !/\binnerHTML\b|\bouterHTML\b/.test(code),
    '出现 innerHTML 等于把注入通道开给恶意网页');
  s.t('没有 insertAdjacentHTML / document.write', !/insertAdjacentHTML|document\.write/.test(code));
  s.t('没有共享的模块级 /g 正则实例',
    !/^const\s+\w+\s*=\s*new RegExp\([\s\S]*?,\s*['"]g['"]\s*\)/m.test(code),
    '模块级 /g 正则 + 递归 = lastIndex 被内层重置 = 死循环');
}

// ── 最小 DOM 打桩 ────────────────────────────────────────────────
function mk(tag) {
  const n = {
    tag, children: [], text: '', dataset: {},
    append(...xs) { n.children.push(...xs); },
    set textContent(v) { n.text = String(v); n.children.length = 0; },
    get textContent() {
      return n.text || n.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
    },
  };
  return n;
}
globalThis.document = { createDocumentFragment: () => mk('#frag'), createElement: mk };

const { renderMarkdown } = await import(pathToFileURL(SRC).href);

const walk = (n, out = []) => {
  if (typeof n === 'string') return out;
  out.push(n);
  for (const c of n.children) walk(c, out);
  return out;
};
const render = (md) => walk(renderMarkdown(md));
const tags = (md) => render(md).map((n) => n.tag);
const find = (md, tag) => render(md).filter((n) => n.tag === tag);

// ── 死循环回归（最重要的一条）────────────────────────────────────
s.section('死循环回归');
{
  // 嵌套加粗触发 inline() 递归；共享正则时这里会挂死并吃光内存
  const t0 = Date.now();
  let ok = true;
  try { render('**粗 `代码` 粗** 和 *斜 **粗中粗** 斜* 再来 **a** **b** **c**'); }
  catch { ok = false; }
  const ms = Date.now() - t0;
  s.t('嵌套行内语法不会死循环', ok && ms < 1000, `${ms}ms`);
}
{
  const t0 = Date.now();
  render('**a**'.repeat(300));
  s.t('大量重复行内标记也能秒回', Date.now() - t0 < 1000);
}

// ── 结构 ─────────────────────────────────────────────────────────
s.section('结构');
s.t('# 标题 → h3', tags('# 标题').includes('h3'));
s.t('## 标题 → h4', tags('## 标题').includes('h4'));
s.t('**粗** → strong', tags('**粗**').includes('strong'));
s.t('*斜* → em', tags('*斜*').includes('em'));
s.t('~~删~~ → s', tags('~~删~~').includes('s'));
s.t('`码` → code', tags('`码`').includes('code'));
s.t('- 列表 → ul>li', find('- 一\n- 二', 'ul').length === 1 && find('- 一\n- 二', 'li').length === 2);
s.t('1. 列表 → ol>li', find('1. 一\n2. 二', 'ol').length === 1 && find('1. 一\n2. 二', 'li').length === 2);
s.t('> 引用 → blockquote', tags('> 引用').includes('blockquote'));
s.t('--- → hr', tags('---').includes('hr'));
s.t('代码块 → pre>code', find('```js\nconst a=1;\n```', 'pre').length === 1);
s.t('代码块内容原样保留',
  find('```\na < b && c > d\n```', 'code')[0]?.textContent === 'a < b && c > d');
s.t('流式中未闭合的代码块也能渲染', find('```js\nconst a=1;', 'pre').length === 1);
s.t('普通段落 → p', tags('就是一句话').includes('p'));
s.t('代码里的星号不被当粗体', find('`**不是粗体**`', 'strong').length === 0);
s.t('下划线不会误伤标识符', find('read_page 和 tool_use', 'em').length === 0);

// ── 链接安全 ─────────────────────────────────────────────────────
s.section('链接安全');
{
  const ok = find('[好](https://example.com/x)', 'a');
  s.t('https 链接被保留', ok.length === 1 && ok[0].href.startsWith('https://example.com'));
  s.t('链接带 noopener 且新窗口打开',
    ok[0]?.rel === 'noopener noreferrer' && ok[0]?.target === '_blank');
}
for (const bad of [
  '[点我](javascript:alert(1))',
  '[点我](data:text/html,<script>alert(1)</script>)',
  '[点我](vbscript:msgbox)',
  '[点我](JaVaScRiPt:alert(1))',
]) {
  s.t(`危险协议被拒：${bad.slice(4, 26)}`, find(bad, 'a').length === 0);
}
s.t('被拒的链接降级成文本而不是消失',
  render('[点我](javascript:x)')[0].textContent.includes('点我'));

// ── 注入 ─────────────────────────────────────────────────────────
s.section('注入');
{
  const md = '<img src=x onerror=alert(1)> 和 <script>alert(2)</script>';
  s.t('HTML 标签不会变成真节点',
    !tags(md).some((x) => ['img', 'script'].includes(x)), JSON.stringify(tags(md)));
  s.t('HTML 原样当文本显示', render(md)[0].textContent.includes('<img'));
}

s.done();
