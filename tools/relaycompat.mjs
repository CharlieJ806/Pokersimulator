/**
 * 中转站兼容性回归:一个假中转站,按各家**真实的参数规则**拒绝请求,
 * 走网页版**真正的调用路径**(window.pokerAPI.llmChat → /api/llm 转发)逐个模型测。
 *
 * 为什么必须走真实路径:以前参数降级只写在 callLLMDirect(Node 测试路径)里,
 * 测试全绿、游戏里却大面积失败。这个脚本在浏览器里调 agent.callLLM,和游戏是同一条链。
 *
 * 用法: node tools/buildweb.mjs && node_modules/.bin/electron tools/relaycompat.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require('electron');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'web', 'dist');
const log = (m) => process.stdout.write(m + '\n');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg' };

/** 各家对参数的真实限制(报错措辞照抄各家实际返回) */
function validate(body) {
  const m = String(body.model || '').toLowerCase();
  const t = body.temperature;
  if (/claude/.test(m) && t > 1) return 'temperature: Input should be less than or equal to 1';
  if (/kimi|moonshot/.test(m) && t > 1) return 'invalid temperature: only 0 <= temperature <= 1 is allowed';
  if (/glm/.test(m) && t > 1) return '{"error":{"code":"1214","message":"temperature 取值范围是:(0, 1]"}}';
  if (/^(o\d|gpt-5)/.test(m)) {
    if (t !== undefined && t !== 1) return "Unsupported value: 'temperature' does not support 1.1 with this model. Only the default (1) value is supported.";
    if (body.max_tokens !== undefined) return "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.";
  }
  // 预防规则覆盖不到的「怪模型」:完全不认 temperature —— 只能靠按报错降级
  if (/strict-model/.test(m) && t !== undefined) return 'Unsupported parameter: temperature';
  if (/thinking/.test(m) && body.thinking) return 'Unrecognized request argument supplied: thinking';
  return null;
}

const seen = [];
function serve() {
  const s = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/api/llm' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const { body } = JSON.parse(raw);
        seen.push({ model: body.model, temperature: body.temperature, max_tokens: body.max_tokens, mct: body.max_completion_tokens });
        const err = validate(body);
        if (err) {
          // 与 worker/src/index.js 一致:上游非 2xx → {error:"厂商返回 400: …"}
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `厂商返回 400: ${err}`, status: 400 }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const content = JSON.stringify({ thinking: '测试一下', action: 'call' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
      return;
    }
    if (p === '/') p = '/index.html';
    const f = path.join(DIST, p);
    if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

const MODELS = [
  'deepseek-chat', 'gemini-2.5-flash', 'mimo-v2-flash', 'qwen3-max', 'grok-4',
  'claude-sonnet-4-5', 'kimi-k2-0905-preview', 'moonshot-v1-32k', 'glm-4.6',
  'gpt-5-mini', 'o4-mini', 'gpt-4o', 'strict-model-x',
];

app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.whenReady().then(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const win = new BrowserWindow({ width: 1200, height: 800, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false } });
  await win.loadURL(base);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  for (let i = 0; i < 50 && !(await js('!!window.pokerAPI')); i++) await new Promise((r) => setTimeout(r, 100));

  const results = await js(`(async () => {
    const { PokerAgent } = await import('./src/games/poker/agent.js');
    const out = [];
    for (const model of ${JSON.stringify(MODELS)}) {
      const infos = [];
      const a = new PokerAgent({ seat: 1, persona: { name: 't' } });
      a.setConfig({ providerId: 'custom', kind: 'openai', endpoint: 'https://relay.example.com/v1/chat/completions',
        apiKey: 'sk-test', model, temperature: 1.1, maxTokens: 1200, enabled: true });
      a.hooks = { onError: (e) => infos.push(e) };
      try {
        const text = await a.callLLM('sys', 'user', null);
        out.push({ model, ok: /call/.test(text), infos: infos.map((x) => x.message) });
      } catch (err) {
        out.push({ model, ok: false, err: String(err.message).slice(0, 160) });
      }
    }
    return out;
  })()`);

  let pass = 0, fail = 0;
  for (const r of results) {
    const reqs = seen.filter((x) => x.model === r.model);
    const sent = reqs.map((x) => `t=${x.temperature ?? '-'} max=${x.max_tokens ?? '-'}${x.mct ? ` mct=${x.mct}` : ''}`).join(' → ');
    if (r.ok) { pass++; log(`  ok  ${r.model.padEnd(22)} ${reqs.length} 次请求  ${sent}${r.infos?.length ? '  [' + r.infos.join('; ') + ']' : ''}`); }
    else { fail++; log(`  x   ${r.model.padEnd(22)} ${r.err || '没拿到动作'}  ${sent}`); }
  }
  log(`\n===== 中转站兼容:通过 ${pass} 个模型,失败 ${fail} 个 =====`);
  server.close();
  app.exit(fail ? 1 : 0);
}).catch((e) => { log('!! ' + (e?.stack || e)); app.exit(1); });
