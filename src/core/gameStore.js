/**
 * 对局快照的**存取层**(纯逻辑,不认识 DOM、不认识 Electron)。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────
 * 手机上浏览器一进后台就可能被系统回收;刷新 / 切走 / 系统杀进程都会让内存里的
 * 牌局 state 全丢。这里负责把 engine.snapshot() 落盘、启动时读回来、版本不符就丢掉。
 *
 * ── 为什么要有 storage 这一层抽象(踩过的坑)──────────────────────────
 * 这个仓库反复踩「只在一端加」的坑(见 config.cjs / pokerApi.js 里成对的注释):
 * 桌面版配置走 IPC 写 userData 下的 json,网页版走 localStorage ——
 * 如果快照在两端各写一份实现,就会出现「网页版能续上、桌面版一刷新就没了」这种
 * 只在一边复现的问题。所以这里把**行为**收敛成一份:
 *   · 本文件 —— 版本校验、节流、节流窗口、返回值形状,两端完全同一份代码;
 *   · storage 适配器 —— 只负责「把这串文本放到哪」,两端各一薄层
 *     (src/shared/gameStorage.mjs,按 window.pokerAPI 的能力自动选)。
 *
 * ── 节流为什么是必须的(不是优化,是正确性)────────────────────────────
 * 一次 action 一次写:9 人桌一手就是几十次 setItem,而 localStorage 是**同步**的 ——
 * 手机上主线程被同步 IO 占住会直接卡动画。
 * 所以:同一窗口内只写一次,窗口末尾补一次(**尾写**),另外提供一个 flush()
 * 给「即将被回收」的时刻用(见 web/main.js 的 visibilitychange / pagehide)。
 * ⚠️ 尾写不能省:不然最后一次行动后的状态会一直躺在内存里,
 *    页面被回收时丢掉的正好是**最新**的那一步(表现为「回来后退回上一个画面」)。
 */

/**
 * 存储键对局快照的键名 —— ⚠️ **必须与配置分开**。
 *
 * 配置(poker-dealer/config/v1)是用户的东西:API Key、模型分配、界面偏好;
 * 对局是**临时状态**。混在一个键里会出两个问题:
 *   1. 「清配置 / 重置配置」会把正在打的一局一起清掉;
 *   2. 配置每次 setConfig 都要把整局 5KB 的 state 重写一遍(还会让「配置变了」的
 *      同步逻辑误以为牌局也变了)。
 * 键名里的 /v1 是**给排查用的**:在开发者工具里一眼能看出这是哪个版本的数据。
 * 真正的版本判据是快照内部的 v 字段(见 engine.js 的 SNAPSHOT_VERSION)。
 */
export const SNAPSHOT_KEY = 'poker-dealer/game/v1';

/**
 * 两次真实落盘之间的最小间隔(毫秒)。
 * 2000 的来源:一次快照约 5~6 KB,手机上 localStorage.setItem 大致是 0.1~1ms 级别,
 * 但**序列化 + 写入**是同步的,人手点的节奏里 2 秒足够覆盖「一手打完」的粒度;
 * 再短的收益只是「少丢最后半手」,而代价是每手多写十几次。
 */
export const SAVE_INTERVAL_MS = 2000;

/**
 * 创建一个「带节流的快照存档器」。
 *
 * @param {object} opts
 * @param {object} opts.storage 存储适配器(见 src/shared/gameStorage.mjs),
 *   只要求实现 readGame / writeGame / clearGame / syncGame。
 * @param {() => (object|null)} opts.getEngine 取当前引擎 —— **函数**而不是实例:
 *   恢复 / 退出本局时引擎会被整个换掉,存实例就会抓着旧的写。
 * @param {number} [opts.intervalMs] 节流窗口,默认 SAVE_INTERVAL_MS
 * @param {() => number} [opts.now] 取「现在」(注入给测试用)
 * @param {(msg:string)=>void} [opts.onError] 写失败时的通知(默认 console.warn)
 */
