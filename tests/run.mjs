#!/usr/bin/env node
// 统一测试入口：node tests/run.mjs [关键词]
//
// 单元测试在 Node 里跑，端到端会真的起 Chrome、装扩展、用假的模型服务驱动。
// 全程在本地，不访问网络。

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './helpers/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

function discover(dir) {
  try {
    return readdirSync(join(HERE, dir))
      .filter((f) => f.endsWith('.test.mjs'))
      .sort()
      .map((f) => join(HERE, dir, f));
  } catch {
    return [];
  }
}

// 单元测试先跑：快，而且挂了就没必要再等端到端起浏览器
let files = [...discover('unit'), ...discover('e2e')];
if (filter.length) {
  files = files.filter((f) => filter.some((k) => f.toLowerCase().includes(k.toLowerCase())));
}

if (!files.length) {
  console.error(filter.length ? `没有匹配 ${filter.join(' / ')} 的测试` : '没有找到任何测试');
  process.exit(1);
}

// 端到端要 Chrome，先确认找得到，别跑到一半才失败
if (files.some((f) => f.includes('e2e'))) {
  try {
    console.log(`Chrome: ${findChrome()}\n`);
  } catch (e) {
    console.error(`${e.message}\n（只想跑单元测试的话：node tests/run.mjs unit）`);
    process.exit(1);
  }
}

function run(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [file], {
      stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('close', (code) =>
      resolve({ file, code, out, ms: Date.now() - started })
    );
  });
}

const results = [];
for (const f of files) {
  const name = relative(HERE, f).replace(/\\/g, '/');
  process.stdout.write(`▸ ${name} … `);
  const r = await run(f);
  results.push({ ...r, name });
  const secs = (r.ms / 1000).toFixed(1);
  if (r.code === 0) {
    // 从输出里捞出「N 项全部通过」这一行当摘要
    const line = (r.out.match(/^.*项全部通过.*$/m) || [''])[0].trim();
    console.log(`✓ ${line || '通过'}  (${secs}s)`);
  } else {
    console.log(`✗ 失败  (${secs}s)`);
    if (!verbose) {
      const failures = r.out.split('\n').filter((l) => l.includes('✗'));
      for (const l of failures.slice(0, 12)) console.log(`    ${l.trim()}`);
      if (!failures.length) console.log(r.out.split('\n').slice(-12).map((l) => `    ${l}`).join('\n'));
    }
  }
}

const failed = results.filter((r) => r.code !== 0);
const total = (results.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(1);
console.log(
  `\n${results.length - failed.length}/${results.length} 套通过，用时 ${total}s` +
    (failed.length ? `\n失败：${failed.map((f) => f.name).join(', ')}\n（加 --verbose 看完整输出）` : '')
);
process.exit(failed.length ? 1 : 0);
