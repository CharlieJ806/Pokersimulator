'use strict';
/**
 * providers.cjs —— 给 Electron 主进程(CommonJS)用的桥接层。
 *
 * ⚠️ 唯一真源是 providers.mjs(纯 ESM),原因:
 *   浏览器不能加载 .cjs(CommonJS 的 module.exports 浏览器不认),
 *   所以厂商表必须以 ESM 形式存在。主进程是 CJS,
 *   这里用 Node 支持的 `import()` 动态加载一次并缓存。
 *
 * 厂商表要在 registerIpc 里同步用于 llm:chat 的兜底,所以提供 ready() 供 await;
 * getProvider 这类同步查询在未就绪时返回一个安全兜底(DeepSeek 的等价默认值),
 * 就绪后自动切到真源。
 */

let impl = null;
const readyPromise = import('./providers.mjs').then((m) => {
  impl = m;
  return m;
}).catch((err) => {
  console.error('[providers] 共享模块加载失败:', err);
  throw err;
});

/** 等共享模块就绪 */
function ready() { return readyPromise; }

/** 未就绪时的最小兜底(与真源里的 deepseek 一致) */
const FALLBACK_DEEPSEEK = {
  id: 'deepseek',
  name: 'DeepSeek',
  kind: 'openai',
  endpoint: 'https://api.deepseek.com/chat/completions',
  models: ['deepseek-flash', 'deepseek-v4-pro'],
  defaultModel: 'deepseek-flash',
  keyHint: 'sk-...',
  note: '',
  signup: 'https://platform.deepseek.com',
};

function PROVIDERS() { return impl ? impl.PROVIDERS : [FALLBACK_DEEPSEEK]; }
function PROVIDER_MAP() { return impl ? impl.PROVIDER_MAP : { deepseek: FALLBACK_DEEPSEEK }; }

function getProvider(id) {
  if (impl) return impl.getProvider(id);
  return (id && id !== 'deepseek') ? (PROVIDER_MAP()[id] || FALLBACK_DEEPSEEK) : FALLBACK_DEEPSEEK;
}
function providerList() {
  return impl ? impl.providerList() : [FALLBACK_DEEPSEEK];
}
function isUsable(id, key) {
  if (impl) return impl.isUsable(id, key);
  const p = getProvider(id);
  if (!p.endpoint) return false;
  if (p.noKey) return true;
  return !!(key && key.trim());
}

module.exports = { PROVIDERS, PROVIDER_MAP, getProvider, providerList, isUsable, ready };
