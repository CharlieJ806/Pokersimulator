/**
 * 对局快照的**存储适配器**:把「这串快照文本放到哪」这件事,
 * 收敛成两端**行为完全一致**的四个方法。
 *
 * ── 两端的差异在哪、怎么抹平的 ───────────────────────────────────────
 *   桌面版(Electron):渲染进程没有 fs,走 preload 的 IPC →
 *                      主进程(src/main/config.cjs 的 game:*)写到 userData/game.json。
 *   网页版(浏览器)  :localStorage,键 poker-dealer/game/v1。
 *
 * 差别只有「去哪儿」,返回值形状与错误处理必须一样,否则又会出现
 * 「网页版能续上、桌面版一刷新就没了」这类只在一边复现的问题。
 * 所以四个方法统一返回 `{ ok:boolean, error?:string, ... }`,**任何异常都不外抛**:
 * 存档失败绝不能把牌局本身搞崩(最坏情况是丢一局的续玩能力,不能是白屏)。
 *
 * ── 为什么有**同步**通道(syncGame / syncReadGame)────────────────────
 * 页面被系统回收前最后能跑的那段代码(visibilitychange→hidden、pagehide)
 * 之后不一定还有机会执行回调 —— Promise / IPC invoke 这种异步路径可能永远不落地。
 * localStorage 本来就是同步的;Electron 那边用 ipcRenderer.sendSync(同步阻塞、
 * 拿得到返回值),两条路径在 renderer 侧的表现就一致了。
 * ⚠️ sendSync 会阻塞渲染进程,只在**即将被回收**时用,不要放进常规保存路径。
 */

// ⚠️ 路径是 ../shared/gameStore.js(buildweb 的「相对 import 必须能解析到文件」那一步会拦):
//    gameStore.js 归在 core/ 下(它只依赖引擎,不依赖任何 UI),这里只是**读一个键名常量**,
//    不把 store 的创建逻辑拖过来 —— 免得 web 层和 core 层互相依赖。
import { SNAPSHOT_KEY } from './gameStore.js';

/* ------------------------------------------------------------ 桌面版:IPC */

/**
 * Electron 版适配器。需要 preload 暴露:
 *   getGame() / setGame(snap) / clearGame() / getGameSync() / setGameSync(snap) / clearGameSync()
 * 用「能力探测」而不是「判断是不是 Electron」:
 * 老版本的 preload 没这几个方法时,这里应该退回不存档,而不是抛
 * 「undefined is not a function」把启动流程打断。
 */
