'use strict';
/**
 * gameDefaults.cjs —— 主进程(CJS)**同步**读取唯一真源 gameDefaults.mjs 的桥接层。
 *
 * 为什么必须同步(而不能学 providers.cjs 那样 `import()` 异步桥接):
 *   · 唯一真源是 .mjs —— 浏览器只能加载 ESM,所以厂商表/游戏默认值都得是 ESM;
 *   · 主进程是 CJS,而 src/main/config.cjs 的 DEFAULT_CONFIG 在**模块加载时**
 *     就要成型:makeStore().read() 是同步的,IPC 处理器和纯 Node 测试都直接
 *     同步调用它。
 *   · 异步桥接会留下一段「games 还没有默认值」的窗口,而 read() 恰好就在那个
 *     窗口里被调用 —— 表现是「第一次打开设置,牌桌规则全是空/0」,而且只在
 *     启动时序里复现(最难查的那种)。
 *
 * 做法:把真源读进来、去掉行首的 `export ` 关键字,用 new Function 求值一遍。
 *   ⚠️ 因此 gameDefaults.mjs 里**不许**出现 import / export default / 顶层 await
 *      (见那边的头注释)。写坏了会在这里抛错 —— tools/configmigrate.mjs 有一条
 *      用例直接 require 这个桥接,所以真源写坏是**测试红**,不是用户启动时白屏。
 *   ⚠️ 这里求值的是**纯数据 + 纯函数**,没有外部输入参与,不存在注入面。
 *
 * 代价:主进程会多求值一份数据(浏览器侧走 ESM 加载)。对象很小,而且 require
 * 有缓存,只在启动时执行一次。
 */

const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, 'gameDefaults.mjs');

function load() {
  const src = fs.readFileSync(SOURCE, 'utf8');
  // 只剥 `export const` / `export function` 这两种(真源里也只允许这两种)
  const code = src.replace(/^export\s+(?=(?:const|function)\b)/gm, '');
  // 剥完还有 import/export 语句说明真源写了桥接不认识的东西 —— 直接报错,
  // 别让它带着半个模块跑(那样 DEFAULT_CONFIG 会缺字段,更难查)。
  if (/^\s*(?:import|export)\b/m.test(code)) {
    throw new Error('gameDefaults.mjs 里有同步桥接不支持的语句(import / export default / 顶层 await)');
  }
  // eslint-disable-next-line no-new-func
  return new Function(`${code}\n;return { GAME_DEFAULTS, DEFAULT_GAME_ID, gameDefaultsOf, gameDefaultsAll, gameCfg };`)();
}

let impl = null;
try {
  impl = load();
} catch (err) {
  // 真源坏了就别装作没事:默认配置缺一整层(key 全丢)比直接崩更难查。
  // 这里原样抛出去,调用方(registerIpc / 测试)会看到明确的原因。
  console.error('[gameDefaults] 加载 gameDefaults.mjs 失败:', err);
  throw err;
}

const { GAME_DEFAULTS, DEFAULT_GAME_ID, gameDefaultsOf, gameDefaultsAll, gameCfg } = impl;

module.exports = { GAME_DEFAULTS, DEFAULT_GAME_ID, gameDefaultsOf, gameDefaultsAll, gameCfg };
