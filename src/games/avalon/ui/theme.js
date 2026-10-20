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
/* 回合边界:「第 N 轮结束 →」要**比平时更显眼**,否则观众一眼扫不到就以为没变化。
   只改颜色不动位置 —— 标签一挪,顶栏在手机上就要重排(那里每 1px 都是挤出来的)。 */
.av__tag.is-boundary {
  color: var(--gold); border-color: rgba(196, 162, 88, .55);
  background: rgba(196, 162, 88, .12);
}
.av__topBtns { display: flex; gap: 8px; }
/* 节奏按钮:「⏸ 暂停 / ⏭ 下一回合 / ▶ 继续」—— 图标与文字分两段,
   手机横屏只留图标(见本文件末尾的移动端块) */
.av__paceLabel { white-space: nowrap; }

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

/* 玩家模式:左上角是「我的身份」卡,积分榜整块往下让一格。
   用 class 而不是 inline style —— 桌面要让 210px、手机横屏只要让 96px,
   inline 样式会把媒体查询整条压死(_render 里只切 .is-join)。 */
.av.is-join .av__score { top: 210px; }

/* ════════════════════════════════════════════════════════════════════
 * 手机横屏(主目标)
 *
 * 断点与 web/mobile.css 完全同一套:主目标
 *   「(orientation: landscape) and (max-height: 500px)」
 * → 956×440 / 852×393 / 800×360 三个实测尺寸全部命中;
 * 次目标 「(max-width: 820px)」/「(max-width: 520px)」兜竖屏与小屏。
 *
 * 策略照抄扑克那份(mobile.css 顶部注释):顶栏三区定宽、面板退到四角、
 * 中间横带留给 3D、可点元素 40px、说明性文案省掉。
 *
 * 实测约束(最紧的 800×360):
 *   顶栏 40;任务进度条 top 44(高 26)→ 70;
 *   上帝面板 top 76 + 36vh(130)→ 206;现场记录 bottom 8 + 24vh(86)→ 顶边 266;
 *   时间线 bottom 8 + 26vh(94)→ 顶边 258。数字由 tools/mobilegameshots.mjs 断言。
 * ════════════════════════════════════════════════════════════════════ */
