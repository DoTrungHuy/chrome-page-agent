// 供应商适配层。
//
// Agent 循环（background.js）只认下面这个统一接口，完全不知道底下是哪家：
//
//   buildTools(defs)                    -> 该厂商格式的 tools 数组
//   stream({config, system, messages, tools, onEvent, signal})
//                                       -> { text, toolCalls, stopReason, raw }
//   pushAssistant(messages, result)     -> 把助手这一轮写回历史
//   pushToolResults(messages, results)  -> 把工具结果写回历史
//
// toolCalls: [{ id, name, input }]      input 已经 JSON.parse 好
// results:   [{ id, name, output, isError }]
//
// 加新厂商 = 在 PROVIDERS 里加一项，其他文件一行都不用改。

import { sseData, assertOk } from './sse.js';

const ANTHROPIC_VERSION = '2023-06-01';

// ─────────────────────────────────────────────────────────────────────
// Anthropic Messages API
// ─────────────────────────────────────────────────────────────────────

const anthropic = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  defaultBaseUrl: 'https://api.anthropic.com',
  defaultModel: 'claude-opus-5',

  buildTools(defs) {
    return defs.map((d) => ({
      name: d.name,
      description: d.description,
      input_schema: d.schema,
    }));
  },

  async stream({ config, system, systemVolatile, messages, tools, onEvent, signal }) {
    const res = await fetch(`${trimSlash(config.baseUrl)}/v1/messages`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        // 扩展的 Service Worker 靠 host_permissions 拿到跨域豁免，正常不需要
        // 这个头；但它是浏览器上下文直连的官方开关，带上无害。
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        stream: true,
        // 稳定部分打缓存断点；当前页面这类每轮都变的信息放在断点之后，
        // 否则每轮都会让缓存失效。
        system: system
          ? [
              { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
              ...(systemVolatile ? [{ type: 'text', text: systemVolatile }] : []),
            ]
          : undefined,
        tools: tools?.length ? tools : undefined,
        messages,
      }),
    });
    await assertOk(res, this.label);

    // content 块按 index 累积。thinking 块也要留着——回填历史时必须原样带上。
    const blocks = [];
    let stopReason = null;

    for await (const data of sseData(res)) {
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }

      switch (ev.type) {
        case 'content_block_start': {
          const cb = ev.content_block || {};
          if (cb.type === 'text') blocks[ev.index] = { type: 'text', text: '' };
          else if (cb.type === 'tool_use')
            blocks[ev.index] = { type: 'tool_use', id: cb.id, name: cb.name, _json: '' };
          else if (cb.type === 'thinking')
            blocks[ev.index] = { type: 'thinking', thinking: '', signature: '' };
          else blocks[ev.index] = { ...cb };
          break;
        }
        case 'content_block_delta': {
          const b = blocks[ev.index];
          const d = ev.delta || {};
          if (!b) break;
          if (d.type === 'text_delta') {
            b.text += d.text;
            onEvent('text', d.text);
          } else if (d.type === 'input_json_delta') {
            b._json += d.partial_json;
          } else if (d.type === 'thinking_delta') {
            b.thinking += d.thinking;
            onEvent('thinking', d.thinking);
          } else if (d.type === 'signature_delta') {
            b.signature += d.signature;
          }
          break;
        }
        case 'content_block_stop': {
          const b = blocks[ev.index];
          if (b?.type === 'tool_use') {
            const p = parseArgs(b._json);
            b.input = p.input;
            b._parseError = p.parseError;
            b._raw = p.raw;
          }
          break;
        }
        case 'message_delta':
          stopReason = ev.delta?.stop_reason ?? stopReason;
          break;
        case 'error':
          throw new Error(ev.error?.message || 'Anthropic 流式响应出错');
      }
    }

    const content = blocks.filter(Boolean);
    // 回填历史时要干净的块，内部记账字段（_json/_parseError/_raw）不能发给 API
    const clean = content.map((b) => {
      if (b.type !== 'tool_use') return b;
      const { _json, _parseError, _raw, ...rest } = b;
      return rest;
    });
    return {
      text: content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
      toolCalls: content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id, name: b.name, input: b.input || {},
          parseError: b._parseError, rawArgs: b._raw,
        })),
      stopReason,
      raw: clean,
    };
  },

  pushAssistant(messages, result) {
    // 整个 content 数组原样回填，含 thinking 块——不能只取文本。
    messages.push({ role: 'assistant', content: result.raw });
  },

  pushToolResults(messages, results) {
    // 所有结果必须放进同一条 user 消息里，拆开会让模型以后不再并行调工具。
    messages.push({
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: r.output,
        ...(r.isError ? { is_error: true } : {}),
      })),
    });
  },
};

// ─────────────────────────────────────────────────────────────────────
// OpenAI 兼容 Chat Completions
// 覆盖 OpenAI / DeepSeek / Kimi / 通义 / 智谱 / OpenRouter / Ollama / vLLM …
// ─────────────────────────────────────────────────────────────────────

