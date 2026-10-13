/**
 * LLM 请求构造 + 流式解析(共享,**唯一真源**)
 *
 * 为什么这份是 ESM(.mjs)而不是 CJS:
 *   浏览器不能加载 .cjs —— CommonJS 的 module.exports 浏览器不认,
 *   连 `import x from './x.cjs'` 都会报 "does not provide an export named 'default'"。
 *   所以共享代码必须以 ESM 存在。需要 CJS 的一方(Electron 主进程)
 *   通过 llmStream.cjs 用 `import()` 桥接。
 *
 * 用在哪三处:
 *   · Electron 主进程 src/main/config.cjs —— 经 llmStream.cjs 桥接;
 *   · Cloudflare Worker worker/src/index.js —— 直接 import;
 *   · 浏览器前端 web/pokerApi.js —— 直接 import。
 *   请求体怎么拼、SSE 怎么解,只在这里写一次,避免三处漂移。
 */

/** 把 spec 规范化成「请求 URL + headers + body」 */
export function buildRequest(spec, provider = {}) {
  const kind = spec.kind || provider.kind || 'openai';
  const apiKey = String(spec.apiKey || '').trim();
  let url = String(spec.endpoint || provider.endpoint || '').trim();
  if (!url) return { error: '没有配置接口地址' };
  if (!apiKey && !provider.noKey) return { error: `缺少 ${provider.name || '该厂商'} 的 API Key` };

  const headers = { 'Content-Type': 'application/json' };
  let body;

  if (kind === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    // Anthropic 默认禁止浏览器直连,这个头是官方给的开关;
    // 走 Worker 转发时其实用不到,但直连本地代理时有用,留着无害。
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    body = {
      model: spec.model,
      max_tokens: spec.maxTokens || 300,
      temperature: spec.temperature ?? 1.1,
      system: spec.system,
      messages: [{ role: 'user', content: spec.user }],
      stream: true,
    };
  } else if (kind === 'gemini') {
    const base = url.replace(/\/+$/, '');
    url = `${base}/models/${encodeURIComponent(spec.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
    body = {
      systemInstruction: { parts: [{ text: spec.system }] },
      contents: [{ role: 'user', parts: [{ text: spec.user }] }],
      generationConfig: {
        temperature: spec.temperature ?? 1.1,
        maxOutputTokens: spec.maxTokens || 300,
        responseMimeType: 'application/json',
      },
    };
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
    if (provider.id === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/local/poker-dealer-sim';
      headers['X-Title'] = 'Poker Dealer Sim';
    }
    body = {
      model: spec.model,
      messages: [
        { role: 'system', content: spec.system },
        { role: 'user', content: spec.user },
      ],
      temperature: spec.temperature ?? 1.1,
      max_tokens: spec.maxTokens || 300,
      stream: true,
    };
  }

  // 厂商特有的请求参数(例如 deepseek 关掉思维链通道)。
  // 放在最后合并,这样厂商配置说了算;调用方想覆盖也可以自己传 requestExtra。
  const extra = spec.requestExtra || provider.requestExtra;
  if (extra && typeof extra === 'object') Object.assign(body, extra);

  return { url, headers, body, kind, apiKey };
}

/**
 * 从一行 SSE `data:` 载荷里抽出增量。
 * @returns {{phase:'reasoning'|'answer', text?:string, reasoning?:string}|null}
 */
export function parseSsePayload(payload, kind) {
  if (!payload || payload === '[DONE]') return null;
  let json;
  try { json = JSON.parse(payload); } catch { return null; }

  if (kind === 'anthropic') {
    if (json.type === 'content_block_delta') {
      const d = json.delta || {};
      if (d.type === 'text_delta' && d.text) return { phase: 'answer', text: d.text };
      if (d.type === 'thinking_delta' && d.thinking) return { phase: 'reasoning', reasoning: d.thinking };
    }
    return null;
  }
  if (kind === 'gemini') {
    let text = '';
    const parts = json.candidates?.[0]?.content?.parts || [];
    for (const p of parts) if (p.text) text += p.text;
    return text ? { phase: 'answer', text } : null;
  }
  const delta = json.choices?.[0]?.delta || {};
  // 同一条 delta 里可能同时带 reasoning 和 content(阶段交界处),
  // 这种时候按「content 优先」处理,否则会把已经开始的回答又清掉。
  if (delta.content) return { phase: 'answer', text: delta.content };
  if (delta.reasoning_content) return { phase: 'reasoning', reasoning: delta.reasoning_content };
  return null;
}

/**
 * 解析一整段 SSE 文本(可能有不完整的最后一行)。
 *
 * onChunk 收到的对象(phase 表示这段增量属于哪个阶段):
 *   { phase:'reasoning', reasoning } —— 推理阶段(deepseek 的 reasoning_content、
 *                                       anthropic 的 thinking_delta)
 *   { phase:'answer',    text }      —— 正式回答
 *   { phase:'reset' }                —— 推理结束、正式回答开始。界面收到后
 *                                       应把之前的推理文本清掉,换成正式回答。
 *
 * ⚠️ reasoning 必须处理。以 deepseek-flash 为例,一次请求先流 137 字 reasoning,
 *    再流 23 字 content;只处理 content 的话整个推理阶段界面是空白的,
 *    体验退化成「等很久 → 答案突然蹦出来」。
 *
 * @param {string} buffer 累积缓冲
 * @param {string} kind 'openai' | 'anthropic' | 'gemini'
 * @param {(chunk:{phase:'reasoning'|'answer'|'reset', text?:string, reasoning?:string})=>void} onChunk
 * @returns {string} 剩余的、还没成行的尾部
 */
export function consumeSseBuffer(buffer, kind, onChunk) {
  const lines = buffer.split('\n');
  const rest = lines.pop() || '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const parsed = parseSsePayload(trimmed.slice(5).trim(), kind);
    if (parsed) onChunk(parsed);
  }
  return rest;
}
