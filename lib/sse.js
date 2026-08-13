// SSE (Server-Sent Events) 行解析器。两个 provider 共用。
//
// 只提取 `data:` 行的内容，其余（event: / id: / 注释 / 空行）忽略。
// 两家的 SSE 都把完整 JSON 放在 data 行里，所以这一层足够。

/**
 * @param {Response} res  fetch 的响应，body 必须是 SSE 流
 * @yields {string} 每个 data: 行的内容（已 trim）
 */
export async function* sseData(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data) yield data;
        }
      }
    }
  } finally {
    // 循环被 break（例如收到 [DONE]）或抛异常时，主动断开底层连接
    reader.cancel().catch(() => {});
  }
}

/** 把非 2xx 响应转成带上下文的错误，方便在 UI 上直接看懂。 */
export async function assertOk(res, providerLabel) {
  if (res.ok) return;
  let detail = '';
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      detail = json?.error?.message || json?.message || text;
    } catch {
      detail = text;
    }
  } catch {
    /* ignore */
  }
  throw new Error(
    `${providerLabel} 返回 ${res.status} ${res.statusText}` +
      (detail ? `\n${detail.slice(0, 600)}` : '')
  );
}
