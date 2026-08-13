// 打包浏览器扩展 zip。
//   node pack.mjs              -> Chromium 包（Chrome / Edge / Vivaldi / Brave）
//   node pack.mjs chromium     -> 同上
//   node pack.mjs opera        -> Opera 专用包
//
// 两个常见的上传被拒原因，这里都规避掉了：
//   1. 压缩包里套了一层文件夹 —— 必须解开就是 manifest.json
//   2. 条目路径用了反斜杠 —— Windows 的 Compress-Archive 会写成 `icons\x.png`，
//      而 ZIP 规范要求正斜杠。所以这里不调它，直接自己写 ZIP。
import { deflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || 'chromium';
if (!['chromium', 'opera'].includes(target)) {
  console.error(`不支持的目标：${target}。可选目标：chromium、opera`);
  process.exit(1);
}

const manifestSource = target === 'opera' ? 'manifest.opera.json' : 'manifest.json';
const manifest = JSON.parse(readFileSync(join(ROOT, manifestSource), 'utf8'));
const suffix = target === 'opera' ? '-opera' : '';
const OUT = join(ROOT, `page-agent-v${manifest.version}${suffix}.zip`);

// 只打包运行时真正需要的东西；文档、测试、打包脚本自己都不进包
const INCLUDE = [
  manifestSource,
  'background.js',
  'content.js',
  'sidepanel.html', 'sidepanel.css', 'sidepanel.js',
  'options.html', 'options.js',
  'lib',
  'icons',
];

function walk(abs, out = []) {
  if (statSync(abs).isDirectory()) {
    for (const name of readdirSync(abs).sort()) walk(join(abs, name), out);
  } else {
    out.push(abs);
  }
  return out;
}

const files = [];
for (const entry of INCLUDE) {
  const abs = join(ROOT, entry);
  if (!existsSync(abs)) {
    console.error(`缺少 ${entry}，先确认文件齐全再打包`);
    process.exit(1);
  }
  for (const f of walk(abs)) {
    const sourceName = relative(ROOT, f).split(sep).join('/');
    files.push({
      abs,
      name: sourceName === manifestSource ? 'manifest.json' : sourceName,
      path: f,
    });
  }
}

// ── 最小 ZIP 写入器（deflate + 中央目录）─────────────────────────

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const chunks = [];
const central = [];
let offset = 0;

for (const f of files) {
  const raw = readFileSync(f.path);
  const deflated = deflateRawSync(raw, { level: 9 });
  // 压不动的小文件就存原始内容，method=0
  const useDeflate = deflated.length < raw.length;
  const data = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const name = Buffer.from(f.name, 'utf8');
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);   // 本地文件头签名
  local.writeUInt16LE(20, 4);           // 需要版本
  local.writeUInt16LE(0x0800, 6);       // 通用标志：文件名是 UTF-8
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10);           // 时间（固定，保证可复现）
  local.writeUInt16LE(0x21, 12);        // 日期
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  chunks.push(local, name, data);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);     // 中央目录签名
  cen.writeUInt16LE(20, 4);
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(0x0800, 8);
  cen.writeUInt16LE(method, 10);
  cen.writeUInt16LE(0, 12);
  cen.writeUInt16LE(0x21, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(raw.length, 24);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt32LE(offset, 42);
  central.push(cen, name);

  offset += local.length + name.length + data.length;
}

const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

writeFileSync(OUT, Buffer.concat([...chunks, centralBuf, end]));

console.log(`目标：${target}`);
console.log(`清单：${manifestSource} -> manifest.json`);
console.log(`打好了：${OUT}  (${(statSync(OUT).size / 1024).toFixed(1)} KB, ${files.length} 个文件)`);
console.log('\n上传前自查：');
console.log('  · 解压后第一层就是 manifest.json（不能套文件夹）✓ 本脚本已保证');
console.log('  · 条目路径用正斜杠 ✓ 本脚本已保证');
console.log('  · icons/128 必须有 ✓');
console.log('  · <all_urls> 要在审核问卷里说明用途，否则大概率被打回 —— 见 README「上架」一节');
