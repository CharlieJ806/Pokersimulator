'use strict';
/**
 * 全局排行榜的文件存储(桌面版)。
 *
 * ── 为什么单独一个文件、而不是塞进 settings.json 或 game.json ──────────
 *   · settings.json 是**用户配置**(Key / 模型 / 设置):「重置配置」不该把战绩一起清掉。
 *   · game.json 是**一局进行中的快照**,退出/打完就删;排行榜是**长期数据**,
 *     活着的周期比任何一局都长,混在一起必然出现「打完一局顺手 clear 快照,
 *     把排行榜也清空了」。
 *   所以它写同目录下的 leaderboard.json —— 位置和 settings.json 挨着,
 *   用户点「打开配置文件夹」时一眼能看到,排查时也不用猜。
 *
 * ── 与网页版的对应关系 ──────────────────────────────────────────────
 *   网页版落在 localStorage 的 poker-dealer/leaderboard/v1;两端共同的逻辑
 *   (版本号校验、排序、权重换算)只有一份,在 src/shared/leaderboard.mjs。
 *   这里只负责「把一份已经可写的对象落到磁盘上」,不解释任何字段。
 *
 * ── 写入为什么用「临时文件 + rename」────────────────────────────────
 *   和 gameStore.cjs 同一个理由:写到一半被强杀会留下半截 JSON,
 *   下次启动就永远读不回来。先写 .tmp 再 rename 是同目录内的原子替换:
 *   要么是旧的完整内容,要么是新的完整内容。
 */

const fs = require('fs');
const path = require('path');

/** 排行榜文件大小上限。200 行 × 每行约 300 字节 ≈ 60KB;1MB 已经宽松到不可能误伤 */
const MAX_BOARD_BYTES = 1024 * 1024;

/** 文件名(与 settings.json / game.json 同目录) */
const LEADERBOARD_FILE = 'leaderboard.json';

/** 由 settings.json 的路径推出 leaderboard.json —— 永远同目录,不用调用方传两次 */
function leaderboardPathFor(configPath) {
  return path.join(path.dirname(configPath), LEADERBOARD_FILE);
}

function makeLeaderboardStore(configPath) {
  const file = leaderboardPathFor(configPath);

  /**
   * 读回排行榜。
   * 任何异常 → null(「读不回来」与「没有存过」对调用方意义相同,
   * 上层会当成空榜;版本校验也由上层做 —— 这里只负责 JSON ↔ 对象)。
   */
  function read() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : null;
    } catch {
      return null;
    }
  }

  /** 写入排行榜。返回 { ok, path } / { ok:false, error } —— **永不抛** */
  function write(board) {
    try {
      if (!board || typeof board !== 'object') return { ok: false, error: '排行榜不是对象' };
      const text = JSON.stringify(board);
      if (text.length > MAX_BOARD_BYTES) {
        return { ok: false, error: `排行榜过大(${text.length} 字节,上限 ${MAX_BOARD_BYTES})` };
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, file);          // 原子替换,见文件头注释
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /** 清空排行榜(界面上的「清空」按钮)。删不存在的文件算成功 */
  function clear() {
    try {
      fs.rmSync(file, { force: true });
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  return { read, write, clear, file };
}

module.exports = { makeLeaderboardStore, leaderboardPathFor, LEADERBOARD_FILE, MAX_BOARD_BYTES };