export function createGameStore({ storage, getEngine, intervalMs = SAVE_INTERVAL_MS, now = () => Date.now(), onError } = {}) {
  if (!storage) throw new Error('createGameStore 需要 storage 适配器');
  if (typeof getEngine !== 'function') throw new Error('createGameStore 需要 getEngine()');

  /** 上一次**真实落盘**的时刻。用 -Infinity 让第一次调用立刻写(开局要马上有存档) */
  let lastWriteAt = -Infinity;
  let timer = null;
  let pending = false;          // 窗口内有「要写」的请求,等着尾写
  let writes = 0;               // 累计真实落盘次数(测试/排查用)
  let attempts = 0;             // 累计请求次数(节流是否生效就看 attempts 与 writes 的差)

  const warn = onError || ((msg) => console.warn('[gameStore]', msg));

  /** 真正写一次。任何异常都吞掉 —— 存档失败绝不能影响打牌 */
  function writeNow(engine) {
    attempts += 1;
    if (!engine) return { ok: false, error: '没有正在进行的牌局' };
    let snap;
    try {
      snap = engine.snapshot();
    } catch (err) {
      warn(`打快照失败:${err?.message || err}`);
      return { ok: false, error: err?.message || String(err) };
    }
    const res = storage.writeGame(snap);
    if (res?.ok) {
      writes += 1;
      lastWriteAt = now();
    } else {
      warn(`写入快照失败:${res?.error || '未知原因'}`);
    }
    return res;
  }

  /** 节流窗口结束时的补写(把窗口内最后一次状态落盘) */
  function flushTrailing() {
    timer = null;
    if (!pending) return;
    pending = false;
    writeNow(getEngine());
  }

  return {
    /**
     * 请求保存一次(节流)。
     * @returns {{ok:boolean, written:boolean, throttled?:boolean, error?:string}}
     *   written=true 表示这次真的落盘了;throttled=true 表示被窗口挡下、留给尾写。
     */
    save() {
      const engine = getEngine();
      if (!engine) return { ok: false, written: false, error: '没有正在进行的牌局' };
      const t = now();
      if (t - lastWriteAt >= intervalMs) {
        lastWriteAt = t;                     // 先占位:写的过程中别再进来
        pending = false;
        if (timer) { clearTimeout(timer); timer = null; }
        return { ...writeNow(engine), written: true };
      }
      // 窗口内:记下「还有东西要写」,等窗口过了补一次
      pending = true;
      if (!timer) timer = setTimeout(flushTrailing, Math.max(0, intervalMs - (t - lastWriteAt)));
      return { ok: true, written: false, throttled: true };
    },

    /**
     * 立刻落盘(**无视节流**)。
     *
     * 给「页面即将被回收」用:visibilitychange → hidden / pagehide / beforeunload。
     * 这三处的共同点是**之后不一定还有机会跑代码**(定时器可能永远不触发),
     * 所以必须同步写完 —— 这也是 storage.syncGame() 存在的理由。
     * ⚠️ 默认走**同步**通道:异步通道(IPC invoke / Promise)在这些时刻不保证送达。
     * @param {{sync?:boolean}} [opts] sync:false 时走异步通道(仅测试/特殊场景)
     */
    flush({ sync = true } = {}) {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = false;
      const engine = getEngine();
      if (!engine) return { ok: false, error: '没有正在进行的牌局' };

      // 同步通道优先:它才是「即将被回收」时唯一可靠的路径
      if (sync && typeof storage.syncGame === 'function') {
        attempts += 1;
        try {
          const res = storage.syncGame(engine.snapshot());
          if (res?.ok) { writes += 1; lastWriteAt = now(); }
          else warn(`同步写入快照失败:${res?.error || '未知原因'}`);
          return res;
        } catch (err) {
          warn(`同步写入快照抛错:${err?.message || err}`);
          return { ok: false, error: err?.message || String(err) };
        }
      }
      return writeNow(engine);
    },

    /**
     * 读回一份**可用**的快照。
     * 版本不符 / 结构坏 / 解析不了 → 顺手把它删掉并返回 null:
     * 坏快照留在盘上只会每次启动都报一次错,还占着「继续上一局」的入口。
     * @returns {object|null} 原样的快照对象(校验交给 engine.validateSnapshot)
     */
    load() {
      let snap = null;
      try {
        snap = storage.readGame();
      } catch (err) {
        warn(`读取快照失败:${err?.message || err}`);
        return null;
      }
      if (!snap) return null;
      return snap;
    },

    /** 丢弃快照(用户选「放弃」/ 退出本局 / 牌局打完) */
    clear() {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = false;
      lastWriteAt = -Infinity;      // 下一局的第一手要能立刻写
      const res = storage.clearGame();
      if (!res?.ok) warn(`清快照失败:${res?.error || '未知原因'}`);
      return res;
    },

    /**
     * 换了一个引擎(开新局 / 退出本局)时调用。
     * 只重置节流窗口,不动盘上的数据 —— 「退出本局」要不要删档由调用方显式决定,
     * 在这里顺手删会把「改规则重开」也变成删档。
     */
    reset() {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = false;
      lastWriteAt = -Infinity;
    },

    /** 只读统计(测试断言节流是否生效) */
    stats() { return { writes, attempts, pending, hasTimer: !!timer, lastWriteAt }; },
  };
}

/** 从快照里取一点元信息给界面用(不解析整局) */
export function snapshotInfo(snap) {
  if (!snap || typeof snap !== 'object') return null;
  const p = snap.progress || {};
  return {
    handNo: Number(p.handNo) || 0,
    street: p.street || 'idle',
    handOver: !!p.handOver,
    humanSeat: p.humanSeat ?? null,
    players: Number(p.players) || (Array.isArray(snap.state?.players) ? snap.state.players.length : 0),
    savedAt: Number(snap.savedAt) || 0,
    version: snap.v,
  };
}