const openai = {
  id: 'openai',
  label: 'OpenAI 兼容',
  defaultBaseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-4o',

  buildTools(defs) {
    return defs.map((d) => ({
      type: 'function',
      function: { name: d.name, description: d.description, parameters: d.schema },
    }));
  },

  async stream({ config, system, systemVolatile, messages, tools, onEvent, signal }) {
    // 新一代推理模型（o1/o3/gpt-5 等）只认 max_completion_tokens，
    // 在设置页可切换。
    const tokenParam = config.tokenParam || 'max_tokens';
    // OpenAI 格式的 system 只能是一段文本，直接拼在一起
    const sys = [system, systemVolatile].filter(Boolean).join('\n\n');

    const res = await fetch(`${trimSlash(config.baseUrl)}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        stream: true,
        [tokenParam]: config.maxTokens,
        // OpenAI 格式里 system 是 messages 的第一条，不是顶层字段。
        messages: sys ? [{ role: 'system', content: sys }, ...messages] : messages,
        tools: tools?.length ? tools : undefined,
        tool_choice: tools?.length ? 'auto' : undefined,
        ...(config.temperature != null ? { temperature: config.temperature } : {}),
      }),
    });
    await assertOk(res, this.label);

    let text = '';
    let finish = null;
    const calls = new Map(); // index -> { id, name, args }

    for await (const data of sseData(res)) {
      if (data === '[DONE]') break;
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev.error) throw new Error(ev.error.message || 'OpenAI 兼容端点返回错误');

      const choice = ev.choices?.[0];
      if (!choice) continue;
      const d = choice.delta || {};

      // DeepSeek-R1 等会把思维链放在 reasoning_content 里
      if (d.reasoning_content) onEvent('thinking', d.reasoning_content);
      if (d.content) {
        text += d.content;
        onEvent('text', d.content);
      }

      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? 0;
        const cur = calls.get(i) || { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(i, cur);
      }

      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);

    const raw = { role: 'assistant', content: text || null };
    if (ordered.length) {
      raw.tool_calls = ordered.map((c, i) => ({
        // 少数兼容端点不下发 id，自己补一个，否则结果回填时对不上
        id: c.id || `call_${i}_${Date.now()}`,
        type: 'function',
        function: { name: c.name, arguments: c.args || '{}' },
      }));
    }

    return {
      text,
      toolCalls: (raw.tool_calls || []).map((c) => {
        const p = parseArgs(c.function.arguments);
        return {
          id: c.id, name: c.function.name, input: p.input,
          parseError: p.parseError, rawArgs: p.raw,
        };
      }),
      stopReason: normalizeFinish(finish),
      raw,
    };
  },

  pushAssistant(messages, result) {
    messages.push(result.raw);
  },

  pushToolResults(messages, results) {
    // OpenAI 格式是一个结果一条 tool 消息
    for (const r of results) {
      messages.push({ role: 'tool', tool_call_id: r.id, content: r.output });
    }
  },
};

// ─────────────────────────────────────────────────────────────────────

export const PROVIDERS = { anthropic, openai };

/** 设置页的预设，选中后自动填 baseUrl / model 占位。 */
export const PRESETS = [
  { name: 'Anthropic Claude',   provider: 'anthropic', baseUrl: 'https://api.anthropic.com',                              model: 'claude-opus-5' },
  { name: 'OpenAI',             provider: 'openai',    baseUrl: 'https://api.openai.com/v1',                              model: 'gpt-4o' },
  { name: 'DeepSeek',           provider: 'openai',    baseUrl: 'https://api.deepseek.com/v1',                            model: 'deepseek-chat' },
  { name: 'Kimi / Moonshot',    provider: 'openai',    baseUrl: 'https://api.moonshot.cn/v1',                             model: 'kimi-k2-turbo-preview' },
  { name: '通义千问 DashScope',  provider: 'openai',    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',      model: 'qwen-max' },
  { name: '智谱 GLM',           provider: 'openai',    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',                   model: 'glm-4-plus' },
  { name: 'OpenRouter',         provider: 'openai',    baseUrl: 'https://openrouter.ai/api/v1',                           model: 'anthropic/claude-opus-4.5' },
  { name: 'Gemini (兼容层)',     provider: 'openai',    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-pro' },
  { name: '本地 Ollama',         provider: 'openai',    baseUrl: 'http://localhost:11434/v1',                              model: 'qwen3:14b' },
];

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

/**
 * 解析工具参数。解析失败**必须报出来**：以前静默返回 {}，模型收到的错误是
 * "ref 不存在"而不是"你的 JSON 格式错了"，只会往错误方向修。
 * 国产模型偶尔吐全角标点（{"ref"：3}）就会踩到。
 */
function parseArgs(json) {
  const raw = json || '';
  if (!raw.trim()) return { input: {}, raw };
  try {
    return { input: JSON.parse(raw), raw };
  } catch (e) {
    return { input: {}, raw, parseError: String(e?.message || e) };
  }
}

function normalizeFinish(f) {
  if (f === 'tool_calls') return 'tool_use';
  if (f === 'stop') return 'end_turn';
  if (f === 'length') return 'max_tokens';
  return f;
}
