/**
 * 阿瓦隆自己的样式 —— 一段 CSS 字符串,由 ui/screen.js 在挂载时注入一次。
 *
 * 为什么不写进 src/ui/styles3d.css:那个文件是**共用**的(扑克的 .screen/.topbar
 * 与卧底的 .uc 都在里面,而且一直有并行改动)。阿瓦隆把样式塞进同一个文件末尾,
 * 收益只是「省一个文件」,代价是两个人同时改必然冲突、删游戏时还要记得去大文件里摘。
 *
 * 所以照狼人杀那条路走:**样式跟着游戏走**,模块里导出一个字符串,挂载时注入
 * <style data-avalon>。加/删这个游戏只动本目录,前缀 .av 与 .ww / .uc / 扑克都不冲突。
 *
 * ⚠️ 视觉上**不另造一套**:颜色全部用 styles3d.css 里的 CSS 变量
 *    (--panel / --line / --gold / --red / --green …),圆角/阴影/字号与狼人杀一致,
 *    这样四个游戏放在一起看还是同一个产品。
 */

export const AVALON_CSS = `
.av { position: relative; height: 100%; width: 100%; overflow: hidden; }
.av__gl { position: absolute; inset: 0; width: 100%; height: 100%; display: block; z-index: 0; }

.av__top {
  position: absolute; left: 0; right: 0; top: 0; z-index: 30;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 9px 16px;
}
.av__brand { display: flex; align-items: center; gap: 9px; }
.av__icon { font-size: 20px; }
.av__title { font-weight: 800; letter-spacing: .02em; }
.av__tag {
  font-size: 12px; padding: 3px 9px; border-radius: 999px;
  background: var(--panel); border: 1px solid var(--line); color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.av__tag.is-vote { color: #7a4b9a; border-color: rgba(122, 75, 154, .4); }
.av__tag.is-mission { color: var(--red); border-color: rgba(178, 59, 59, .4); }
.av__topBtns { display: flex; gap: 8px; }

/* 任务进度条(公开信息,放在顶栏下沿):五轮 + 当前票数 */
.av__track {
  position: absolute; left: 50%; top: 50px; transform: translateX(-50%);
  z-index: 18; display: flex; align-items: center; gap: 10px;
  padding: 6px 14px; border-radius: 999px;
  background: var(--panel); border: 1px solid var(--line-2); box-shadow: var(--shadow-sm);
  font-size: 12px; color: var(--text-dim);
}
.av__trackDots { display: flex; gap: 6px; }
.av__dot {
  width: 16px; height: 16px; border-radius: 50%;
  border: 1px solid var(--line-2); background: transparent;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; color: transparent;
}
.av__dot.is-success { background: var(--green); border-color: var(--green); color: #fff; }
.av__dot.is-fail { background: var(--red); border-color: var(--red); color: #fff; }
.av__dot.is-now { border-color: var(--gold); box-shadow: 0 0 0 2px rgba(230, 201, 122, .28); }

/* 上帝面板 / 积分榜 */
.av__god, .av__score {
  position: absolute; right: 14px; top: 92px; width: min(520px, 36vw);
  max-height: 56vh; overflow: auto; z-index: 15;
  background: var(--panel); border: 1px solid var(--line-2); border-radius: 14px;
  box-shadow: var(--shadow-sm); padding: 10px 12px; backdrop-filter: blur(6px);
}
.av__score { right: auto; left: 14px; width: min(340px, 28vw); max-height: 40vh; top: 92px; }
.av__panelHead { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; }
.av__panelHead > span:first-child { font-size: 12.5px; font-weight: 700; color: var(--text); }
.av__panelHint { font-size: 11px; color: var(--text-faint); }
.av__table { width: 100%; border-collapse: collapse; font-size: 12px; }
.av__table th {
  text-align: left; font-weight: 600; color: var(--text-faint);
  padding: 3px 4px; border-bottom: 1px solid var(--line); white-space: nowrap;
}
.av__table td { padding: 4px; border-bottom: 1px dashed var(--line); vertical-align: top; }
.av__name { color: var(--text-dim); white-space: nowrap; }
.av__say { color: var(--text-dim); max-width: 200px; }
.is-evil { color: var(--red); font-weight: 700; }
.is-merlin { color: #b8862b; font-weight: 700; }
.is-good { color: var(--green); }
.av__votes { margin-top: 6px; font-size: 11.5px; color: var(--text-dim); line-height: 1.7; }
.av__votes b { color: var(--text); }
.av__yes { color: var(--green); }
.av__no { color: var(--red); }

/* 现场时间线(两种模式都看得到:只含公开信息) */
.av__feed {
  position: absolute; left: 14px; bottom: 14px; width: min(620px, 46vw);
  max-height: 30vh; overflow: auto; z-index: 14;
  background: var(--panel); border: 1px solid var(--line-2); border-radius: 14px;
  padding: 8px 10px; box-shadow: var(--shadow-sm); backdrop-filter: blur(6px);
}
.av__feedHead {
  display: flex; justify-content: space-between; gap: 8px;
  font-size: 12px; font-weight: 700; color: var(--text); margin-bottom: 4px;
}
.av__feedHead span { font-weight: 400; color: var(--text-dim); }
.av__item { font-size: 12px; line-height: 1.55; padding: 3px 0; border-bottom: 1px dashed var(--line); }
.av__item:last-child { border-bottom: 0; }
.av__itemWho { font-weight: 700; color: var(--text); }
.av__itemLow { color: var(--gold); font-style: italic; }
.av__itemVote { color: #7a4b9a; }
.av__itemQuest { color: var(--text); font-weight: 600; }
.av__itemSys { color: var(--text-dim); }
.av__itemWin { color: var(--gold); font-weight: 700; }

/* 玩家模式:我的身份卡 */
.av__me {
  position: absolute; left: 14px; top: 92px; z-index: 16;
  background: var(--panel); border: 1px solid var(--line-2); border-radius: 14px;
  padding: 10px 16px; box-shadow: var(--shadow-sm); backdrop-filter: blur(6px);
}
.av__meLabel { font-size: 11.5px; color: var(--text-faint); letter-spacing: .1em; }
.av__meRole { font-size: 26px; font-weight: 800; color: var(--gold); line-height: 1.2; }
.av__meHint { font-size: 12px; color: var(--text-dim); max-width: 268px; line-height: 1.5; }

/* 现场记录 */
.av__side {
  position: absolute; right: 14px; bottom: 14px; width: min(300px, 26vw);
  max-height: 28vh; z-index: 12; display: flex; flex-direction: column;
  background: var(--panel); border: 1px solid var(--line-2); border-radius: 14px;
  overflow: hidden; box-shadow: var(--shadow-sm);
}
.av__sideHead {
  font-size: 12px; font-weight: 700; padding: 6px 10px;
  border-bottom: 1px solid var(--line); color: var(--text-dim);
}
.av__log { overflow: auto; padding: 6px 10px; font-size: 12px; line-height: 1.5; }
.av__logLine { color: var(--text); }
.av__logLine.is-warn { color: #7a5a1e; }
.av__logLine.is-err { color: var(--red); }
.av__logLine.is-ok { color: var(--green); }

/* 玩家操作区:选人 / 投票 / 投卡 / 刺杀 */
.av__action {
  position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%);
  z-index: 32; width: min(820px, 94vw);
  background: var(--panel); border: 1px solid var(--line-2); border-radius: 14px;
  box-shadow: var(--shadow); padding: 10px 14px;
}
.av__action[hidden] { display: none; }
.av__actHead { font-size: 12.5px; font-weight: 700; margin-bottom: 6px; }
.av__actRow { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.av__actNote { font-size: 11.5px; color: var(--text-faint); margin-top: 4px; }
.av__input {
  flex: 1; min-width: 180px; padding: 8px 10px; border-radius: 10px;
  border: 1px solid var(--line-2); background: var(--input-bg, rgba(255,255,255,.06));
  color: var(--text); font-size: 13px;
}
.av__seatBtn { font-variant-numeric: tabular-nums; min-width: 74px; }
.av__seatBtn.is-on { border-color: var(--gold); color: var(--gold); }

/* 大厅 */
.av__lobby {
  position: absolute; inset: 0; z-index: 40; display: flex;
  align-items: center; justify-content: center;
  background: rgba(8, 10, 18, .55); backdrop-filter: blur(3px);
}
.av__lobby[hidden] { display: none; }
.av__lobbyCard {
  width: min(580px, 92vw); background: var(--panel);
  border: 1px solid var(--line-2); border-radius: 18px; box-shadow: var(--shadow);
  padding: 18px 20px;
}
.av__lobbyHead { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 12px; }
.av__lobbyIcon { font-size: 30px; }
.av__lobbyHead h2 { margin: 0; font-size: 19px; }
.av__lobbySub { font-size: 11px; letter-spacing: .16em; color: var(--text-faint); font-weight: 500; }
.av__lobbyHead p { margin: 6px 0 0; font-size: 12.5px; color: var(--text-dim); }
.av__fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; }
.av__field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-dim); }
.av__field select {
  padding: 7px 9px; border-radius: 10px; border: 1px solid var(--line-2);
  background: var(--input-bg, rgba(255,255,255,.06)); color: var(--text); font-size: 13px;
}
.av__lobbyBtns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
.av__lobbyNote { margin: 10px 0 0; font-size: 11.5px; color: var(--text-faint); min-height: 15px; }

/* 结算横幅 */
.av__banner {
  position: absolute; left: 50%; top: 44%; transform: translate(-50%, -50%);
  z-index: 34; text-align: center; padding: 16px 26px; border-radius: 16px;
  background: rgba(10, 12, 20, .86); border: 1px solid var(--line-2);
  box-shadow: var(--shadow); color: var(--text); max-width: min(640px, 88vw);
}
.av__banner[hidden] { display: none; }
.av__banner b { display: block; font-size: 24px; letter-spacing: .08em; margin-bottom: 6px; }
.av__banner span { font-size: 12.5px; color: var(--text-dim); }
`;
