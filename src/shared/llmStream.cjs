'use strict';
/**
 * llmStream.cjs —— 给 Electron 主进程(CommonJS)用的桥接层。
 *
 * ⚠️ 唯一真源是 llmStream.mjs(纯 ESM),原因:
 *   浏览器**不能加载 .cjs**(CommonJS 的 module.exports 浏览器不认),
 *   所以共享代码必须以 ESM 形式存在。主进程是 CJS,没法直接 require ESM,
 *   于是用 Node 支持的 `import()` 动态加载一次并缓存。
 *
 * 启动路径:
 *   main.js → src/main/config.cjs → 本文件(同步 require)
 *   此时 ESM 还没加载完,所以导出的函数是「到位后自动转发」的异步壳子。
 *   registerIpc 之后会立即 await ready(),正常情况下在用户点「开始牌局」之前
 *   就已经就绪;即便没就绪,调用也只是 await 一下,不会出错。
 */

let impl = null;
const readyPromise = import('./llmStream.mjs').then((m) => {
  impl = m;
  return m;
}).catch((err) => {
  console.error('[llmStream] 共享模块加载失败:', err);
  throw err;
});

/** 等共享模块就绪(可选调用,不调用也能用) */
function ready() { return readyPromise; }

function need(name) {
  if (impl && typeof impl[name] === 'function') return impl[name];
  return null;
}

async function buildRequest(...args) {
  const f = need('buildRequest') || (await readyPromise).buildRequest;
  return f(...args);
}
async function parseSsePayload(...args) {
  const f = need('parseSsePayload') || (await readyPromise).parseSsePayload;
  return f(...args);
}
async function consumeSseBuffer(...args) {
  const f = need('consumeSseBuffer') || (await readyPromise).consumeSseBuffer;
  return f(...args);
}

module.exports = { buildRequest, parseSsePayload, consumeSseBuffer, ready };
