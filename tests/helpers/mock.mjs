// 假的模型服务 + 假的网页服务。
//
// 假模型要同时会说两种方言：Anthropic Messages 的 content_block_* 事件流，
// 和 OpenAI 兼容的 choices[].delta。测试按 URL 路径自动分流。

import http from 'node:http';
import { freePort } from './env.mjs';

export const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
export const DONE = 'data: [DONE]\n\n';

/** OpenAI 兼容格式的分片构造。 */
export const oai = {
  text: (s) => sse({ choices: [{ index: 0, delta: { role: 'assistant', content: s } }] }),
  reasoning: (s) => sse({ choices: [{ index: 0, delta: { reasoning_content: s } }] }),
  toolCall: (name, args, id = 'call_1', index = 0) =>
    sse({
      choices: [{ index: 0, delta: { tool_calls: [
        { index, id, type: 'function', function: { name, arguments: args } },
      ] } }],
    }),
  stop: (reason = 'stop') => sse({ choices: [{ index: 0, delta: {}, finish_reason: reason }] }),
};

/** Anthropic 格式的分片构造。 */
export const ant = {
  text: (s, index = 0) => [
    sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: s } }),
    sse({ type: 'content_block_stop', index }),
  ].join(''),
  toolCall: (name, args, id = 'toolu_1', index = 1) => [
    sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } }),
    sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: args } }),
    sse({ type: 'content_block_stop', index }),
  ].join(''),
  stop: (reason = 'end_turn') => sse({ type: 'message_delta', delta: { stop_reason: reason } }),
};

/**
 * 起一个假模型服务。
 *
 * handler({ turn, body, anthropic, reqs }) 返回要写出去的字符串数组
 * （或返回 Promise，用于模拟慢响应）。
 */
export async function startMock(handler) {
  const port = await freePort();
  const state = { turn: 0, reqs: [] };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* 空请求体 */ }
      state.reqs.push(body);
      const turn = ++state.turn;
      const anthropic = req.url.includes('/v1/messages');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let chunks = [];
      try {
        chunks = (await handler({ turn, body, anthropic, reqs: state.reqs })) || [];
      } catch (e) {
        chunks = [sse({ error: { message: String(e?.message || e) } })];
      }
      for (const c of chunks) res.write(c);
      if (!anthropic) res.write(DONE);
      res.end();
    });
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    get reqs() { return state.reqs; },
    /** 开始一段新剧情：轮次归零、请求记录清空。 */
    reset() { state.turn = 0; state.reqs.length = 0; },
    close() { return new Promise((r) => server.close(r)); },
  };
}

/** 起一个假网页服务，返回给定 HTML。 */
export async function startSite(html) {
  const port = await freePort();
  const server = http.createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    close() { return new Promise((r) => server.close(r)); },
  };
}

/** 往扩展里写一份指向假模型的配置。 */
export function configScript(mockUrl, { provider = 'openai', model = 'mock-model', mode = 'always', extra = {} } = {}) {
  const cfg = {
    accounts: [{ id: 'test', name: 'Mock', provider, baseUrl: mockUrl, apiKey: 'sk-test', models: [model] }],
    activeAccount: 'test',
    provider, baseUrl: mockUrl, apiKey: 'sk-test', model,
    maxTokens: 4096, maxSteps: 8, temperature: null, tokenParam: 'max_tokens', mode,
    ...extra,
  };
  return `chrome.storage.local.set(${JSON.stringify(cfg)})`;
}
