// 供应商适配层：两种 wire format 的 SSE 解析、工具调用累积、历史回填结构。
// 用假模型服务端到端跑，并在服务端校验第二轮请求的消息结构 ——
// 回填结构写错了 API 会直接拒，这是最容易错也最致命的地方。

import { PROVIDERS } from '../../lib/providers.js';
import { TOOL_DEFS } from '../../lib/tools.js';
import { suite } from '../helpers/assert.mjs';
import { startMock, sse } from '../helpers/mock.mjs';

const s = suite('providers');

const mock = await startMock(({ turn, anthropic }) => {
  if (anthropic) {
    if (turn === 1) {
      return [
        sse({ type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } }),
        // thinking 块必须能原样带回历史
        sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先读页面' } }),
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG123' } }),
        sse({ type: 'content_block_stop', index: 0 }),
        sse({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
        sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '我先看看' } }),
        sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '页面。' } }),
        sse({ type: 'content_block_stop', index: 1 }),
        // 并行两个工具调用，参数分片下发
        sse({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_A', name: 'read_page', input: {} } }),
        sse({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"mo' } }),
        sse({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'de":"outline"}' } }),
        sse({ type: 'content_block_stop', index: 2 }),
        sse({ type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_B', name: 'scroll', input: {} } }),
        sse({ type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"direction":"down"}' } }),
        sse({ type: 'content_block_stop', index: 3 }),
        sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
        sse({ type: 'message_stop' }),
      ];
    }
    return [
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '这是一个示例页面。' } }),
      sse({ type: 'content_block_stop', index: 0 }),
      sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      sse({ type: 'message_stop' }),
    ];
  }

  if (turn === 1) {
    return [
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '我先看看' } }] }),
      // DeepSeek-R1 风格的思维链字段
      sse({ choices: [{ index: 0, delta: { reasoning_content: '先读页面' } }] }),
      sse({ choices: [{ index: 0, delta: { content: '页面。' } }] }),
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_A', type: 'function', function: { name: 'read_page', arguments: '' } }] } }] }),
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"mo' } }] } }] }),
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'de":"outline"}' } }] } }] }),
      // 第二个调用，index=1，工具名分两片下发（某些端点会这样）
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_B', type: 'function', function: { name: 'scr' } }] } }] }),
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { name: 'oll', arguments: '{"direction":"down"}' } }] } }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    ];
  }
  return [
    sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '这是一个示例页面。' } }] }),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  ];
});

/** 模拟 background.js 的 agent 循环。 */
async function runLoop(providerId, config) {
  const p = PROVIDERS[providerId];
  const tools = p.buildTools(TOOL_DEFS);
  const messages = [{ role: 'user', content: '这个页面在讲什么？' }];
  let text = '', thinking = '';
  const toolLog = [];

  for (let step = 1; step <= 4; step++) {
    const r = await p.stream({
      config, system: 'SYSTEM_PROMPT_HERE', systemVolatile: '当前页面：test', messages, tools,
      onEvent: (kind, t) => { if (kind === 'thinking') thinking += t; else text += t; },
    });
    p.pushAssistant(messages, r);
    if (!r.toolCalls.length) return { text, thinking, toolLog, messages, steps: step, stopReason: r.stopReason };
    toolLog.push(...r.toolCalls);
    p.pushToolResults(messages, r.toolCalls.map((c) => ({
      id: c.id, name: c.name, output: `FAKE_${c.name}`, isError: false,
    })));
  }
  throw new Error('循环没有终止');
}

// ── Anthropic ────────────────────────────────────────────────────
s.section('Anthropic Messages API');
{
  const r = await runLoop('anthropic', {
    baseUrl: mock.url, apiKey: 'sk-test', model: 'claude-opus-5', maxTokens: 16000,
  });

  s.t('文本流式拼接正确', r.text === '我先看看页面。这是一个示例页面。', JSON.stringify(r.text));
  s.t('thinking 增量已上报', r.thinking === '先读页面', JSON.stringify(r.thinking));
  s.t('两个并行工具调用都被解析', r.toolLog.length === 2, String(r.toolLog.length));
  s.t('分片 JSON 参数拼装正确', JSON.stringify(r.toolLog[0]?.input) === '{"mode":"outline"}', JSON.stringify(r.toolLog[0]?.input));
  s.t('第二个工具参数正确', JSON.stringify(r.toolLog[1]?.input) === '{"direction":"down"}', JSON.stringify(r.toolLog[1]?.input));
  s.t('两轮后正常终止', r.steps === 2 && r.stopReason === 'end_turn', `steps=${r.steps} stop=${r.stopReason}`);

  const [req1, req2] = mock.reqs;
  s.t('tools 用 input_schema 字段', 'input_schema' in (req1.tools?.[0] ?? {}));
  s.t('system 拆成稳定段 + 变化段', Array.isArray(req1.system) && req1.system.length === 2);
  s.t('只有稳定段打缓存断点', req1.system[0].cache_control?.type === 'ephemeral' && !req1.system[1].cache_control);
  s.t('走的是流式', req1.stream === true);

  const asst = req2.messages.find((x) => x.role === 'assistant');
  const toolMsg = req2.messages[req2.messages.length - 1];
  s.t('assistant 消息 content 是数组', Array.isArray(asst?.content));
  s.t('thinking 块被原样回填（含 signature）',
    asst?.content?.some((b) => b.type === 'thinking' && b.signature === 'SIG123'),
    JSON.stringify(asst?.content?.map((b) => b.type)));
  s.t('内部记账字段没有发给 API',
    !JSON.stringify(asst?.content).includes('_parseError') && !JSON.stringify(asst?.content).includes('_json'));
  s.t('tool_use 块保留在历史里', asst?.content?.filter((b) => b.type === 'tool_use').length === 2);
  s.t('tool_use 的 input 是对象不是字符串',
    typeof asst?.content?.find((b) => b.type === 'tool_use')?.input === 'object');
  s.t('工具结果合并在同一条 user 消息里',
    toolMsg?.role === 'user' && Array.isArray(toolMsg.content) && toolMsg.content.length === 2,
    `role=${toolMsg?.role} len=${toolMsg?.content?.length}`);
  const useIds = asst?.content?.filter((b) => b.type === 'tool_use').map((b) => b.id).sort();
  const resIds = toolMsg?.content?.map((b) => b.tool_use_id).sort();
  s.t('每个 tool_use 都有配对的 tool_result',
    JSON.stringify(useIds) === JSON.stringify(resIds), `${JSON.stringify(useIds)} vs ${JSON.stringify(resIds)}`);
}

