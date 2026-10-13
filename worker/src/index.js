/**
 * Cloudflare Worker:静态站点 + LLM 转发(单文件搞定)
 *
 * ┌─ 为什么合成一个 Worker ────────────────────────────────────────┐
 * │ 前端和转发层如果分开部署,会有两个麻烦:                        │
 * │   1. 跨域(要多配 CORS);                                      │
 * │   2. 前端得知道 Worker 的地址(多一个要填的配置项)。           │
 * │ 合成一个之后:同源、零配置、一次 deploy 全搞定。                │
 * │ 静态资源走 Workers 的 assets 绑定,不消耗请求额度。             │
 * └───────────────────────────────────────────────────────────────┘
 *
 * 路由:
 *   POST /api/llm   → 转发到厂商(浏览器不能直连各家 API,跨域会被拦)
 *   GET  /api/llm   → 健康检查
 *   其他            → 静态资源(web/dist 里的前端)
 *
 * 安全:
 *   · **不存任何 API Key** —— Key 由浏览器随请求带来,用完即弃;
 *   · 只允许转发到白名单域名(从共享厂商表推导),防止被当任意代理;
 *   · 剥掉客户端伪造的 Origin / Referer / X-Forwarded-For 等头。
 */

import { PROVIDERS } from './shared/providers.mjs';

/* ------------------------------------------------------------ 白名单 */

/** 默认白名单:取自共享的厂商表,只放厂商 API 域名 */
function defaultHostAllowlist() {
  const hosts = new Set();
  for (const p of PROVIDERS) {
    if (!p.endpoint) continue;
    try { hosts.add(new URL(p.endpoint).host); } catch { /* 端点留空的自定义厂商跳过 */ }
  }
  // 从公网 Worker 转发到 127.0.0.1 没有意义(那指向 Worker 自己的回环),
  // 本地模型请在浏览器里直连(需要给 Ollama / LM Studio 开 CORS,见 README)。
  hosts.delete('127.0.0.1:11434');
  hosts.delete('127.0.0.1:1234');
  return hosts;
}

const DEFAULT_HOSTS = defaultHostAllowlist();

/** 不允许客户端自定义的请求头(否则等于让客户端伪造来源 / 绕过 CDN 保护) */
const STRIPPED_HEADERS = new Set([
  'host', 'origin', 'referer', 'connection', 'content-length',
  'accept-encoding', 'cf-connecting-ip', 'cf-ipcountry', 'x-forwarded-for',
]);

/* ------------------------------------------------------------ 工具 */

function corsHeaders(env, request) {
  const allow = String(env?.ALLOWED_ORIGINS || '').trim();
  const origin = request.headers.get('Origin') || '';
  // 同源部署时其实不需要 CORS,但保留一份以便前端放在别的域名下
  let allowOrigin = '*';
  if (allow) {
    const list = allow.split(',').map((s) => s.trim()).filter(Boolean);
    allowOrigin = list.includes(origin) ? origin : (list[0] || '*');
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

/* ------------------------------------------------------------ LLM 转发 */

async function handleLlm(request, env) {
  const cors = corsHeaders(env, request);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method === 'GET') {
    return json({
      ok: true,
      service: 'poker-dealer-llm-proxy',
      storage: '无(不存任何密钥)',
      hosts: `${DEFAULT_HOSTS.size} 个厂商域名`,
      allowedOrigins: String(env?.ALLOWED_ORIGINS || '').trim() || '任意(未限制)',
    }, 200, cors);
  }

  if (request.method !== 'POST') return json({ error: '只支持 POST' }, 405, cors);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: '请求体不是合法 JSON' }, 400, cors); }

  const { url: target, headers: rawHeaders, body } = payload || {};
  if (!target || typeof target !== 'string') return json({ error: '缺少目标地址 url' }, 400, cors);

  let targetUrl;
  try { targetUrl = new URL(target); } catch { return json({ error: `目标地址不是合法 URL: ${target}` }, 400, cors); }
  if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') {
    return json({ error: '只允许 http/https' }, 400, cors);
  }

  const extra = String(env?.EXTRA_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!DEFAULT_HOSTS.has(targetUrl.host) && !extra.includes(targetUrl.host)) {
    return json({
      error: `目标域名不在白名单里: ${targetUrl.host}`,
      hint: '自定义厂商请加到环境变量 EXTRA_ALLOWED_HOSTS(逗号分隔)',
      allowed: [...DEFAULT_HOSTS],
    }, 403, cors);
  }

  const fwdHeaders = new Headers();
  for (const [k, v] of Object.entries(rawHeaders || {})) {
    if (!k || v === undefined || v === null) continue;
    if (STRIPPED_HEADERS.has(k.toLowerCase())) continue;
    fwdHeaders.set(k, String(v));
  }
  if (!fwdHeaders.has('content-type')) fwdHeaders.set('Content-Type', 'application/json');
  fwdHeaders.set('Accept', 'text/event-stream');

  let upstream;
  try {
    upstream = await fetch(targetUrl.toString(), {
      method: 'POST', headers: fwdHeaders, body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    return json({ error: `连接厂商失败: ${err?.message || err}` }, 502, cors);
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return json({ error: `厂商返回 ${upstream.status}: ${text.slice(0, 400)}`, status: upstream.status },
      upstream.status, cors);
  }

  // 关键:显式声明 SSE 并禁用缓冲,否则中间环节会把流攒起来,
  // 前端「实时思考」就退化成「等半天一次性蹦出来」。
  const outHeaders = new Headers(cors);
  outHeaders.set('Content-Type', 'text/event-stream; charset=utf-8');
  outHeaders.set('Cache-Control', 'no-cache, no-store, no-transform');
  outHeaders.set('X-Accel-Buffering', 'no');
  return new Response(upstream.body, { status: 200, headers: outHeaders });
}

/* ------------------------------------------------------------ 入口 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/llm') return handleLlm(request, env);

    // 静态资源:交给 Workers assets(静态请求不计费、不占 Worker 调用)
    if (env?.ASSETS?.fetch) {
      return env.ASSETS.fetch(request);
    }

    // 没绑定 assets 时(例如只部署转发层),给个可读的说明
    return json({
      ok: true,
      service: 'poker-dealer-llm-proxy',
      note: '当前只启用了 LLM 转发。前端静态资源请在 wrangler.toml 里配置 [assets] directory = "../web/dist"。',
      endpoint: 'POST /api/llm',
    }, 200, corsHeaders(env, request));
  },
};
