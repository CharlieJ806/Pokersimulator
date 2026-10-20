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
/* 回合边界:「第 N 天结束 →」要**比平时更显眼**,否则观众一眼扫不到就以为没变化。
   只改颜色不动位置 —— 标签一挪,顶栏在手机上就要重排(那里每 1px 都是挤出来的)。 */
.ww__tag.is-boundary {
  color: var(--gold); border-color: rgba(196, 162, 88, .55);
  background: rgba(196, 162, 88, .12);
}
.ww__topBtns { display: flex; gap: 8px; }
/* 节奏按钮:「⏸ 暂停 / ⏭ 下一回合 / ▶ 继续」—— 图标与文字分两段,
   手机横屏只留图标(见 theme.js 末尾的移动端块) */
.ww__paceLabel { white-space: nowrap; }

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

/* 玩家模式:左上角是「我的身份」卡,积分榜整块往下让一格。
   用 class 而不是 inline style —— 桌面要让 146px、手机横屏只要让 96px,
   inline 样式会把媒体查询整条压死(_render 里只切 .is-join)。 */
.ww.is-join .ww__score { top: 146px; }

/* ════════════════════════════════════════════════════════════════════
 * 手机横屏(主目标)
 *
 * 断点与 web/mobile.css 完全同一套(那个文件解释了为什么用 height 而不是宽度):
 *   主目标 「(orientation: landscape) and (max-height: 500px)」
 *   → 实测三个目标尺寸 956×440 / 852×393 / 800×360 全部命中。
 *   次目标 「(max-width: 820px)」/「(max-width: 520px)」是竖屏与小屏兜底。
 *
 * 策略直接抄扑克那份(mobile.css 顶部注释),只是把「侧栏 + 手牌一览」换成
 * 这里的「上帝面板 / 时间线 / 现场记录」:
 *   1. 顶栏三区定宽:右侧按钮钉死不压缩,左侧信息可压缩 + 省略号;
 *   2. 面板全部退到四角,中间横带留给 3D 牌桌(桌心永远不被盖住);
 *   3. 可点元素保底 40px;说明性文案(不是操作本身)在手机上省掉。
 *
 * 实测约束(最紧的 800×360):
 *   顶栏 40;上帝面板 top 46 + 40vh(144)→ 底边 190;
 *   时间线 bottom 8 + 26vh(94)→ 顶边 258;现场记录 bottom 8 + 24vh(86)→ 顶边 266。
 * 数字全部由 tools/mobilegameshots.mjs 每轮实测断言(越界/重叠/溢出直接红)。
 * ════════════════════════════════════════════════════════════════════ */