// ── OpenAI 兼容 ──────────────────────────────────────────────────
mock.reset();
s.section('OpenAI 兼容 Chat Completions');
{
  const r = await runLoop('openai', {
    baseUrl: mock.url, apiKey: 'sk-test2', model: 'deepseek-chat', maxTokens: 8192,
    temperature: 0.3, tokenParam: 'max_tokens',
  });

  s.t('文本流式拼接正确', r.text === '我先看看页面。这是一个示例页面。', JSON.stringify(r.text));
  s.t('reasoning_content 被当作 thinking 上报', r.thinking === '先读页面', JSON.stringify(r.thinking));
  s.t('两个并行工具调用都被解析', r.toolLog.length === 2, String(r.toolLog.length));
  s.t('分片 JSON 参数拼装正确', JSON.stringify(r.toolLog[0]?.input) === '{"mode":"outline"}');
  s.t('分片下发的工具名拼接正确 (scr+oll)', r.toolLog[1]?.name === 'scroll', String(r.toolLog[1]?.name));
  s.t('finish_reason 已归一化', r.stopReason === 'end_turn', String(r.stopReason));

  const [req1, req2] = mock.reqs;
  s.t('tools 是 function 包装', req1.tools?.[0]?.type === 'function' && !!req1.tools?.[0]?.function?.parameters);
  s.t('system 拼成一段放进 messages[0]', req1.messages?.[0]?.role === 'system');
  s.t('变化段也拼进去了', String(req1.messages[0].content).includes('当前页面：test'));
  s.t('temperature 已发送', req1.temperature === 0.3);
  s.t('token 参数名可切换', 'max_tokens' in req1 && !('max_completion_tokens' in req1));

  const asst = req2.messages.find((x) => x.role === 'assistant');
  const toolMsgs = req2.messages.filter((x) => x.role === 'tool');
  s.t('assistant 消息带 tool_calls', Array.isArray(asst?.tool_calls) && asst.tool_calls.length === 2);
  s.t('tool_calls.arguments 是字符串（非对象）',
    typeof asst?.tool_calls?.[0]?.function?.arguments === 'string');
  s.t('每个结果一条 role:tool 消息', toolMsgs.length === 2, String(toolMsgs.length));
  s.t('tool_call_id 一一配对',
    JSON.stringify(asst?.tool_calls?.map((c) => c.id).sort()) ===
      JSON.stringify(toolMsgs.map((t) => t.tool_call_id).sort()));
  s.t('tool 消息紧跟在 assistant 之后',
    req2.messages.indexOf(asst) + 1 === req2.messages.indexOf(toolMsgs[0]));
}

// ── 参数 JSON 解析失败 ───────────────────────────────────────────
s.section('参数 JSON 解析失败');
{
  const bad = await startMock(({ turn }) =>
    turn === 1
      ? [
          sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '点一下' } }] }),
          // 全角冒号 —— 国产模型偶尔这么吐
          sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'click', arguments: '{"ref"：1}' } }] } }] }),
          sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        ]
      : [sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })]
  );
  const p = PROVIDERS.openai;
  const r = await p.stream({
    config: { baseUrl: bad.url, apiKey: 'k', model: 'm', maxTokens: 100 },
    system: 's', messages: [{ role: 'user', content: 'hi' }],
    tools: p.buildTools(TOOL_DEFS), onEvent: () => {},
  });
  s.t('解析失败被报出来而不是静默变 {}', !!r.toolCalls[0]?.parseError, JSON.stringify(r.toolCalls[0]));
  s.t('原始参数字符串被保留（便于回给模型）',
    r.toolCalls[0]?.rawArgs === '{"ref"：1}', String(r.toolCalls[0]?.rawArgs));
  s.t('input 退化为空对象而不是崩溃', JSON.stringify(r.toolCalls[0]?.input) === '{}');
  await bad.close();
}

// ── 错误路径 ─────────────────────────────────────────────────────
s.section('错误处理');
{
  const errServer = (await import('node:http')).default.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid x-api-key' } }));
  });
  const { freePort } = await import('../helpers/env.mjs');
  const port = await freePort();
  await new Promise((r) => errServer.listen(port, '127.0.0.1', r));
  let msg = '';
  try {
    await PROVIDERS.anthropic.stream({
      config: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'bad', model: 'm', maxTokens: 100 },
      system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], onEvent: () => {},
    });
  } catch (e) { msg = e.message; }
  s.t('4xx 被转成带上下文的错误', msg.includes('401') && msg.includes('invalid x-api-key'), msg);
  // 一定要等它关完再退出：Windows 上 process.exit 撞上正在关闭的 handle
  // 会触发 libuv assertion，噪音会干扰 runner 判定
  await new Promise((r) => errServer.close(r));
}

await mock.close();
s.done();