@media (orientation: landscape) and (max-height: 500px) {
  .av__top {
    height: 40px; min-height: 40px;
    padding: 0 8px; gap: 6px;
    align-items: center; flex-wrap: nowrap;
    overflow: hidden;
  }
  .av__brand { flex: 1 1 auto; min-width: 0; overflow: hidden; gap: 6px; }
  .av__title { display: none; }          /* 手机横屏:品牌名收益最低,先让位 */
  .av__brand > * {
    flex: 0 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #avRoundTag, #avPhaseTag { flex: 0 0 auto; }   /* 轮次/阶段是回合推进的主要反馈 */
  .av__tag { font-size: 11px; padding: 2px 7px; }
  .av__topBtns { flex: 0 0 auto; min-width: max-content; gap: 4px; }
  .av__topBtns .btn { min-height: 40px; min-width: 40px; padding: 0 8px; font-size: 12px; white-space: nowrap; }
  .av__paceLabel { display: none; }      /* 节奏按钮在手机上只留图标 */

  /* 任务进度条压成一条紧贴顶栏,别把上帝面板往下挤 */
  .av__track { top: 42px; padding: 3px 10px; font-size: 11px; gap: 8px; }
  .av__dot { width: 14px; height: 14px; font-size: 9px; }
  .av__trackDots { gap: 4px; }

  .av__god {
    right: 8px; top: 76px;
    width: min(44vw, 400px); max-height: 36vh;
    padding: 7px 9px; border-radius: 12px;
  }
  .av__score {
    left: 8px; right: auto; top: 76px;
    width: min(30vw, 240px); max-height: 26vh;
    padding: 7px 9px; border-radius: 12px;
  }
  /* 玩家模式:左上角被「我的身份」卡占了(约 96px 高),积分榜跟着往下让 */
  .av.is-join .av__score { top: calc(76px + 96px + 6px); }
  .av__panelHead > span:first-child { font-size: 11.5px; }
  .av__panelHint { font-size: 10px; }
  .av__table { font-size: 11px; }
  .av__table th { padding: 2px 3px; }
  .av__table td { padding: 3px; }
  .av__say { max-width: 30vw; }
  .av__votes { font-size: 10.5px; line-height: 1.5; }

  .av__me { left: 8px; top: 76px; padding: 7px 12px; border-radius: 12px; }
  .av__meLabel { font-size: 10px; }
  .av__meRole { font-size: 18px; }
  /* 提示语最多两行:手机横屏上一行身份卡就是 85px,再长就把下面的时间线挤下去 */
  .av__meHint { font-size: 11px; max-width: 44vw; max-height: 2.6em; overflow: hidden; }

  .av__feed {
    left: 8px; bottom: 8px;
    width: min(50vw, 460px); max-height: 26vh;
    padding: 6px 8px; border-radius: 12px;
  }
  .av__feedHead { font-size: 11px; margin-bottom: 2px; }
  .av__item { font-size: 11px; line-height: 1.45; padding: 2px 0; }

  .av__side {
    right: 8px; bottom: 8px;
    width: min(32vw, 260px); max-height: 24vh;
    border-radius: 12px;
  }
  .av__sideHead { font-size: 11px; padding: 4px 8px; }
  .av__log { padding: 4px 8px; font-size: 11px; line-height: 1.45; }

  .av__action {
    left: 50%; bottom: 6px; transform: translateX(-50%);
    width: min(94vw, 720px);
    padding: 6px 10px; border-radius: 12px;
  }
  .av__actHead { font-size: 12px; margin-bottom: 4px; }
  .av__actNote { display: none; }        /* 说明性文案:省掉一行高度 */
  .av__actRow { gap: 6px; }
  .av__input { min-height: 40px; font-size: 13px; padding: 6px 8px; }
  /* ⚠️ min-width 也要给:座位号按钮之外的确定/取消很窄,手指点不准 */
  .av__action .btn { min-height: 40px; min-width: 44px; padding: 0 10px; font-size: 12.5px; white-space: nowrap; }
  /* 选座位 / 投票 / 投卡那些按钮:手机上必须点得准,统一 40px 起 */
  .av__seatBtn { min-height: 40px; min-width: 64px; font-size: 12.5px; }

  /* ★ 玩家操作时,底部那一条要留给操作区(时间线/现场记录往上让 + 收窄)。
     ⚠️ 让多少**不写死**:屏幕那边在操作区出现时量一次高度写进 --av-act-h
        (与扑克的 --actionbar-h 同一个做法)。选人 / 投票 / 投卡三种操作区高度不等,
        写死数字必然在某一档被压住(实测过 4px 压边)。
     收窄到 38vw 是给**桌心**让路:时间线占 50vw 时它的右上角正好压在桌面中间,
     3D 区看起来就只剩半张桌子。 */
  .av.is-acting .av__feed {
    bottom: calc(var(--av-act-h, 74px) + 10px);
    width: min(38vw, 420px); max-height: 16vh;
  }
  .av.is-acting .av__side { bottom: calc(var(--av-act-h, 74px) + 10px); max-height: 16vh; }

  .av__banner { padding: 12px 22px; max-width: 88vw; }
  .av__banner b { font-size: 20px; }
  .av__banner span { font-size: 12px; }
  .av__lobbyCard {
    width: min(94vw, 620px); max-height: calc(100vh - 12px);
    overflow: auto; padding: 12px 16px; border-radius: 16px;
  }
  .av__fields { gap: 8px; margin: 8px 0; }
  .av__field select { min-height: 40px; }
  .av__lobbyBtns .btn { min-height: 40px; }
}

/* 竖屏 / 小屏兜底。
   ⚠️ 必须加 min-height:501px —— 800×360 这类横屏手机**同时**命中 820 那条,
      而它写在后面(同优先级后写者赢),会把横屏那套算过的 max-height 全顶回去
      (实测:时间线按 16vh 算好,被这条的 20vh 顶回去,又压回桌面中间)。 */
@media (max-width: 820px) and (min-height: 501px) {
  .av__top { flex-wrap: nowrap; overflow: hidden; }
  .av__brand { flex: 1 1 auto; min-width: 0; overflow: hidden; }
  .av__brand > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .av__topBtns { flex: 0 0 auto; min-width: max-content; }
  .av__topBtns .btn { min-height: 40px; }
  .av__paceLabel { display: none; }
  .av__god { width: min(300px, 54vw); max-height: 38vh; }
  .av__score { width: min(240px, 44vw); max-height: 26vh; }
  .av.is-join .av__score { top: 200px; }
  .av__feed { width: min(56vw, 420px); max-height: 26vh; }
  .av__side { width: min(220px, 36vw); max-height: 22vh; }
  .av__action { width: 94vw; }
  .av__actNote { display: none; }
  .av__input { min-height: 40px; }
  .av__action .btn, .av__seatBtn { min-height: 40px; }
  .av.is-acting .av__feed { bottom: calc(var(--av-act-h, 74px) + 10px); max-height: 20vh; }
  .av.is-acting .av__side { bottom: calc(var(--av-act-h, 74px) + 10px); max-height: 18vh; }
}

/* 极窄屏(普通手机竖屏) */
@media (max-width: 520px) {
  .av__title { display: none; }
  .av__tag { font-size: 11px; padding: 2px 6px; }
  .av__god, .av__me { width: 92vw; }
  .av__score { width: 92vw; }
  .av__feed { width: 92vw; }
  .av__side { width: 46vw; }
  .av__track { font-size: 10.5px; gap: 6px; }
}
`;