function ipcStorage(api) {
  const hasSync = typeof api.getGameSync === 'function' && typeof api.setGameSync === 'function';
  return {
    kind: 'ipc',
    // 同步通道优先:读快照发生在**启动流程**里(要用它决定主页是不是显示
    // 「继续上一局」),拿一个 Promise 会让调用方到处 await。
    // 桌面版的实现就是读一个小 json 文件,同步读的代价可以忽略。
    // ⚠️ 老 preload 只有异步的 game:get(用 invoke),那就只能返回 Promise ——
    //    这时禁止在「页面即将被回收」的路径上用(所以 syncGame 会如实报失败)。
    readGame() {
      try {
        if (typeof api.getGameSync === 'function') return api.getGameSync() || null;
        const p = api.getGame();
        // 返回 Promise 说明是异步通道:交给调用方 await(不做假的同步化)
        if (p && typeof p.then === 'function') return p.then((v) => v || null);
        return p || null;
      } catch { return null; }
    },
    writeGame(snap) {
      try { return api.setGame(snap) || { ok: true }; } catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    clearGame() {
      // 同步版优先。删一个小文件是瞬时的,而「放弃上一局」之后用户可能马上切走 ——
      // 异步删除还没落地就被回收的话,下次启动又会冒出「继续上一局」。
      const fn = api.clearGameSync || api.clearGame;
      if (typeof fn !== 'function') return { ok: true };   // 老 preload:没得清也算成功
      try { return fn.call(api) || { ok: true }; } catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    syncGame(snap) {
      if (!hasSync) return { ok: false, error: 'preload 没有同步存档通道(老版本?)' };
      try { return api.setGameSync(snap) || { ok: true }; } catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
  };
}

/* ------------------------------------------------------------ 网页版:localStorage */

/**
 * 浏览器版适配器。
 *
 * ⚠️ 三个必须处理的坑:
 *   1. **隐私模式 / 存储被禁**:localStorage 的 getter 本身就可能抛(Safari 无痕),
 *      所以连 `globalThis.localStorage` 都要包在 try 里;
 *   2. **配额**:手机 Safari 给 localStorage 的额度不大,快照写不进去时 setItem 抛
 *      QuotaExceededError —— 这里必须接住并给出可读原因,而不是让牌局循环崩掉;
 *   3. **坏数据**:别人手工改过 / 上个版本写下的结构,JSON.parse 会抛 —— 直接当没有。
 *      (版本判定是**上层的**事:这里只负责「文本 ↔ 对象」,不做结构校验。)
 */
function localStorageStorage(ls) {
  /**
   * 真正的写入。抽成**具名函数**而不是对象方法,是因为 syncGame 要调它 ——
   * 写成 `this.writeGame` 的话,一旦这个方法被解构/传递出去
   * (store 里就是 `storage.syncGame(snap)` 直接取的,没问题;但测试或别的调用方
   * 一旦 `const { syncGame } = storage` 就 `this` 为 undefined),
   * **同步强存这条路径会静默失效** —— 而它恰恰是「页面即将被回收」时唯一的一次保存。
   */
  function writeGame(snap) {
    try {
      ls.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
      return { ok: true, path: 'localStorage' };
    } catch (err) {
      return { ok: false, error: `localStorage 写入失败:${err?.name || ''} ${err?.message || err}`.trim() };
    }
  }

  return {
    kind: 'localStorage',
    readGame() {
      try {
        const raw = ls.getItem(SNAPSHOT_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        return obj && typeof obj === 'object' ? obj : null;
      } catch {
        // 解析不了 = 等于没有。**顺手删掉**:留着只会每次启动都失败一次
        try { ls.removeItem(SNAPSHOT_KEY); } catch { /* 删不掉也不影响 */ }
        return null;
      }
    },
    writeGame,
    clearGame() {
      try { ls.removeItem(SNAPSHOT_KEY); return { ok: true }; } catch (err) { return { ok: false, error: err?.message || String(err) }; }
    },
    // localStorage 本身就是同步的 —— 与 Electron 的 sendSync 对齐
    syncGame(snap) { return writeGame(snap); },
  };
}

/** 拿不到任何存储时的兜底:全部成功但什么都不做(行为上是「不存档」,不是「报错」) */
function nullStorage(reason) {
  return {
    kind: 'none',
    reason,
    readGame() { return null; },
    writeGame() { return { ok: true, path: 'none' }; },
    clearGame() { return { ok: true }; },
    syncGame() { return { ok: true, path: 'none' }; },
  };
}

/**
 * 选一个可用的适配器。
 *
 * 优先级:**桌面 IPC 优先** —— 网页版(pokerApi.js)也会装 window.pokerAPI,
 * 但那个里面没有 getGame/setGame,探测得到 undefined,自然落到 localStorage 分支。
 * 反过来(浏览器里先判 localStorage)会让桌面版误走 localStorage 分支 ——
 * 于是「桌面版存档写在浏览器缓存里、清一下缓存就没了」,而用户以为存在配置文件旁边。
 *
 * @param {object} [win] 便于测试注入(默认 globalThis)
 */
export function resolveGameStorage(win = globalThis) {
  const api = win?.pokerAPI;
  if (api && (typeof api.getGame === 'function' || typeof api.getGameSync === 'function')) {
    return ipcStorage(api);
  }
  let ls = null;
  try {
    // 隐私模式下访问这个 getter 本身就会抛,必须包起来
    ls = win?.localStorage || null;
  } catch { ls = null; }
  if (ls && typeof ls.getItem === 'function') return localStorageStorage(ls);
  return nullStorage('这个环境没有可用的本地存储(桌面版 preload 没接上 / 浏览器禁用了存储)');
}

export { SNAPSHOT_KEY };
