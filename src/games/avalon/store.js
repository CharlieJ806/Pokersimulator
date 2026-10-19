/**
 * 「阿瓦隆」的存档槽(复用 shared/gameStore.js 的节流 / 尾写 / 校验语义)。
 *
 * 为什么不直接用 resolveGameStorage():那是**全局唯一**的槽
 * (桌面版 userData/game.json、网页版 localStorage['poker-dealer/game/v1']),
 * 属于扑克。阿瓦隆写进去会把「继续上一局」顶掉,而且那条文案是扑克口径
 * (「第 N 手」),套到阿瓦隆上读不懂 —— 这段推理与狼人杀/卧底的 store.js 完全相同。
 *
 * 所以:阿瓦隆用自己的 localStorage 键,两端走同一条路径,不碰扑克的存档。
 * 快照本体带 `game:'avalon'`,validateSnapshot 会拒绝别的游戏的存档。
 *
 * ⚠️ 键名里那个 v1 与 SNAPSHOT_VERSION 是**两件事**:
 *    前者是「存档文件格式的代际」,后者是「快照结构版本」。
 *    结构变了只加 SNAPSHOT_VERSION(旧档会被 validateSnapshot 丢掉);
 *    只有连存储形态都要换(比如从 JSON 换成 SQLite)才动键名。
 */

import { createGameStore } from '../../shared/gameStore.js';
import { AvalonKernel } from './engine/kernel.js';

/** 阿瓦隆自己的存档键(与扑克、卧底、狼人杀的键都不同) */
export const AVALON_SNAPSHOT_KEY = 'poker-dealer/game/avalon/v1';

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

/** localStorage 适配器:形参与 shared/gameStorage.mjs 的四个方法一致 */
function localAvalonStorage(ls) {
  function writeGame(snap) {
    try {
      ls.setItem(AVALON_SNAPSHOT_KEY, JSON.stringify(snap));
      return { ok: true, path: 'localStorage' };
    } catch (err) {
      return { ok: false, error: `localStorage 写入失败:${err?.name || ''} ${err?.message || err}`.trim() };
    }
  }
  return {
    kind: 'localStorage-avalon',
    readGame() {
      try {
        const raw = ls.getItem(AVALON_SNAPSHOT_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        return obj && typeof obj === 'object' ? obj : null;
      } catch {
        // 解析不了 = 等于没有。顺手删掉:留着只会每次启动都失败一次
        try { ls.removeItem(AVALON_SNAPSHOT_KEY); } catch { /* 删不掉也不影响 */ }
        return null;
      }
    },
    writeGame,
    clearGame() {
      try { ls.removeItem(AVALON_SNAPSHOT_KEY); return { ok: true }; } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
    syncGame(snap) { return writeGame(snap); },
  };
}

/** 选一个存储适配器(注入 win 便于纯 Node 测试) */
export function resolveAvalonStorage(win = globalThis) {
  let ls = null;
  try { ls = win?.localStorage || null; } catch { ls = null; }
  if (ls && typeof ls.getItem === 'function') return localAvalonStorage(ls);
  return nullStorage();
}

/**
 * 建一个阿瓦隆存档器。
 * @param {{win?:object, getKernel:()=>object|null, intervalMs?:number}} opts
 * @returns {object} createGameStore() 的返回值 + 一个 loadValid() 便捷方法
 */
export function createAvalonStore({ win = globalThis, getKernel, intervalMs } = {}) {
  const store = createGameStore({
    storage: resolveAvalonStorage(win),
    getEngine: getKernel,
    ...(Number.isFinite(intervalMs) ? { intervalMs } : {}),
  });
  return {
    ...store,
    /**
     * 读回一份**能用**的存档:校验不通过就顺手丢掉
     * (坏档留在盘上只会每次启动都失败一次)。
     */
    loadValid() {
      const snap = store.load();
      if (!snap) return null;
      try {
        AvalonKernel.validateSnapshot(snap);
        return snap;
      } catch {
        store.clear();
        return null;
      }
    },
  };
}
