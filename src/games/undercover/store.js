/**
 * 「谁是卧底」的存档槽(复用 shared/gameStore.js 的节流 / 尾写 / 校验语义)。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么不直接用 resolveGameStorage(),而要自己包一层 storage 适配器
 *
 * `resolveGameStorage()` 选中的是**全局唯一**的那个槽:桌面版 userData/game.json、
 * 网页版 localStorage['poker-dealer/game/v1']。那个槽是扑克的(一局一手牌,
 * 任何时刻只有一个「继续上一局」),卧底如果把快照写进去:
 *   · 扑克的「继续上一局」会被一份卧底的存档顶掉(反过来也一样),
 *     用户看到的是「我刚才明明在打牌,继续之后进了谁是卧底」;
 *   · 主页那一条「继续上一局(第 N 手)」的文案是扑克口径,卧底的存档套上去读不懂。
 *
 * 真正的解法是给 gameStore 加「按游戏分槽」,但那要动主进程 IPC 契约
 * (preload / config.cjs 的 game:get/set)与网页版 pokerApi,风险远大于收益。
 * 所以这一版:**卧底用自己的 localStorage 键**,两条端(桌面 / 网页)都走同一条
 * localStorage 路径 —— 行为一致,而且不会碰扑克的存档。
 * 代价如实写在这里:桌面版的卧底存档落在渲染进程的 localStorage 里,
 * 清浏览器缓存会丢(扑克那份在 userData 下不受影响)。
 *
 * 快照本体带 `game:'undercover'`,validateSnapshot 会拒绝别的游戏的存档 ——
 * 万一这个键里被塞了别的东西,也不会拿着它去恢复。
 */

import { createGameStore } from '../../shared/gameStore.js';
import { UndercoverKernel } from './engine/kernel.js';

/** 卧底自己的存档键(与 shared/gameStore.js 的 SNAPSHOT_KEY 刻意不同) */
export const UNDERCOVER_SNAPSHOT_KEY = 'poker-dealer/game/undercover/v1';

/** 拿不到 localStorage 时的兜底:全部成功但什么都不做(语义是「不存档」,不是报错) */
function nullStorage() {
  return {
    kind: 'none',
    readGame() { return null; },
    writeGame() { return { ok: true, path: 'none' }; },
    clearGame() { return { ok: true }; },
    syncGame() { return { ok: true, path: 'none' }; },
  };
}

/**
 * localStorage 适配器。形参与 shared/gameStorage.mjs 的四个方法一致
 * (readGame / writeGame / clearGame / syncGame),所以可以直接喂给 createGameStore。
 */
function localUndercoverStorage(ls) {
  function writeGame(snap) {
    try {
      // 顺手打个标记:排查时一眼看出这份数据是谁写的
      ls.setItem(UNDERCOVER_SNAPSHOT_KEY, JSON.stringify(snap));
      return { ok: true, path: 'localStorage' };
    } catch (err) {
      return { ok: false, error: `localStorage 写入失败:${err?.name || ''} ${err?.message || err}`.trim() };
    }
  }
  return {
    kind: 'localStorage-undercover',
    readGame() {
      try {
        const raw = ls.getItem(UNDERCOVER_SNAPSHOT_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        return obj && typeof obj === 'object' ? obj : null;
      } catch {
        // 解析不了 = 等于没有。顺手删掉:留着只会每次启动都失败一次
        try { ls.removeItem(UNDERCOVER_SNAPSHOT_KEY); } catch { /* 删不掉也不影响 */ }
        return null;
      }
    },
    writeGame,
    clearGame() {
      try { ls.removeItem(UNDERCOVER_SNAPSHOT_KEY); return { ok: true }; } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
    // localStorage 同步写 —— 与 shared/gameStorage 的 syncGame 语义对齐
    syncGame(snap) { return writeGame(snap); },
  };
}

/** 选一个存储适配器(注入 win 便于纯 Node 测试) */
export function resolveUndercoverStorage(win = globalThis) {
  let ls = null;
  try { ls = win?.localStorage || null; } catch { ls = null; }
  if (ls && typeof ls.getItem === 'function') return localUndercoverStorage(ls);
  return nullStorage();
}

/**
 * 建一个卧底存档器。
 * @param {{win?:object, getKernel:()=>object|null, intervalMs?:number}} opts
 * @returns {object} createGameStore() 的返回值 + 一个 loadValid() 便捷方法
 */
export function createUndercoverStore({ win = globalThis, getKernel, intervalMs } = {}) {
  const store = createGameStore({
    storage: resolveUndercoverStorage(win),
    getEngine: getKernel,
    // intervalMs 不传就用 gameStore 的默认(2000ms);卧底一轮 10~15 秒,
    // 节流窗口比一轮短得多,所以每条公开事件都能落盘,不会丢进度。
    ...(Number.isFinite(intervalMs) ? { intervalMs } : {}),
  });
  return {
    ...store,
    /**
     * 读回一份**能用**的存档:校验不通过就顺手丢掉(与 app.checkPendingSnapshot
     * 对坏档的处理一致 —— 坏档留在盘上只会每次启动都失败一次)。
     */
    loadValid() {
      const snap = store.load();
      if (!snap) return null;
      try {
        UndercoverKernel.validateSnapshot(snap);
        return snap;
      } catch {
        store.clear();
        return null;
      }
    },
  };
}