@media (orientation: landscape) and (max-height: 500px) {
  .ww__top {
    height: 40px; min-height: 40px;
    padding: 0 8px; gap: 6px;
    align-items: center; flex-wrap: nowrap;
    overflow: hidden;
  }
  .ww__brand { flex: 1 1 auto; min-width: 0; overflow: hidden; gap: 6px; }
  .ww__title { display: none; }          /* 手机横屏:品牌名收益最低,先让位 */
  .ww__brand > * {
    flex: 0 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #wwDayTag, #wwPhaseTag { flex: 0 0 auto; }   /* 天数/阶段是回合推进的主要反馈 */
  .ww__tag { font-size: 11px; padding: 2px 7px; }
  .ww__topBtns { flex: 0 0 auto; min-width: max-content; gap: 4px; }
  .ww__topBtns .btn { min-height: 40px; min-width: 40px; padding: 0 8px; font-size: 12px; white-space: nowrap; }
  .ww__paceLabel { display: none; }      /* 节奏按钮在手机上只留图标 */

  .ww__god {
    right: 8px; top: 46px;
    width: min(44vw, 400px); max-height: 40vh;
    padding: 7px 9px; border-radius: 12px;
  }
  .ww__score {
    left: 8px; right: auto; top: 46px;
    width: min(30vw, 240px); max-height: 26vh;
    padding: 7px 9px; border-radius: 12px;
  }
  /* 玩家模式:左上角被「我的身份」卡占了(约 96px 高),积分榜跟着往下让 */
  .ww.is-join .ww__score { top: calc(46px + 96px + 6px); }
  .ww__panelHead > span:first-child { font-size: 11.5px; }
  .ww__panelHint { font-size: 10px; }
  .ww__table { font-size: 11px; }
  .ww__table th { padding: 2px 3px; }
  .ww__table td { padding: 3px; }
  .ww__say { max-width: 30vw; }
  .ww__nightActs { font-size: 10.5px; }

  .ww__me { left: 8px; top: 46px; padding: 7px 12px; border-radius: 12px; }
  .ww__meLabel { font-size: 10px; }
  .ww__meRole { font-size: 18px; }
  .ww__meHint { font-size: 11px; max-width: 44vw; }

  .ww__feed {
    left: 8px; bottom: 8px;
    width: min(50vw, 460px); max-height: 26vh;
    padding: 6px 8px; border-radius: 12px;
  }
  .ww__feedHead { font-size: 11px; margin-bottom: 2px; }
  .ww__item { font-size: 11px; line-height: 1.45; padding: 2px 0; }

  .ww__side {
    right: 8px; bottom: 8px;
    width: min(32vw, 260px); max-height: 24vh;
    border-radius: 12px;
  }
  .ww__sideHead { font-size: 11px; padding: 4px 8px; }
  .ww__log { padding: 4px 8px; font-size: 11px; line-height: 1.45; }

  /* 「天黑请闭眼」:手机上挪到左边空地上,别压住右边那块面板 */
  .ww__nightHead { left: 26%; top: 16%; }
  .ww__nightHead b { font-size: 20px; letter-spacing: .12em; }
  .ww__nightHead span { font-size: 11px; }

  .ww__action {
    left: 50%; bottom: 6px; transform: translateX(-50%);
    width: min(94vw, 720px);
    padding: 6px 10px; border-radius: 12px;
  }
  .ww__actHead { font-size: 12px; margin-bottom: 4px; }
  .ww__actNote { display: none; }        /* 说明性文案:省掉一行高度 */
  .ww__actRow { gap: 6px; }
  .ww__input { min-height: 40px; font-size: 13px; padding: 6px 8px; }
  /* ⚠️ min-width 也要给:单个汉字的按钮(「说」)只有 35px 宽,手指点不准 */
  .ww__action .btn { min-height: 40px; min-width: 44px; padding: 0 10px; font-size: 12.5px; white-space: nowrap; }
  .ww__voteBtn { min-height: 40px; min-width: 64px; font-size: 12.5px; }

  /* ★ 玩家操作时,底部那一条要留给操作区(时间线/现场记录往上让)。
     ⚠️ 让多少**不写死**:屏幕那边在操作区出现时量一次高度写进 --ww-act-h
        (与扑克的 --actionbar-h 同一个做法)。写死数字的后果实测过:
        操作区 74~131px 高不等,按 118px 让 → 有的回合被压住 19px。 */
  .ww.is-acting .ww__feed {
    bottom: calc(var(--ww-act-h, 74px) + 10px);
    width: min(44vw, 440px); max-height: 18vh;
  }
  .ww.is-acting .ww__side { bottom: calc(var(--ww-act-h, 74px) + 10px); max-height: 18vh; }

  .ww__banner { padding: 12px 22px; max-width: 88vw; }
  .ww__banner b { font-size: 20px; }
  .ww__banner span { font-size: 12px; }
  .ww__lobbyCard {
    width: min(94vw, 620px); max-height: calc(100vh - 12px);
    overflow: auto; padding: 12px 16px; border-radius: 16px;
  }
  .ww__fields { gap: 8px; margin: 8px 0; }
  .ww__field select { min-height: 40px; }
  .ww__lobbyBtns .btn { min-height: 40px; }
}

/* 竖屏 / 小屏兜底:同一套策略,不追求四角摆放(竖屏高度足够)。
   ⚠️ 必须加 min-height:501px —— 800×360 这类横屏手机**同时**命中 820 那条,
      而它写在后面(同优先级后写者赢),会把横屏那套算过的 max-height 全顶回去。 */
@media (max-width: 820px) and (min-height: 501px) {
  .ww__top { flex-wrap: nowrap; overflow: hidden; }
  .ww__brand { flex: 1 1 auto; min-width: 0; overflow: hidden; }
  .ww__brand > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ww__topBtns { flex: 0 0 auto; min-width: max-content; }
  .ww__topBtns .btn { min-height: 40px; }
  .ww__paceLabel { display: none; }
  .ww__god { width: min(300px, 54vw); max-height: 40vh; }
  .ww__score { width: min(260px, 46vw); max-height: 26vh; }
  .ww.is-join .ww__score { top: 150px; }
  .ww__feed { width: min(56vw, 420px); max-height: 26vh; }
  .ww__side { width: min(220px, 36vw); max-height: 22vh; }
  .ww__action { width: 94vw; }
  .ww__actNote { display: none; }
  .ww__input { min-height: 40px; }
  .ww__action .btn, .ww__voteBtn { min-height: 40px; }
  .ww.is-acting .ww__feed { bottom: calc(var(--ww-act-h, 74px) + 10px); max-height: 22vh; }
  .ww.is-acting .ww__side { bottom: calc(var(--ww-act-h, 74px) + 10px); max-height: 20vh; }
}

/* 极窄屏(普通手机竖屏) */
@media (max-width: 520px) {
  .ww__title { display: none; }
  .ww__tag { font-size: 11px; padding: 2px 6px; }
  .ww__god, .ww__me { width: 92vw; }
  .ww__score { width: 92vw; }
  .ww__feed { width: 92vw; }
  .ww__side { width: 46vw; }
}
`;
