'use strict';
/**
 * 对局快照的文件存储(桌面版)。
 *
 * ── 为什么单独一个文件、而不是塞进 settings.json ─────────────────────
 * settings.json 是**用户配置**(API Key / 模型分配 / 界面偏好),快照是**临时状态**。
 * 混在一起会有两个真问题:
 *   1. 「清配置 / 重置配置」会连正在打的一局一起清掉;
 *   2. 配置每次写盘都要把整局 state(约 5KB)重写一遍。
 * 所以快照写同目录下的 game.json —— 位置和 settings.json 挨着,
 * 用户点「打开配置文件夹」时一眼能看到,排查时也不用猜。
 *
 * ── 与网页版的对应关系 ──────────────────────────────────────────────
 * 行为必须与 web/pokerApi.js 的 localStorage 分支逐条对齐(写失败不抛错、
 * 读不回来当成没有、版本不符由上层丢弃)。差异只有「落在哪」。
 * 两端的**共同**逻辑(节流、版本校验)都在 src/core/gameStore.js 里,只有一份。
 *
 * ── 写入为什么用「临时文件 + rename」────────────────────────────────
 * 手机上被系统杀进程 / 桌面版强杀时,正写到一半的 game.json 会变成半截 JSON,
 * 下次启动就永远读不回来(而且用户不会知道为什么)。先写 .tmp 再 rename 是
 * 同目录内的原子替换:要么是旧的完整内容,要么是新的完整内容。
 */

const fs = require('fs');
const path = require('path');

/** 快照大小上限。正常一局 5~10KB(含最近 5 手公开摘要);512KB 已经宽松到不可能误伤 */
const MAX_SNAPSHOT_BYTES = 512 * 1024;

/** 快照文件名(与 settings.json 同目录) */
const GAME_FILE = 'game.json';

/** 由 settings.json 的路径推出 game.json —— 两者永远同目录,不用调用方传两次 */
function gamePathFor(configPath) {
  return path.join(path.dirname(configPath), GAME_FILE);
}

function makeGameStore(configPath) {
  const file = gamePathFor(configPath);

  /** 读回快照。任何异常 → null(「读不回来」与「没有存过」对调用方的意义是一样的) */
  function read() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : null;
    } catch {
      return null;
    }
  }

  /** 写入快照。返回 { ok, path } / { ok:false, error } —— **永不抛** */
  function write(snap) {
    try {
      if (!snap || typeof snap !== 'object') return { ok: false, error: '快照不是对象' };
      const text = JSON.stringify(snap);
      if (text.length > MAX_SNAPSHOT_BYTES) {
        return { ok: false, error: `快照过大(${text.length} 字节,上限 ${MAX_SNAPSHOT_BYTES})` };
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

  /** 删掉快照(用户选「放弃」/ 退出本局 / 牌局打完)。删不存在的文件算成功 */
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

module.exports = { makeGameStore, gamePathFor, GAME_FILE, MAX_SNAPSHOT_BYTES };
