/**
 * 狼人杀自己的样式 —— 一段 CSS 字符串,由 ui/screen.js 在挂载时注入一次。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么不写进 src/ui/styles3d.css(而卧底写进去了)
 *
 * 那个文件是**共用**的:扑克的 .screen/.topbar 与卧底的 .uc 都在里面,而且
 * 现在有并行的改动在动它。狼人杀把样式塞进同一个文件的末尾,收益只是「省一个文件」,
 * 代价是两个人同时改这个文件时必然冲突,而且删游戏时要记得去大文件里摘。
 *
 * 所以这里走另一条路:**样式跟着游戏走**,模块里导出一个字符串,挂载时注入
 * <style data-werewolf>。好处:
 *   · 加/删这个游戏只动本目录;
 *   · 前缀 .ww 与 .uc / 扑克完全不冲突;
 *   · 不用改 web 构建(样式是 JS 里带出去的,两端都一样)。
 * ⚠️ 视觉上**不另造一套**:颜色全部用 styles3d.css 里的 CSS 变量
 *    (--panel / --line / --gold / --red / --green …),圆角/阴影/字号与卧底面一致,
 *    这样三个游戏放在一起看还是同一个产品。
 */

export const WEREWOLF_CSS = `
.ww { position: relative; height: 100%; width: 100%; overflow: hidden; }
.ww__gl { position: absolute; inset: 0; width: 100%; height: 100%; display: block; z-index: 0; }

.ww__top {
  position: absolute; left: 0; right: 0; top: 0; z-index: 30;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 9px 16px;
}
.ww__brand { display: flex; align-items: center; gap: 9px; }
.ww__icon { font-size: 20px; }
.ww__title { font-weight: 800; letter-spacing: .02em; }
.ww__tag {
  font-size: 12px; padding: 3px 9px; border-radius: 999px;
  background: var(--panel); border: 1px solid var(--line); color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.ww__tag.is-night { color: #8f9ac4; border-color: rgba(143, 154, 196, .45); }
.ww__tag.is-vote { color: #7a4b9a; border-color: rgba(122, 75, 154, .4); }
.ww__topBtns { display: flex; gap: 8px; }

/* 天黑遮罩:全屏 DOM 层(不在 3D 里做 —— 见 props/werewolf 的文件头) */
.ww__nightMask {
  position: absolute; inset: 0; z-index: 8; pointer-events: none;
  background:
    radial-gradient(120% 90% at 50% 42%, rgba(10, 12, 24, .58) 0%, rgba(6, 8, 18, .9) 68%, rgba(4, 5, 12, .96) 100%);
  transition: opacity .5s ease;
}
.ww__nightMask[hidden] { display: none; }
.ww__nightHead {
  /* ⚠️ 不放在正中间:右边那张上帝面板会把它盖掉一半(实拍踩过)。
     32% 正好落在面板左边的空地上,而且不会压住桌子中央的天/夜牌。 */
  position: absolute; left: 32%; top: 13%; transform: translateX(-50%);
  text-align: center; color: #cfd6f2; text-shadow: 0 2px 18px rgba(0, 0, 0, .8);
}
.ww__nightHead b { display: block; font-size: 26px; letter-spacing: .18em; }
.ww__nightHead span { font-size: 12.5px; color: #8f9ac4; }

/* 上帝面板 / 积分榜 */
.ww__god, .ww__score {
  position: absolute; right: 14px; top: 58px; width: min(540px, 40vw);
  max-height: 54vh; overflow: auto; z-index: 15;
  background: var(--panel); border: 1px solid var(--line-2); border-radius: 14px;
  box-shadow: var(--shadow-sm); padding: 10px 12px; backdrop-filter: blur(6px);
}
.ww__score { right: auto; left: 14px; width: min(360px, 30vw); max-height: 40vh; }
.ww__panelHead { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; }
.ww__panelHead > span:first-child { font-size: 12.5px; font-weight: 700; color: var(--text); }
.ww__panelHint { font-size: 11px; color: var(--text-faint); }
.ww__table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ww__table th {
  text-align: left; font-weight: 600; color: var(--text-faint);
  padding: 3px 4px; border-bottom: 1px solid var(--line); white-space: nowrap;
}
.ww__table td { padding: 4px; border-bottom: 1px dashed var(--line); vertical-align: top; }
.ww__table tr.is-out td { opacity: .45; text-decoration: line-through; }
.ww__name { color: var(--text-dim); white-space: nowrap; }
.ww__say { color: var(--text-dim); max-width: 190px; }
.is-wolf { color: var(--red); font-weight: 700; }
.is-god { color: #2f6f9d; font-weight: 700; }
.is-good { color: var(--green); }
.ww__nightActs { margin-top: 6px; font-size: 11.5px; color: var(--text-dim); line-height: 1.6; }
.ww__nightActs b { color: #cfd6f2; }

/* 发言 / 票型时间线:两种模式都看得到(只含公开信息) */
.ww__feed {
  position: absolute; left: 14px; bottom: 14px; width: min(640px, 50vw);
  max-height: 36vh; overflow: auto; z-index: 14;
  background: var(--panel); border: 1px solid var(--line-2); border-radius: 14px;
  padding: 8px 10px; box-shadow: var(--shadow-sm); backdrop-filter: blur(6px);
}
.ww__feedHead {
  display: flex; justify-content: space-between; gap: 8px;
  font-size: 12px; font-weight: 700; color: var(--text); margin-bottom: 4px;
}
.ww__feedHead span { font-weight: 400; color: var(--text-dim); }
.ww__item { font-size: 12px; line-height: 1.55; padding: 3px 0; border-bottom: 1px dashed var(--line); }
.ww__item:last-child { border-bottom: 0; }
.ww__itemWho { font-weight: 700; color: var(--text); }
.ww__itemLow { color: var(--gold); font-style: italic; }
.ww__itemVote { color: #7a4b9a; }
.ww__itemDeath { color: var(--red); }
.ww__itemSys { color: var(--text-dim); }

/* 玩家模式:我的身份卡 */
.ww__me {
  position: absolute; left: 14px; top: 58px; z-index: 16;
  background: var(--panel); border: 1px solid var(--line-2); border-radius: 14px;
  padding: 10px 16px; box-shadow: var(--shadow-sm); backdrop-filter: blur(6px);
}
.ww__meLabel { font-size: 11.5px; color: var(--text-faint); letter-spacing: .1em; }
.ww__meRole { font-size: 26px; font-weight: 800; color: var(--gold); line-height: 1.2; }
.ww__meHint { font-size: 12px; color: var(--text-dim); max-width: 268px; }
.ww__me.is-out { opacity: .55; }

/* 现场记录 */
.ww__side {
  position: absolute; right: 14px; bottom: 14px; width: min(300px, 26vw);
  max-height: 30vh; z-index: 12; display: flex; flex-direction: column;
  background: var(--panel); border: 1px solid var(--line-2); border-radius: 14px;
  overflow: hidden; box-shadow: var(--shadow-sm);
}
.ww__sideHead {
  font-size: 12px; font-weight: 700; padding: 6px 10px;
  border-bottom: 1px solid var(--line); color: var(--text-dim);
}
.ww__log { overflow: auto; padding: 6px 10px; font-size: 12px; line-height: 1.5; }
.ww__logLine { color: var(--text); }
.ww__logLine.is-warn { color: #7a5a1e; }
.ww__logLine.is-err { color: var(--red); }
.ww__logLine.is-ok { color: var(--green); }

/* 玩家操作区:发言输入 / 投票按钮 / 夜间行动 */
.ww__action {
  position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%);
  z-index: 32; width: min(760px, 92vw);
  background: var(--panel); border: 1px solid var(--line-2); border-radius: 14px;
  box-shadow: var(--shadow); padding: 10px 14px;
}
.ww__action[hidden] { display: none; }
.ww__actHead { font-size: 12.5px; font-weight: 700; margin-bottom: 6px; }
.ww__actRow { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.ww__actNote { font-size: 11.5px; color: var(--text-faint); margin-top: 4px; }
.ww__input {
  flex: 1; min-width: 180px; padding: 8px 10px; border-radius: 10px;
  border: 1px solid var(--line-2); background: var(--input-bg, rgba(255,255,255,.06));
  color: var(--text); font-size: 13px;
}
.ww__voteBtn { font-variant-numeric: tabular-nums; }

/* 大厅 */
.ww__lobby {
  position: absolute; inset: 0; z-index: 40; display: flex;
  align-items: center; justify-content: center;
  background: rgba(8, 10, 18, .55); backdrop-filter: blur(3px);
}
.ww__lobby[hidden] { display: none; }
.ww__lobbyCard {
  width: min(560px, 92vw); background: var(--panel);
  border: 1px solid var(--line-2); border-radius: 18px; box-shadow: var(--shadow);
  padding: 18px 20px;
}
.ww__lobbyHead { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 12px; }
.ww__lobbyIcon { font-size: 30px; }
.ww__lobbyHead h2 { margin: 0; font-size: 19px; }
.ww__lobbySub { font-size: 11px; letter-spacing: .16em; color: var(--text-faint); font-weight: 500; }
.ww__lobbyHead p { margin: 6px 0 0; font-size: 12.5px; color: var(--text-dim); }
.ww__fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; }
.ww__field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-dim); }
.ww__field select {
  padding: 7px 9px; border-radius: 10px; border: 1px solid var(--line-2);
  background: var(--input-bg, rgba(255,255,255,.06)); color: var(--text); font-size: 13px;
}
.ww__lobbyBtns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
.ww__lobbyNote { margin: 10px 0 0; font-size: 11.5px; color: var(--text-faint); min-height: 15px; }

/* 结算横幅 */
.ww__banner {
  position: absolute; left: 50%; top: 46%; transform: translate(-50%, -50%);
  z-index: 34; text-align: center; padding: 16px 26px; border-radius: 16px;
  background: rgba(10, 12, 20, .86); border: 1px solid var(--line-2);
  box-shadow: var(--shadow); color: var(--text); max-width: min(620px, 88vw);
}
.ww__banner[hidden] { display: none; }
.ww__banner b { display: block; font-size: 24px; letter-spacing: .08em; margin-bottom: 6px; }
.ww__banner span { font-size: 12.5px; color: var(--text-dim); }
`;
