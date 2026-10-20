/**
 * 「谁是卧底」的画面 —— 3D 桌 + HTML 面板 + 两种模式(观看 / 自己加入)。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么屏幕**自己**驱动整局(而不是像扑克那样由 app.js 一手一手地点)
 *
 * 扑克的流程是「发牌 → 一条街 → 每条街问一圈 → 摊牌」,每一步都由 app.js 的
 * playHandLoop 推着走,所以引擎和代理必须交给宿主。
 * 谁是卧底是**轮次制**的短局(描述 → 投票 → 淘汰),流程就是一个简单的循环,
 * 而且节奏、气泡、面板全绑在一起。把它拆给宿主只会让 app.js 多出一条
 * 只有卧底才走的驱动分支 —— 那正是 2b 重构要拆掉的那种耦合。
 * 所以这里:屏幕持有 kernel + runner,自己跑;宿主只提供「模型配置 / 保存设置 /
 * 打开模型面板 / 回主页」这几个回调(见 index.mjs 的 mount)。
 *
 * ────────────────────────────────────────────────────────────────
 * 信息隔离在画面上的落点(用户明确要求:**渲染前就不取**)
 *
 * 玩家模式只调 view.js 的 buildRenderView(state, {mode:'join'}) ——
 * 它返回的对象**没有**别人的词、**没有**任何人的阵营字段。这里所有 DOM/3D
 * 文本都从那一份对象取,所以不存在「先渲染再 CSS 隐藏」的路径:
 * 别人的词根本没有进入这个屏幕的数据流(道具层的 labels 里也只有自己那一个座位)。
 * 观看模式才走 buildGodView,并且**只有那一条分支**会画上帝面板。
 *
 * 3D 用的是共享场景:sceneCore(房间/桌椅/座位/立绘/相机/气泡)+ props/undercover
 * 的道具层(每人面前一张语言卡)。sceneCore 一行都没为卧底改过。
 */

import * as THREE from '../../../../vendor/three.module.js';
import { createStage, addLights, addRoom } from '../../../ui3d/sceneCore/stage.js';
import { Table3D } from '../../../ui3d/sceneCore/table.js';
import { bubbleHtml, ThinkingBubble } from '../../../ui3d/sceneCore/bubble.js';
import { UndercoverProps } from '../../../ui3d/props/undercover/wordProps.js';
import { createKernel, normalizeGuess } from '../engine/kernel.js';
import { buildRenderView, buildTableViewModel, buildScoreResult } from '../view.js';
import { UndercoverRunner } from '../runner.js';
import { createUndercoverStore } from '../store.js';
import { RoundGate, ROUND_HOLD_MS } from '../../../shared/roundGate.mjs';
import { createScoreboard, rankingHtml, matchSummary as matchSummaryOf } from '../scoring.js';
import { assignPersonas } from '../personas.js';
import { cleanSay, checkSayLeak, neutralSay } from '../filter.js';
import {
  characterForModel, assignAccents, GENERIC_CHAR, displayNameForModel, assignDisplayNames,
} from '../../../ai/portraits.js';
// 立绘预加载在 sceneCore(它是「立绘怎么画」的地方);模型→立绘的映射在 ai/portraits.js。
import { preloadPortraits } from '../../../ui3d/sceneCore/portraits2d.js';

const SELF_READ_LABEL = { civilian: '平民', undercover: '卧底', unsure: '拿不准' };
const PHASE_LABEL = { idle: '未开局', describe: '描述轮', vote: '投票轮', reveal: '公布', end: '结束' };
/** 结束原因的口语说法(结算提示与日志共用一份,别在两处各写一遍) */
const END_REASON = {
  undercoverOut: '卧底被投出',
  threshold: '卧底活到人数阈值',
  rounds: '轮次上限',
  guessRight: '卧底猜中了平民的词',
  guessMiss: '卧底猜错了平民的词',
};
/** 角色中文名(出局/结算都是公开信息) */
const ROLE_LABEL = { undercover: '卧底', civilian: '平民', blank: '白板' };

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function seatLabel(seat) { return `${Number(seat) + 1}号`; }

/** 建一块卧底屏幕(index.mjs 的 mount 用它;壳只拿返回值当通用界面句柄) */
export function createScreen(root, hooks = {}) {
  return new UndercoverScreen(root, hooks);
}

export class UndercoverScreen {
  constructor(root, hooks = {}) {
    this.root = root;
    this.hooks = hooks;
    /** 'watch' | 'join' —— 由主页第二层那张卡决定(showLobby 的参数) */
    this.mode = 'watch';
    this.humanSeat = null;
    this.kernel = null;
    this.runner = null;
    this._abort = null;
    this.running = false;
    this._pendingSnap = null;
    this._thinkingSeat = null;
    this._thinkingText = '';
    this._actionBubble = null;
    this._actionTimer = null;
    this._toastTimer = null;
    this._humanResolve = null;
    this.destroyed = false;
    /**
     * 回合之间的闸门(自动停顿 1.4s + 暂停/单步)。
     * 为什么放在屏幕这一层持有:一局重开/恢复时它要跟着新的 AbortSignal 重置,
     * 而「暂停」是观看者的一次性意图,不该跨局保留 —— 屏幕的生命周期正好对上。
     */
    this.roundGate = new RoundGate({
      holdMs: ROUND_HOLD_MS,
      onChange: (s) => this._paintPace(s),
    });
    /** 正在回合边界上(「第 N 轮结束 → 第 N+1 轮开始」),_render 用它覆盖轮次标签 */
    this._roundEnd = null;
    /**
     * 这一场的最终排名是否已经交给平台记过分。
     * 为什么要有这个闸:退出本局会走 handleExit → onExitHome → 宿主的 exitToHome
     * → 宿主再调 stopGame,最后 unmount 还会 destroy —— **同一次退出有三条路**。
     * 没有这个标记,一场会被记成三场(总分和场次都翻倍)。
     */
    this._matchRecorded = false;

    root.innerHTML = `
      <div class="uc">
        <canvas id="ucGl" class="uc__gl"></canvas>
        <div class="grid-vignette"></div>

        <header class="uc__top">
          <div class="uc__brand">
            <span class="uc__icon">🕵️</span>
            <span class="uc__title">谁是卧底</span>
            <span class="uc__tag" id="ucRoundTag">未开局</span>
            <span class="uc__tag uc__tag--phase" id="ucPhaseTag"></span>
          </div>
          <div class="uc__topBtns">
            <button class="btn btn--ghost" id="ucBtnPace" title="暂停在回合边界上,一回合一看"><span class="uc__paceIcon">⏸</span><span class="uc__paceLabel"> 暂停</span></button>
            <button class="btn btn--ghost" id="ucBtnModels">🤖 模型</button>
            <button class="btn btn--ghost" id="ucBtnSetup">⚙ 设置</button>
            <button class="btn btn--ghost" id="ucBtnExit">↩ 退出本局</button>
          </div>
        </header>

        <!-- 观看模式:上帝面板(每个人的词 / 阵营 / 自省)。玩家模式下这个元素不会出现。 -->
        <aside class="uc__god" id="ucGod" hidden></aside>

        <!-- 公开信息:描述矩阵(两种模式都看得到,它只含公开发言) -->
        <section class="uc__matrix" id="ucMatrix" hidden></section>

        <!-- 玩家模式:我的词 -->
        <section class="uc__me" id="ucMe" hidden></section>

        <!-- 侧栏:公开日志 / 过程 -->
        <aside class="uc__side" id="ucSide">
          <div class="uc__sideHead">现场记录</div>
          <div class="uc__log" id="ucLog"></div>
        </aside>

        <!-- 玩家操作区(描述输入 / 投票按钮) -->
        <footer class="uc__action" id="ucAction" hidden></footer>

        <div class="hud">${bubbleHtml()}</div>
        <div class="uc__banner" id="ucBanner" hidden></div>
        <div class="toast" id="ucToast"></div>

        <!-- 大厅 / 设置(只在点「开始」之前出现) -->
        <div class="uc__lobby" id="ucLobby" hidden>
          <div class="uc__lobbyCard">
            <div class="uc__lobbyHead">
              <span class="uc__lobbyIcon">🕵️</span>
              <div>
                <h2>谁是卧底 <span class="uc__lobbySub">UNDERCOVER</span></h2>
                <p id="ucLobbySub"></p>
              </div>
            </div>
            <div class="uc__fields">
              <label class="uc__field">人数
                <select id="ucSeats">
                  <option value="5">5 人(4 平民 + 1 卧底)</option>
                  <option value="6">6 人(5 平民 + 1 卧底)</option>
                  <option value="7">7 人</option>
                  <option value="8">8 人</option>
                  <option value="9">9 人</option>
                  <option value="10">10 人</option>
                </select>
              </label>
              <label class="uc__field">卧底人数
                <select id="ucUnder">
                  <option value="1">1 个</option>
                  <option value="2">2 个(8 人及以上推荐)</option>
                </select>
              </label>
              <label class="uc__field">白板人数
                <select id="ucBlank">
                  <option value="0">0 个(不设白板)</option>
                  <option value="1">1 个(没有词,≥7 人才可选)</option>
                </select>
              </label>
              <label class="uc__field">轮次上限
                <select id="ucRounds">
                  <option value="3">3 轮</option>
                  <option value="4">4 轮(推荐)</option>
                  <option value="5">5 轮</option>
                </select>
              </label>
              <label class="uc__field">词库难度
                <select id="ucDiff">
                  <option value="easy">简单(差别明显,好抓)</option>
                  <option value="normal">普通(同类目)</option>
                  <option value="hard">困难(近义,难分)</option>
                </select>
              </label>
            </div>
            <!-- 本场积分:同一场(这个屏幕)里连打几局会累计;离开游戏就清零。
                 只在打过至少一局之后才显示(showLobby 里控制)。 -->
            <section class="uc__rank uc__rank--lobby" id="ucLobbyRank" hidden></section>
            <div class="uc__lobbyBtns">
              <button class="btn btn--primary btn--big" id="ucStart">开始</button>
              <button class="btn btn--ghost" id="ucResume" hidden>继续上一局</button>
              <button class="btn btn--ghost" id="ucModels">🤖 模型与 API Key</button>
              <button class="btn btn--ghost" id="ucBack">← 返回主页</button>
            </div>
            <p class="uc__lobbyNote" id="ucLobbyNote"></p>
          </div>
        </div>

        <!-- 结算积分/排名:一局结束时出现(两种模式都有),点「设置」进大厅也能看到 -->
        <aside class="uc__rank uc__rank--overlay" id="ucRank" hidden></aside>
      </div>`;

    const q = (id) => root.querySelector('#' + id);
    this.dom = {
      canvas: q('ucGl'), bubble: q('bubbleEl'),
      roundTag: q('ucRoundTag'), phaseTag: q('ucPhaseTag'),
      god: q('ucGod'), matrix: q('ucMatrix'), me: q('ucMe'),
      side: q('ucSide'), log: q('ucLog'),
      action: q('ucAction'), banner: q('ucBanner'), toast: q('ucToast'),
      lobby: q('ucLobby'), lobbySub: q('ucLobbySub'), lobbyNote: q('ucLobbyNote'),
      seats: q('ucSeats'), under: q('ucUnder'), blank: q('ucBlank'), rounds: q('ucRounds'), diff: q('ucDiff'),
      start: q('ucStart'), resume: q('ucResume'),
      pace: q('ucBtnPace'),
      rank: q('ucRank'), lobbyRank: q('ucLobbyRank'),
    };
    this.personaMap = new Map();
    this.portraitMap = new Map();

    /* ---------------- 3D ---------------- */
    const stage = createStage(this.dom.canvas);
    this.THREE = THREE;
    this.renderer = stage.renderer;
    this.scene = stage.scene;
    this.camera = stage.camera;
    this._baseResize = stage.resize;
    addRoom(this.scene);
    addLights(this.scene);
    this.table = new Table3D(this.scene, {
      getPersona: (seat) => this.personaMap.get(seat),
      getPortrait: (seat) => this.portraitMap.get(seat),
    });
    // 唯一的游戏道具:每人面前一张语言卡 + 中央轮次牌(道具层契约见 sceneCore/propLayer.js)
    this.props = new UndercoverProps();
    this.table.addPropLayer(this.props);
    this.bubble = new ThinkingBubble({
      node: this.dom.bubble,
      table: this.table,
      anchorOf: (seat) => this.table.headAnchor(seat),
      rightLimit: () => Infinity,
    });
    this._tmp = new THREE.Vector3();
    this._clock = new THREE.Clock();
    this._lastW = 0;
    this._lastH = 0;
    this._camBaseY = 0;
    this._camBaseZ = 0;

    /* ---------------- 事件 ---------------- */
    q('ucBtnModels')?.addEventListener('click', () => this.hooks.onModels?.());
    q('ucBtnSetup')?.addEventListener('click', () => this.showLobby(this.mode));
    q('ucBtnExit')?.addEventListener('click', () => this.handleExit());
    q('ucBtnPace')?.addEventListener('click', () => this._onPaceClick());
    this.dom.start?.addEventListener('click', () => { this._startNew(); });
    this.dom.resume?.addEventListener('click', () => this._resume());
    q('ucModels')?.addEventListener('click', () => this.hooks.onModels?.());
    q('ucBack')?.addEventListener('click', () => this.handleExit());
    // 人数变了 → 卧底人数上限跟着变(6 人局最多 1 个,8 人局才给 2 个),
    // 白板那一档也只在 ≥7 人时才可选
    this.dom.seats?.addEventListener('change', () => this._syncUnderOptions());
    // 积分面板上的「清空积分」走**事件委托**:那块 HTML 会反复重画(大厅一次、
    // 结算一次),每次重画都去挂 listener 迟早漏一个 —— 委托在根节点上最稳。
    this.root.addEventListener('click', (ev) => {
      const btn = ev.target?.closest?.('[data-rank-reset]');
      if (btn) this._onResetRanking(btn);
    });

    this.store = createUndercoverStore({ getKernel: () => this.kernel });
    // 本场积分表:**纯内存**,和这个屏幕同生共死(见 scoring.js 的文件头)。
    this.scoreboard = createScoreboard();
    this._lastDeltas = [];
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  /* ============================================================ 大厅 */

  /** 从配置里读卧底那一格(设置的真源是 games.undercover) */
  _configValues() {
    const cfg = this.hooks.getConfig?.() || {};
    return { ...(cfg.games?.undercover || {}) };
  }

  /**
   * 人数/卧底/白板三格的联动。
   *
   * 规则只有一处(内核 normalizeConfig 也是同一套口径,这里只是别让用户选到一个
   * 会被内核悄悄改掉的档):**5~6 人只允许 1 个卧底,7 人起才允许 2 个**;
   * 白板只在 ≥7 人时可选、最多 1 个(见 gameDefaults 的 blankCount 注释)。
   */
  _syncUnderOptions() {
    const seats = Number(this.dom.seats?.value) || 6;
    const max = seats < 7 ? 1 : 2;
    for (const o of [...(this.dom.under?.options || [])]) {
      o.disabled = Number(o.value) > max;
    }
    if (Number(this.dom.under?.value) > max) this.dom.under.value = String(max);
    // 白板:人数不够就整档禁用,并把当前值收回 0(否则「5 人 + 1 白板」会被内核
    // 静默改成 0 个白板,用户会以为那个选项没生效)
    const blankOk = seats >= 7;
    for (const o of [...(this.dom.blank?.options || [])]) {
      if (Number(o.value) > 0) o.disabled = !blankOk;
    }
    if (!blankOk && Number(this.dom.blank?.value) > 0) this.dom.blank.value = '0';
  }

  /**
   * 显示大厅。`mode` 是主页那张模式卡交回来的 'dealer' | 'player'
   * (界面历史叫法;卧底内部叫 watch / join)。
   */
  showLobby(mode = 'dealer') {
    if (this.destroyed) return;
    this.mode = mode === 'player' ? 'join' : 'watch';
    const v = this._configValues();
    // 人数档位就是 <select> 里那几档(5~10)。配置里的值不在档里(手改过 / 老版本)时
    // 落到 6:不让界面显示一个不存在的选项。
    const seatOpts = [...(this.dom.seats?.options || [])].map((o) => Number(o.value));
    if (this.dom.seats) this.dom.seats.value = String(seatOpts.includes(Number(v.seats)) ? v.seats : 6);
    if (this.dom.rounds) this.dom.rounds.value = String([3, 4, 5].includes(Number(v.rounds)) ? v.rounds : 4);
    if (this.dom.diff) this.dom.diff.value = ['easy', 'normal', 'hard'].includes(v.difficulty) ? v.difficulty : 'normal';
    if (this.dom.blank) this.dom.blank.value = Number(v.blankCount) >= 1 ? '1' : '0';
    this._syncUnderOptions();
    if (this.dom.under) {
      const want = Number(v.undercoverCount) >= 2 ? 2 : 1;
      if (!this.dom.under.options[want - 1]?.disabled) this.dom.under.value = String(want);
    }
    this.dom.lobbySub.textContent = this.mode === 'join'
      ? '你也是桌上的一员:只知道自己的词,连自己是不是卧底都要靠推理猜。'
      : '你看得到每个人的词和真实阵营 —— 还有它自己猜自己是谁。它猜错的时候最好看。';
    if (this.dom.start) {
      this.dom.start.textContent = this.mode === 'join' ? '开始(我加入)' : '开始(看 AI 玩)';
    }
    // 本场积分:打过至少一局才显示(第一局之前没有排名可言)
    this._renderRanking();
    // 上一局的存档(只在同一模式下才给继续;模式不同会出现「存档里没有你」的怪局)
    this._pendingSnap = null;
    try { this._pendingSnap = this.store?.loadValid?.() || null; } catch { this._pendingSnap = null; }
    const snapOk = !!this._pendingSnap
      && ((this._pendingSnap.config?.humanSeat === null) === (this.mode === 'watch'));
    if (this.dom.resume) {
      this.dom.resume.hidden = !snapOk;
      if (snapOk) {
        const r = this._pendingSnap.progress?.handNo || 1;
        this.dom.resume.textContent = `继续上一局(第 ${r} 轮)`;
      }
    }
    this.dom.lobbyNote.textContent = this._pendingSnap && !snapOk
      ? '有一份存档,但它是另一种模式下的(观看 / 自己加入不能互换)—— 开新的一局即可。'
      : '';
    this.dom.lobby.hidden = false;
  }

  hideLobby() { this.dom.lobby.hidden = true; }

  _collect() {
    const seats = Number(this.dom.seats?.value) || 6;
    const max = seats < 7 ? 1 : 2;
    return {
      seats,
      undercoverCount: Math.max(1, Math.min(max, Number(this.dom.under?.value) || 1)),
      // 白板:人数不够时界面这一格已经是 disabled,这里再夹一次纯粹是防御
      blankCount: seats >= 7 ? (Number(this.dom.blank?.value) >= 1 ? 1 : 0) : 0,
      rounds: Number(this.dom.rounds?.value) || 4,
      difficulty: this.dom.diff?.value || 'normal',
    };
  }

  /** 建每个座位的性格、显示名、立绘 —— 与扑克同一套规则(名字跟模型走,性格另算) */
  _buildCast(seats, humanSeat) {
    const personas = assignPersonas(seats);
    const entries = [];
    for (let seat = 0; seat < seats; seat++) {
      if (seat === humanSeat) { entries.push({ seat, name: '你' }); continue; }
      const cfg = this.hooks.getAgentCfg?.(seat) || {};
      entries.push({ seat, name: displayNameForModel(cfg.providerId, cfg.model) });
    }
    const names = assignDisplayNames(entries);

    const accentEntries = [];
    this.personaMap.clear();
    for (let seat = 0; seat < seats; seat++) {
      const base = personas[seat] || assignPersonas(1)[0];
      const persona = seat === humanSeat
        ? { id: 'you', name: '你', tag: '你自己', emoji: '🙂', style: '你就是本人。', verbosity: 'normal', seed: 0 }
        : { ...base, personaName: base.name, name: names[seat] };
      this.personaMap.set(seat, persona);
      const cfg = this.hooks.getAgentCfg?.(seat) || {};
      const charId = seat === humanSeat ? GENERIC_CHAR : characterForModel(cfg.providerId, cfg.model);
      accentEntries.push({ seat, char: charId, baseAccent: undefined });
    }
    const accents = assignAccents(accentEntries);
    this.portraitMap.clear();
    for (const e of accentEntries) this.portraitMap.set(e.seat, { charId: e.char, accent: accents[e.seat] });
    try { preloadPortraits([...new Set(accentEntries.map((e) => e.char))], ['idle']); } catch { /* 立绘预热失败不影响开局 */ }
    return names;
  }

  /** 建 agents(玩家自己的座位不建 AI) */
  _buildAgents(seats, humanSeat, kernel) {
    const agents = new Map();
    for (let seat = 0; seat < seats; seat++) {
      if (seat === humanSeat) continue;
      const cfg = this.hooks.getAgentCfg?.(seat) || {};
      const persona = this.personaMap.get(seat);
      const agent = this.hooks.createAgent?.(seat, persona, cfg, {
        onThink: (delta, full) => this._onThink(seat, full),
        onError: (e) => {
          const msg = e?.message || String(e || '');
          if (msg) this._log(`⚠ ${msg}`, 'warn');
        },
        onDebug: () => {},
      }) || null;
      if (agent) agents.set(seat, agent);
    }
    return agents;
  }

  /* ============================================================ 开局 */

  async _startNew() {
    if (this._busy) return;
    this._busy = true;
    try {
      const cfg = this._collect();
      // 设置**只写 games.undercover**(只对这个游戏生效);global 的模型/Key 不在这里碰
      try { await this.hooks.onSaveConfig?.({ games: { undercover: cfg } }); } catch { /* 存不下设置也能玩 */ }
      this.humanSeat = this.mode === 'join' ? 0 : null;
      const seats = cfg.seats;
      const names = this._buildCast(seats, this.humanSeat);
      const kernel = createKernel({ ...cfg, humanSeat: this.humanSeat });
      this._begin(kernel, names, { resume: false });
    } finally {
      this._busy = false;
    }
  }

  async _resume() {
    const snap = this._pendingSnap || this.store?.loadValid?.();
    if (!snap) { this.dom.lobbyNote.textContent = '那份存档读不出来了(可能已被清掉)。'; return; }
    try {
      const cfg = snap.config || {};
      const humanSeat = cfg.humanSeat ?? null;
      this.mode = humanSeat === null ? 'watch' : 'join';
      this.humanSeat = humanSeat;
      const seats = Number(cfg.seats) || 6;
      const names = this._buildCast(seats, humanSeat);
      const kernel = createKernel({ ...cfg, humanSeat });
      kernel.restore(snap);
      // 名字以存档里那份为准(不然「恢复」之后人全改名了)
      if (Array.isArray(snap.state?.names) && snap.state.names.length === seats) {
        for (let s = 0; s < seats; s++) if (snap.state.names[s]) names[s] = snap.state.names[s];
      }
      this._begin(kernel, names, { resume: true });
      this.toast(`已恢复:第 ${kernel.state.round} 轮`, 'ok');
    } catch (err) {
      this.dom.lobbyNote.textContent = `存档不可用:${err?.message || err}`;
      try { this.store?.clear(); } catch { /* 忽略 */ }
    }
  }

  /** 真正开始(或恢复)一局 */
  _begin(kernel, names, { resume = false } = {}) {
    this._teardownRun();
    this.hideLobby();
    this.kernel = kernel;
    this._abort = new AbortController();
    const seats = kernel.state.alive.length;
    this.agents = this._buildAgents(seats, this.humanSeat, kernel);
    const human = this.humanSeat === null ? null : {
      seat: this.humanSeat,
      describe: (view) => this._askHumanDescribe(view),
      vote: (view) => this._askHumanVote(view),
    };
    this.dom.god.hidden = this.mode !== 'watch';
    this.dom.me.hidden = this.mode !== 'join';
    this.dom.matrix.hidden = false;
    this.dom.banner.hidden = true;
    // 结算排名是**上一局**的东西:新一局开始时收起来(积分表本身不清,
    // 同一场里连打几局要累计 —— 见 scoring.js 的文件头)
    this.dom.rank.hidden = true;
    this.dom.rank.innerHTML = '';
    this.dom.log.innerHTML = '';
    this._actionBubble = null;
    this._thinkingSeat = null;
    this._thinkingText = '';
    this._thinkingLive = false;
    this._clearActionTimer();
    this.bubble?.hide?.();
    // 座位数变了 → 3D 重建(道具层会跟着重建,见 sceneCore/table.js 的 buildSeats)
    this.table.buildSeats(seats);
    this._render();

    // ★ 换了一局就换一个信号:上一局还挂着的「暂停」不能带到新一局(否则一开就停住)
    this._roundEnd = null;
    this.roundGate.reset({ holdMs: ROUND_HOLD_MS, signal: this._abort.signal });
    this._paintPace();

    this.runner = new UndercoverRunner({
      kernel,
      agents: this.agents,
      human,
      delayMs: Number(this._configValues().speakDelayMs) || 0,
      signal: this._abort.signal,
      roundGate: this.roundGate,
      // ★ 本场积分榜的公开快照 —— 提示词里的【你的最终目标】要用它。
      //   只有 seat / name / 积分(这张榜本来就画在界面上,是公开信息);
      //   别人的词 / 阵营不在里面,也从这里进不去提示词。
      matchStandings: () => ({
        rounds: this.scoreboard?.games() || 0,
        ranking: (this.scoreboard?.rows() || []).map((r) => ({ seat: r.seat, name: r.name, score: r.points })),
      }),
      hooks: {
        names,
        onEvent: (ev) => this._onEvent(ev),
        onThinking: (seat) => { this._thinkingSeat = seat; this._thinkingText = ''; },
      },
    });
    this.running = true;
    this.hooks.onGameStarted?.();
    this._log(resume ? `恢复对局:第 ${kernel.state.round} 轮` : `${seats} 人局开始,开始发词…`, 'ok');
    this.runner.run().catch((err) => {
      if (err?.canceled || this._abort?.signal.aborted) return;
      this._log(`对局中断:${err?.message || err}`, 'err');
      this.toast(`对局中断:${err?.message || err}`, 'err', 6000);
      this.running = false;
      this.hooks.onGameEnded?.();
    }).finally(() => {
      if (this.destroyed) return;
      if (!this.running) this.dom.action.hidden = true;
    });
  }

  _teardownRun() {
    try { this.runner?.stop(); } catch { /* 忽略 */ }
    try { this._abort?.abort(); } catch { /* 忽略 */ }
    // 闸门里可能正挂着一次「等下一回合」—— 不放掉的话退出本局的 await 会留在那儿
    try { this.roundGate?.clear(); } catch { /* 忽略 */ }
    this._roundEnd = null;
    this.runner = null;
    this._abort = null;
    this.running = false;
    this._resolveHuman(null);
  }

  /* ============================================================ 节奏控制 */

  /**
   * 「暂停 / 下一回合 / 继续」—— 一个按钮三种含义,按闸门当前状态决定。
   *
   * 为什么要它:观看模式下 6 个人一轮要几十秒,想停下来看看上帝面板、
   * 或者纯粹想让「结果」多停一会儿,原来只能干瞪眼。三种状态刻意**不叠加**:
   *   · 没暂停        → 点一下 = 暂停(停在下一个回合边界上)
   *   · 暂停且没停在边界 → 点一下 = 继续(恢复自动推进)
   *   · 暂停且停在边界   → 点一下 = 放行**这一轮**;再点一下才会放下一轮
   * 最后这一条就是「幂等」:连点两下不会跳两轮 —— 闸门里只有一份等待,
   * 第二下在没人等待时是空操作(见 shared/roundGate.mjs 的注释与测试),
   * 界面上再加一道 350ms 去抖(见下面),把「手抖点两下」也挡住。
   */
  _onPaceClick() {
    const g = this.roundGate;
    if (!g) return;
    // 连点两下 = 一下:第二下如果变成「继续」,就会把「暂停」整个取消掉,
    // 在用户看来就是「点了两下下一回合,结果一路跑过去了」。350ms 内的重复点击直接忽略。
    const now = Date.now();
    if (now - (this._paceAt || 0) < 350) return;
    this._paceAt = now;
    if (!g.paused) { g.pause(); this.toast('已暂停:下一回合边界会停住', 'info', 1800); }
    else if (g.waiting) { g.step(); }
    else { g.resume(); this.toast('继续', 'info', 1200); }
    this._paintPace();
  }

  /** 按钮文案跟着闸门状态走(暂停中停在边界 → 「下一回合」) */
  _paintPace(state = this.roundGate?.state) {
    const btn = this.dom?.pace;
    if (!btn) return;
    const s = state || { paused: false, waiting: false };
    const icon = btn.querySelector('.uc__paceIcon');
    const label = btn.querySelector('.uc__paceLabel');
    if (icon) icon.textContent = !s.paused ? '⏸' : (s.waiting ? '⏭' : '▶');
    if (label) label.textContent = !s.paused ? ' 暂停' : (s.waiting ? ' 下一回合' : ' 继续');
    btn.title = !s.paused ? '暂停在回合边界上,一回合一看'
      : (s.waiting ? '放行这一轮(下一回合)' : '继续自动推进');
    btn.classList.toggle('is-armed', !!(s.paused && s.waiting));
  }

  /* ============================================================ 事件 */

  _onEvent(ev) {
    if (this.destroyed) return;
    switch (ev.type) {
      case 'speaker':
        this._thinkingSeat = ev.seat;
        this._thinkingText = '';
        this._thinkingLive = !ev.human;
        if (ev.human) this._showActionHint(`${seatLabel(ev.seat)} 轮到你描述了`);
        break;
      case 'describe':
        this._thinkingSeat = null;
        this._thinkingText = '';
        this._thinkingLive = false;
        this._actionBubble = { seat: ev.seat, say: ev.say, text: '' };
        this._clearActionTimer();
        this._actionTimer = setTimeout(() => { this._actionBubble = null; this._render(); }, 2400);
        this._log(`${seatLabel(ev.seat)}:${ev.say}${ev.quality === 'low' ? '(中性兜底)' : ''}`,
          ev.quality === 'low' ? 'warn' : '');
        this._persist();
        break;
      case 'guess': {
        // ★ 猜词。事件里只有 **public** 字段(text 可能为空:平民猜的词不公开,
        //   见 kernel.recordGuess)。观看模式想看全量的话从 god 视图拿,不走事件 ——
        //   这样「玩家模式不该看到的东西」根本没有进入这条路径。
        this._thinkingSeat = null;
        this._thinkingText = '';
        this._thinkingLive = false;
        const who = seatLabel(ev.seat);
        const roleCn = ev.role === 'undercover' ? '卧底' : ev.role === 'blank' ? '白板' : '平民';
        // 猜测词在能公开时才写出来(卧底猜 / 终局),否则只说「改为猜词」
        const what = ev.text ? `猜「${ev.text}」` : '改为猜词(猜的词不公开)';
        const res = ev.hit ? '猜中了' : '没猜中';
        this._actionBubble = {
          seat: ev.seat,
          say: '',
          text: ev.text ? `猜「${ev.text}」·${res}` : `猜词 · ${res}`,
        };
        this._clearActionTimer();
        this._actionTimer = setTimeout(() => { this._actionBubble = null; this._render(); }, 3200);
        this._log(`${who} 放弃描述,${what} —— ${res},他是${roleCn}`, ev.hit ? 'ok' : 'warn');
        if (ev.eliminated !== null && ev.eliminated !== undefined) {
          this._log(`${seatLabel(ev.eliminated)} 因为猜词出局(平民/白板猜词一律出局)`, 'warn');
        }
        this._persist();
        break;
      }
      case 'voteStart':
        this._thinkingSeat = ev.seat;
        this._thinkingText = '';
        this._thinkingLive = true;
        break;
      case 'vote':
        this._thinkingSeat = null;
        this._thinkingText = '';
        this._thinkingLive = false;
        this._actionBubble = {
          seat: ev.from,
          say: '',
          text: ev.to === null ? '弃票' : `投 ${seatLabel(ev.to)}${ev.reason ? `(${ev.reason})` : ''}`,
        };
        this._clearActionTimer();
        this._actionTimer = setTimeout(() => { this._actionBubble = null; this._render(); }, 2400);
        this._log(`${seatLabel(ev.from)} ${ev.to === null ? '弃票' : `→ ${seatLabel(ev.to)}`}${ev.reason ? `:${ev.reason}` : ''}`);
        this._persist();
        break;
      case 'eliminate':
        this._log(`${seatLabel(ev.seat)} 出局 —— ${ROLE_LABEL[ev.role] || '平民'}`, 'warn');
        this._persist();
        break;
      case 'round':
        this._log(`第 ${ev.round} 轮开始`, 'ok');
        this._persist();
        break;
      case 'roundEnd': {
        // ★ 回合边界。轮次已经在**内核**里 +1 了,所以这里要同时说清「结束的是哪一轮」。
        //   不这么说的话,观众看到的就是标签悄悄从 2 跳成 3 —— 像卡了一下又突然变了。
        this._roundEnd = ev;
        this._log(`第 ${ev.round} 轮结束 → 第 ${ev.next} 轮开始${ev.eliminated?.length
          ? `(${ev.eliminated.map(seatLabel).join('、')} 出局)` : '(平票,无人出局)'}`, 'ok');
        this.toast(`第 ${ev.round} 轮结束 → 第 ${ev.next} 轮开始`, 'ok', 2200);
        this._persist();
        break;
      }
      case 'roundStart':
        this._roundEnd = null;
        break;
      case 'stepError':
        // 一步没问出来(模型炸/解析失败)—— 降级继续,但要让现场记录里看得见,
        // 否则观众只会觉得「它这轮怎么说了句废话」。
        this._log(`⚠ ${seatLabel(ev.seat)} 这一步没问出来(${ev.step}),已降级继续:${ev.message}`, 'warn');
        break;
      case 'repair':
        this._log(`⚠ 状态自相矛盾(${ev.why}),已修复:${ev.fix}`, 'warn');
        break;
      case 'start':
        this._log(`发词完成:${ev.seats} 人。没有人知道自己是不是卧底。`);
        break;
      case 'end': {
        this._thinkingSeat = null;
        this._thinkingText = '';
        this._thinkingLive = false;
        // 收掉最后那个动作气泡:否则游戏结束后它还会挂在最后一句话那个人头上,
        // 而那时「正在说话」的上下文已经不存在了(实测会在左上角留一颗空气泡)
        this._actionBubble = null;
        this._clearActionTimer();
        this.bubble?.hide?.();
        const win = ev.winner === 'undercover' ? '卧底胜' : '平民胜';
        this._log(`${win}(${END_REASON[ev.reason] || '轮次上限'})`, 'ok');
        // ★ 算分 + 排名:把这一局的结算结果交给本游戏自己的 score()(scoring.js)。
        //   平台壳不参与 —— 积分只在这场游戏内有意义(用户口径)。
        this._scoreRound();
        this.showBanner(win, this._endSubText());
        this.toast(win, ev.winner === 'undercover' ? 'warn' : 'ok', 4000);
        try { this.store?.clear(); } catch { /* 打完的局没有续玩的意义 */ }
        this.running = false;
        this.hooks.onGameEnded?.();
        this.dom.action.hidden = true;
        break;
      }
      default:
        break;
    }
    this._render();
  }

  /**
   * 一局结束 → 算分入表 → 刷新排名面板 + 往现场记录里写一行本局得分。
   *
   * 为什么在**这里**(屏幕层)而不是平台壳:平台壳不认识「卧底怎么算分」,
   * 而这张积分表也只在这个游戏内有意义 —— 交给壳就等于又造一个跨游戏的抽象。
   */
  _scoreRound() {
    const board = this.scoreboard;
    if (!board || !this.kernel) return;
    try {
      const result = buildScoreResult(this.kernel.state);
      const { deltas } = board.apply(result, this._configValues());
      this._lastDeltas = deltas;
      // 现场记录里逐条写一遍,观众不用盯排名面板也知道谁为什么加分
      const bySeat = new Map();
      for (const d of deltas) {
        if (!bySeat.has(d.seat)) bySeat.set(d.seat, []);
        bySeat.get(d.seat).push(d.label);
      }
      for (const [seat, labels] of bySeat) {
        const total = deltas.filter((d) => d.seat === seat).reduce((n, d) => n + d.delta, 0);
        this._log(`积分 · ${seatLabel(seat)} ${total > 0 ? '+' : ''}${total}(${labels.join('、')})`,
          total < 0 ? 'warn' : 'ok');
      }
    } catch (err) {
      // 算分失败绝不能把一局已经打完的界面搞崩:排名不显示,牌局结果照旧可见
      console.warn('[undercover] 算分失败', err);
      this._lastDeltas = [];
    }
    this._renderRanking();
  }

  /**
   * 画积分/排名面板(大厅里一块、结算时一块,两处同一份 HTML)。
   * 一份数据两处显示,是为了「结算时看得到、再开局前也看得到」——
   * 但两处都用同一个 rankingHtml,不会出现两种口径。
   */
  _renderRanking() {
    const board = this.scoreboard;
    if (!board) return;
    const rows = board.rows();
    const games = board.games();
    const html = rankingHtml(rows, {
      games,
      deltas: this._lastDeltas,
      you: this.humanSeat,
    });
    if (this.dom.rank) {
      this.dom.rank.innerHTML = html;
      this.dom.rank.hidden = !html;
    }
    if (this.dom.lobbyRank) {
      this.dom.lobbyRank.innerHTML = html;
      this.dom.lobbyRank.hidden = !html;
    }
  }

  /**
   * 「清空积分」:两下才真的清。
   *
   * 为什么不清一次就清:积分是这个游戏里唯一的进度感,误触一次全没了很恼人;
   * 而弹 confirm() 在 Electron 里会卡住渲染进程(自动化/截图工具直接卡死)。
   * 所以用「第一下变红、三秒内再点一下才生效」这个纯 DOM 的两步确认。
   */
  _onResetRanking(btn) {
    if (!btn) return;
    if (btn.dataset.armed === '1') {
      this.scoreboard?.reset();
      this._lastDeltas = [];
      // 「清空」= 主动放弃这一场:不记全局分,后面再打的局算新的一场。
      this._matchRecorded = false;
      this._renderRanking();
      this.toast('本场积分已清空', 'ok', 2000);
      return;
    }
    btn.dataset.armed = '1';
    btn.textContent = '再点一次清空';
    btn.classList.add('is-armed');
    clearTimeout(this._resetTimer);
    this._resetTimer = setTimeout(() => {
      btn.dataset.armed = '';
      btn.textContent = '清空积分';
      btn.classList.remove('is-armed');
    }, 3000);
  }

  _endSubText() {
    const st = this.kernel?.state;
    if (!st) return '';
    const und = st.roles.map((r, s) => (r === 'undercover' ? seatLabel(s) : null)).filter(Boolean);
    const blanks = st.roles.map((r, s) => (r === 'blank' ? seatLabel(s) : null)).filter(Boolean);
    const guess = (st.guesses || []).length ? st.guesses[st.guesses.length - 1] : null;
    const parts = [];
    if (guess && (st.endReason === 'guessRight' || st.endReason === 'guessMiss')) {
      parts.push(`${seatLabel(guess.seat)} 猜「${guess.text}」${guess.hit ? '猜中' : '猜错'}`);
    }
    parts.push(`卧底是 ${und.join('、') || '—'}`);
    if (blanks.length) parts.push(`白板是 ${blanks.join('、')}`);
    return parts.join(' · ');
  }

  _onThink(seat, full) {
    if (this.destroyed) return;
    // 玩家模式**不看别人的思考** —— 这里不是 CSS 隐藏,是根本不存这段文字
    if (this.mode !== 'watch') return;
    if (this._thinkingSeat !== seat) return;
    this._thinkingText = String(full || '').slice(-160);
    if (!this._thinkingText) return;
    this._thinkingLive = true;
    // 流式片段可能几十毫秒来一次 —— 每片都刷 DOM 会把主线程吃掉,
    // 120ms 一次足够让人看见「它在想」,又不影响 3D 帧率。
    const now = Date.now();
    if (now - (this._thinkPaintAt || 0) < 120) return;
    this._thinkPaintAt = now;
    this.bubble.update(this._bubbleCtx(), this.personaMap);
  }

  /* ============================================================ 渲染 */

  _render() {
    if (this.destroyed || !this.kernel) return;
    const st = this.kernel.state;
    const view = buildRenderView(st, { mode: this.mode, humanSeat: this.humanSeat });
    this._lastView = view;

    this.dom.roundTag.textContent = st.phase === 'idle' ? '未开局' : `第 ${st.round} / ${st.config.rounds} 轮`;
    // 回合边界上:阶段标签改成「第 N 轮结束 →」,让「刚才那一轮结束了」这件事
    // 在画面上**停留**一会儿(自动推进时约 1.4s;暂停时一直停着,直到按「下一回合」)
    this.dom.phaseTag.textContent = this._roundEnd
      ? `第 ${this._roundEnd.round} 轮结束 →`
      : (PHASE_LABEL[st.phase] || '');
    this.dom.phaseTag.classList.toggle('is-vote', st.phase === 'vote' && !this._roundEnd);
    this.dom.phaseTag.classList.toggle('is-boundary', !!this._roundEnd);

    // 上帝面板:只有观看模式才画(玩家模式连 DOM 都不填)
    if (this.mode === 'watch') this._renderGod(view);
    else this.dom.god.innerHTML = '';

    if (this.mode === 'join') this._renderMe(view);
    this._renderMatrix(view);

    // 3D:通用座位视图 + 卧底自己的一层 ctx(labels 里该有谁,由上面的 view 决定)
    const actor = st.phase === 'describe'
      ? (st.order[st.orderIdx] ?? null)
      : (st.phase === 'vote' ? (this.kernel.pendingVoters()[0] ?? null) : null);
    const labels = this._buildLabels(view);
    this.table.update(buildTableViewModel(st, { actor }), {
      labels,
      roundText: st.phase === 'end' ? (st.winner === 'undercover' ? '卧底胜' : '平民胜')
        : this._roundEnd ? `第 ${this._roundEnd.round} 轮结束 → 第 ${this._roundEnd.next} 轮`
          : `第 ${st.round} 轮 · ${PHASE_LABEL[st.phase] || ''}`,
      roundHint: st.phase === 'end' ? '点「设置」可以再来一局' : `还剩 ${st.alive.filter(Boolean).length} 人`,
      thinkingSeat: this._thinkingSeat,
    });

    // 气泡:玩家模式不给别人的思考文字(revealThinking:false → 只显示「正在思考中…」)
    this.bubble.update(this._bubbleCtx(), this.personaMap);
    this._layoutHint();
  }

  /** 气泡要的上下文(渲染与流式思考共用一份,免得两处拼得不一样) */
  _bubbleCtx() {
    return {
      thinkingSeat: this._thinkingSeat,
      revealThinking: this.mode === 'watch',
      thinkingText: this._thinkingText,
      thinkingLive: !!this._thinkingLive,
      actionBubble: this._actionBubble,
    };
  }

  /**
   * 道具层要的 labels —— **玩家模式只造自己那一个**。
   *
   * 这是「渲染前就不取」在 3D 上的落点:别人的词不进 labels,所以道具层
   * 根本画不出别人面前的语言卡(不是画了再隐藏)。
   */
  _buildLabels(view) {
    const out = {};
    if (this.mode === 'watch') {
      const st = this.kernel.state;
      const curVotes = new Map();
      for (const v of st.votes) {
        if (v.round === st.round && v.to !== null) curVotes.set(v.from, v.to);
      }
      const lastSay = new Map();
      for (const d of st.descriptions) {
        if (!lastSay.has(d.seat) || d.round >= lastSay.get(d.seat).round) lastSay.set(d.seat, d);
      }
      for (const s of view.seats) {
        out[s.seat] = {
          seat: s.seat,
          // 白板面前那张卡没有词:写「(白板)」,与上帝面板一致
          title: s.word || '(白板)',
          role: s.role,
          selfRead: s.selfRead,
          say: lastSay.get(s.seat)?.say || '',
          vote: curVotes.has(s.seat) ? curVotes.get(s.seat) : null,
          accent: s.role === 'undercover' ? 'rgba(178,59,59,.95)'
            : s.role === 'blank' ? 'rgba(122,75,154,.95)' : 'rgba(47,125,90,.95)',
        };
      }
    } else if (this.humanSeat !== null) {
      out[this.humanSeat] = {
        seat: this.humanSeat,
        title: view.me.word || '(白板)',
        say: '',
        vote: null,
        accent: 'rgba(196,162,88,.95)',
      };
    }
    return out;
  }

  _renderGod(view) {
    const st = this.kernel.state;
    const rows = view.seats.map((s) => {
      const self = SELF_READ_LABEL[s.selfRead] || '—';
      const selfCls = s.selfRead === 'undercover' ? 'is-und' : s.selfRead === 'civilian' ? 'is-civ' : '';
      // 白板:词那一格是空的,直接写「(白板)」—— 看起来才像「他没有词」,
      // 而不是「词还没发下来」
      const role = s.role === 'undercover' ? '<b class="is-und">卧底</b>'
        : s.role === 'blank' ? '<b class="is-blank">白板</b>'
          : '<span class="is-civ">平民</span>';
      const wordCell = s.word ? esc(s.word) : '<span class="uc__mxEmpty">(白板)</span>';
      return `<tr class="${s.alive ? '' : 'is-out'}">
        <td>${s.seat + 1}号</td>
        <td class="uc__godName">${esc(s.name)}</td>
        <td class="uc__godWord">${wordCell}</td>
        <td>${role}</td>
        <td class="${selfCls}">${esc(self)}</td>
        <td class="uc__godSay">${esc(s.lastSay || '—')}</td>
      </tr>`;
    }).join('');
    // 猜词记录:上帝视角看得到猜的到底是什么词(观众本来就都知道)
    const guesses = view.guesses || [];
    const guessLine = guesses.length
      ? `<div class="uc__godGuess">猜词:${guesses.map((g) => `${g.seat + 1}号猜「${esc(g.text)}」${g.hit ? '中' : '错'}`).join(' · ')}</div>`
      : '';
    this.dom.god.innerHTML = `
      <div class="uc__godHead">
        <span>上帝视角 · 卧底 ${esc(view.undercoverWord)} / 平民 ${esc(view.civilianWord)}</span>
        <span class="uc__godHint">自省 = 它自己猜自己是谁(会猜错)${view.blankCount ? ' · 本场有 1 个白板(没有词)' : ''}</span>
        ${guessLine}
      </div>
      <table class="uc__godTable">
        <thead><tr><th>座位</th><th>名字</th><th>词</th><th>阵营</th><th>自省</th><th>最近一句</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    this.dom.god.hidden = false;
    void st;
  }

  _renderMe(view) {
    const alive = view.me.alive;
    // 白板没有词。这里**只说「你没有词」**,不说为什么、也不说这意味着哪一边 ——
    // 玩家和白板玩家自己的屏幕也必须遵守同一条信息边界(kernel/view 那边同理)。
    const wordHtml = view.me.blank
      ? '<div class="uc__meWord is-blank">(你没有词)</div>'
      : `<div class="uc__meWord">${esc(view.me.word)}</div>`;
    const hint = !alive ? '你已经出局了,只能看着他们继续。'
      : view.me.blank
        ? '听别人怎么描述,顺着那个方向编一句 —— 别让人看出你手上是空的。'
        : '你不知道自己是不是卧底 —— 听别人怎么说,再决定怎么描述。';
    this.dom.me.innerHTML = `
      <div class="uc__meLabel">你的词</div>
      ${wordHtml}
      <div class="uc__meHint">${hint}</div>`;
    this.dom.me.classList.toggle('is-out', !alive);
  }

  _renderMatrix(view) {
    const rounds = [];
    for (const d of view.descriptions) if (!rounds.includes(d.round)) rounds.push(d.round);
    rounds.sort((a, b) => a - b);
    const head = `<tr><th>座位</th>${rounds.map((r) => `<th>第${r}轮</th>`).join('')}</tr>`;
    const rows = view.seats.map((s) => {
      const cells = rounds.map((r) => {
        const d = view.descriptions.find((x) => x.seat === s.seat && x.round === r);
        if (!d) return '<td class="uc__mxEmpty">—</td>';
        return `<td class="${d.quality === 'low' ? 'uc__mxLow' : ''}">${esc(d.say)}</td>`;
      }).join('');
      return `<tr class="${s.alive ? '' : 'is-out'}"><td>${s.seat + 1}号${this.mode === 'join' && s.seat === view.seat ? '(你)' : ''}</td>${cells}</tr>`;
    }).join('');
    const votes = view.votes.filter((v) => v.round === view.round - 1 || (v.round === view.round && view.phase === 'vote'));
    const voteLine = votes.length
      ? `<div class="uc__mxVotes">投票:${votes.map((v) => `${v.from + 1}→${v.to === null ? '弃' : v.to + 1}`).join(' ')}</div>`
      : '';
    // 猜词也写进这块公开信息里(它是公开动作)。猜的**词**按 view 的截断显示:
    // 玩家模式下平民猜的词不会出现在这里(view.js 的 publicGuesses)。
    const guesses = view.guesses || [];
    const guessLine = guesses.length
      ? `<div class="uc__mxVotes">猜词:${guesses.map((g) => `${g.seat + 1}号${g.text ? `猜「${esc(g.text)}」` : '改猜词'}${g.hit ? '中' : '错'}`).join(' ')}</div>`
      : '';
    this.dom.matrix.innerHTML = `
      <div class="uc__mxHead">描述矩阵 <span>${view.aliveCount} 人存活 · 阈值 ${view.threshold} 人</span></div>
      <table class="uc__mxTable"><thead>${head}</thead><tbody>${rows}</tbody></table>
      ${voteLine}${guessLine}`;
    this.dom.matrix.hidden = false;
  }

  _log(text, kind = '') {
    const line = el('div', `uc__logLine${kind ? ` is-${kind}` : ''}`, text);
    this.dom.log.appendChild(line);
    while (this.dom.log.children.length > 200) this.dom.log.removeChild(this.dom.log.firstChild);
    this.dom.log.scrollTop = this.dom.log.scrollHeight;
  }

  _layoutHint() {
    const st = this.kernel?.state;
    if (!st) return;
    if (this.mode === 'join' && !this.dom.action.hidden) return;
    if (this._humanResolve) return;
    // 玩家模式少量提示;观看模式不需要(画面自己会说话)
  }

  /* ============================================================ 玩家操作 */

  _clearActionTimer() {
    if (this._actionTimer) { clearTimeout(this._actionTimer); this._actionTimer = null; }
  }

  _resolveHuman(result) {
    const r = this._humanResolve;
    this._humanResolve = null;
    clearTimeout(this._guessArmTimer);
    this.dom.action.hidden = true;
    this.dom.action.innerHTML = '';
    // 手机上操作区会占掉底部一整条:撤掉标记,矩阵/现场记录才能回到原位
    this.root.querySelector('.uc')?.classList.remove('is-acting');
    if (r) r(result);
  }

  _waitHuman(build) {
    return new Promise((resolve) => {
      this._humanResolve = resolve;
      this.dom.action.innerHTML = '';
      this.dom.action.hidden = false;
      // ★ 手机上「描述矩阵」和「操作区」都在底部,不加这个标记就会叠在一起。
      //   标记在根节点上,让 CSS 决定谁往上让(见 styles3d.css 的手机横屏块)。
      const shell = this.root.querySelector('.uc');
      shell?.classList.add('is-acting');
      build(this.dom.action, (result) => this._resolveHuman(result));
      // 操作区有两行(描述 + 猜词),高度写死必然被改结构的人改坏 ——
      // 所以量一次写进 CSS 变量(与扑克的 --actionbar-h 同一个做法),
      // 矩阵/现场记录用 calc() 让开它。
      // ⚠️ 先用**同步** offsetHeight(强制一次布局,拿到的是真实高度),
      //    再在下一帧补量一次(字体/表情符号落位后可能高 1~2px)。
      //    只靠 requestAnimationFrame 会漏:实测有的回合 rAF 里 offsetHeight 还是旧值,
      //    矩阵就仍按兜底的 74px 让位,底部被操作区压掉 53px。
      this._measureAction();
      requestAnimationFrame(() => this._measureAction());
    });
  }

  /** 把操作区的实测高度写进 --uc-act-h(手机横屏的面板让位靠它) */
  _measureAction() {
    const shell = this.root.querySelector('.uc');
    if (!shell || !this.dom.action || this.dom.action.hidden) return;
    shell.style.setProperty('--uc-act-h', `${Math.ceil(this.dom.action.offsetHeight)}px`);
  }

  _showActionHint(text) { this.toast(text, 'info', 1800); }

  /**
   * 玩家描述:输入框 + 代码级过滤(玩家也不能说出自己的词)。
   *
   * 下方还有**猜词**入口:放弃描述,直接报出平民的词。它是不可撤销的动作
   * (真的是卧底 → 猜中赢/猜错输;是平民/白板 → 立刻出局),所以点两下才生效
   * (第一下变成「确定猜「X」?」)—— 误触一下就输掉整局,代价太大。
   */
  _askHumanDescribe(view) {
    return this._waitHuman((box, done) => {
      const wrap = el('div', 'uc__act');
      const head = view.me.blank
        ? '轮到你描述 —— <b>(你手上没有词)</b>,顺着别人说过的编一句'
        : `轮到你描述 —— 你的词是 <b>${esc(view.me.word)}</b>`;
      wrap.innerHTML = `
        <div class="uc__actHead">${head}</div>
        <div class="uc__actRow">
          <input class="uc__input" id="ucSayInput" maxlength="30" placeholder="一句话描述它(10~20 字),不要说出这个词">
          <button class="btn btn--primary" id="ucSayGo">说这句</button>
          <button class="btn btn--ghost" id="ucSayAuto" title="实在不想写,就让系统给一句确定性的中性描述">随便说一句</button>
        </div>
        <div class="uc__actRow uc__actRow--guess">
          <span class="uc__actNote uc__actNote--inline">或者赌一把,直接报出平民的词:</span>
          <input class="uc__input uc__input--guess" id="ucGuessInput" maxlength="12" placeholder="你认为的平民词">
          <button class="btn btn--ghost" id="ucGuessGo">猜这个词</button>
        </div>
        <div class="uc__actNote" id="ucSayNote">代价:真的是卧底 → 猜中当场赢、猜错当场输;不是卧底(平民/白板)→ 一猜就出局。拿不准就别猜。</div>`;
      box.appendChild(wrap);
      const input = wrap.querySelector('#ucSayInput');
      const guessInput = wrap.querySelector('#ucGuessInput');
      const note = wrap.querySelector('#ucSayNote');
      input.focus();
      const submit = () => {
        const say = cleanSay(input.value, 30);
        if (!say || !/\p{Script=Han}/u.test(say)) { note.textContent = '要一句中文描述。'; return; }
        const leak = checkSayLeak(say, { word: view.me.word, blank: !!view.me.blank });
        if (leak) { note.textContent = `这句不能公开说:${leak.why}。换一句。`; return; }
        done({ action: 'describe', say, thinking: '', selfRead: 'unsure' });
      };
      wrap.querySelector('#ucSayGo').addEventListener('click', submit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      wrap.querySelector('#ucSayAuto').addEventListener('click', () => {
        done({
          action: 'describe',
          say: neutralSay(view.seat, view.round),
          thinking: '',
          selfRead: 'unsure',
          quality: 'low',
        });
      });

      // 猜词:两下确认
      const guessBtn = wrap.querySelector('#ucGuessGo');
      guessBtn.addEventListener('click', () => {
        const g = normalizeGuess(guessInput.value);
        if (!g) { note.textContent = '要一个词(中文,≤12 字)。'; return; }
        if (guessBtn.dataset.armed === '1') {
          done({ action: 'guess', guess: g, thinking: '', selfRead: 'unsure' });
          return;
        }
        guessBtn.dataset.armed = '1';
        guessBtn.textContent = `确定猜「${g}」?`;
        guessBtn.classList.add('is-armed');
        note.textContent = '再点一次就交出去 —— 这一下改不回来。';
        clearTimeout(this._guessArmTimer);
        this._guessArmTimer = setTimeout(() => {
          guessBtn.dataset.armed = '';
          guessBtn.textContent = '猜这个词';
          guessBtn.classList.remove('is-armed');
        }, 4000);
      });
      guessInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') guessBtn.click(); });
    });
  }

  /** 玩家投票:按钮 + 可选理由;投自己 / 已出局的人不会出现在按钮里 */
  _askHumanVote(view) {
    return this._waitHuman((box, done) => {
      const wrap = el('div', 'uc__act');
      const btns = view.voteCandidates.map((seat) => {
        const p = this.personaMap.get(seat);
        return `<button class="btn btn--ghost uc__voteBtn" data-seat="${seat}">
          <b>${seat + 1}号</b>${p ? ` ${esc(p.name)}` : ''}</button>`;
      }).join('');
      wrap.innerHTML = `
        <div class="uc__actHead">轮到你投票 —— 谁最像卧底?</div>
        <div class="uc__actRow uc__voteRow">
          ${btns}
          <button class="btn btn--ghost" data-seat="abstain">弃票</button>
        </div>
        <div class="uc__actRow">
          <input class="uc__input uc__input--reason" id="ucVoteReason" maxlength="25" placeholder="公开理由(可留空,≤25 字)">
        </div>`;
      box.appendChild(wrap);
      const reasonEl = wrap.querySelector('#ucVoteReason');
      wrap.querySelectorAll('.uc__voteBtn, [data-seat="abstain"]').forEach((b) => {
        b.addEventListener('click', () => {
          const raw = b.dataset.seat;
          const reason = cleanSay(reasonEl.value, 25);
          const leak = checkSayLeak(reason, { word: view.me.word, blank: !!view.me.blank });
          done({
            target: raw === 'abstain' ? null : Number(raw),
            // 理由泄漏不弃票:票是动作,理由只是修辞(与 agent.vote 的处理一致)
            reason: leak ? '' : reason,
          });
        });
      });
    });
  }

  /* ============================================================ 存档 */

  _persist() {
    if (!this.kernel || !this.running) return;
    try { this.store?.save(); } catch (err) { console.warn('[undercover] 存档失败', err); }
  }

  /* ============================================================ 3D 循环 */

  _resize() {
    this._baseResize?.();
    const w = this.dom.canvas.clientWidth || window.innerWidth || 1440;
    const h = this.dom.canvas.clientHeight || window.innerHeight || 800;
    const aspect = Math.max(0.6, w / Math.max(1, h));
    this.table.layoutTable?.(aspect);
    // 相机取景:人数多/宽屏时往后拉(与扑克那块同一套思路,只是这里没有手牌区要让位)
    const seats = this.kernel?.state.alive.length || 6;
    const ref = 1.56;
    const spread = 0.92 + seats * 0.028;
    let k = Math.min(1.5, Math.max(1, Math.sqrt(ref / aspect))) * spread;
    const half = this.table?.outerHalfWidth?.() || 0;
    if (half > 0) {
      const halfFovY = (this.camera.fov * Math.PI / 180) / 2;
      const needZ = half / (Math.tan(halfFovY) * aspect);
      if (needZ > 8.4 * k) k = needZ / 8.4;
    }
    const stretch = this.table?.stretchX || 1;
    const lift = 1 + Math.max(0, stretch - 1) * 0.45;
    this._camBaseY = 4.3 * k * lift;
    this._camBaseZ = 8.4 * k;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  _loop() {
    if (this.destroyed) return;
    const t = this._clock.getElapsedTime();
    const cw = this.dom.canvas.clientWidth;
    const ch = this.dom.canvas.clientHeight;
    if (cw > 0 && ch > 0 && (cw !== this._lastW || ch !== this._lastH)) {
      this._lastW = cw; this._lastH = ch;
      this._resize();
    }
    if (!this._camBaseY) this._resize();
    this.camera.position.y = this._camBaseY + Math.sin(t * 0.5) * 0.03;
    this.camera.position.z = this._camBaseZ;
    this.camera.lookAt(0, 0.3, -0.9);
    this.table.faceSeats?.(this.camera);
    this.table.facePortraits?.(this.camera);
    // 气泡每帧跟着头顶走(座位重排 / 相机呼吸时缓存会失效)
    this.bubble.layout(this.camera, this.dom.canvas, this._tmp);
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this._loop);
  }

  /* ============================================================ 对外(宿主) */

  toast(text, kind = 'info', ms = 2600) {
    if (!this.dom.toast) return;
    this.dom.toast.textContent = text;
    this.dom.toast.className = `toast toast--${kind} toast--show`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this.dom.toast.className = 'toast'; }, ms);
  }

  showBanner(title, sub = '') {
    this.dom.banner.innerHTML = `<b>${esc(title)}</b><span>${esc(sub)}</span>`;
    this.dom.banner.hidden = false;
  }

  /**
   * 一场结束 → 把**本场最终排名**交给平台(壳据此折成全局分、写排行榜)。
   *
   * 「一场」在这个游戏里 = 这张屏幕从创建到退出之间的所有局(连打几局累计),
   * 与「本场积分」的口径一致。所以它在**退出**时结算一次:
   *   · 结算卡/侧栏里的本场排名照旧显示,这一步只是**多写一次排行榜**;
   *   · 平台壳(app.js)算全局分,屏幕不碰权重、不碰存储 —— 那两件事与游戏无关。
   *
   * ⚠️ 幂等:三条退出路(handleExit / stopGame / destroy)都会调到这里,
   *    用 _matchRecorded 挡住重复记录。没打过一局(rounds=0)不记。
   * ⚠️ 玩家点「清空积分」是**主动放弃这一场**,不记分(见 _onResetRanking)。
   */
  _recordMatch() {
    if (this._matchRecorded) return;
    if (!this.scoreboard || !this.scoreboard.games()) return;
    this._matchRecorded = true;
    try {
      const summary = matchSummaryOf(this.scoreboard);
      if (summary) this.hooks.onMatchEnded?.(summary);
    } catch (err) {
      // 记不上分绝不能让「退出本局」卡住 —— 最坏是丢一场战绩
      console.warn('[undercover] 本场结算失败', err);
    }
  }

  /**
   * 退出本局(app.requestExit 会先问这里)。
   * @returns {boolean} true = 这个屏幕自己处理了退出(别再走扑克抽屉那套)
   */
  handleExit() {
    try { this._recordMatch(); } catch { /* 记分失败不阻断退出 */ }
    try { this._teardownRun(); } catch { /* 忽略 */ }
    this.running = false;
    this.hooks.onGameEnded?.();
    this.hooks.onExitHome?.();
    return true;
  }

  /** 宿主(exitToHome / 返回键)要求停一局时用 */
  stopGame() {
    try { this._recordMatch(); } catch { /* 记分失败不阻断退出 */ }
    this._teardownRun();
    this.running = false;
    this.dom.action.hidden = true;
    this.hooks.onGameEnded?.();
    this._persist();
  }

  /** 宿主通用的界面句柄 —— 扑克屏幕上那些方法,这里实现成安全的空操作/等价物 */
  setHint() {}
  pushLog(entry) {
    const text = typeof entry === 'string' ? entry : (entry?.text || '');
    if (text) this._log(text);
  }
  clearLog() { if (this.dom.log) this.dom.log.innerHTML = ''; }
  setExitEnabled() {}
  setMode() {}
  setDealEnabled() {}
  setNextEnabled() {}
  setDealerOnlyUI() {}
  setReviewEnabled() {}
  setSidePanelOpen() {}
  isSidePanelOpen() { return false; }
  setPlayerBarEl() {}
  buildSeats(n) { if (this.table) this.table.buildSeats(Number(n) || 6); }
  applyPortraits() { this.table?.applyPortraits?.(); }
  updateSeats() {}

  destroy() {
    // ★ 先把这一场交出去再拆:destroy 是**最后一条**能拿到积分表的路
    //   (下面马上 scoreboard = null)。幂等,handleExit 已经记过就什么都不做。
    try { this._recordMatch(); } catch { /* 记分失败不阻断拆除 */ }
    this.destroyed = true;
    this._teardownRun();
    if (this._actionTimer) clearTimeout(this._actionTimer);
    if (this._toastTimer) clearTimeout(this._toastTimer);
    if (this._resetTimer) clearTimeout(this._resetTimer);
    if (this._guessArmTimer) clearTimeout(this._guessArmTimer);
    // 积分表是纯内存的,这里放开引用就等于清零 —— 换游戏 / 回主页之后
    // 再进来一定是 0 分(scoring.js 文件头:不跨会话累计)
    this.scoreboard = null;
    try { this.table?.destroy?.(); } catch { /* 忽略 */ }
    try { this.props?.destroy?.(); } catch { /* 忽略 */ }
    // ⚠️ 这里**不** renderer.dispose():createStage 在 window 上挂了 resize 监听
    //    (那是场景核心的公共实现,拿不到句柄去摘),dispose 之后一次窗口缩放
    //    就会对已销毁的上下文调 setSize 并抛错。canvas 会随 root.innerHTML 一起消失,
    //    WebGL 上下文交给 GC —— 换游戏不是高频操作,这点内存比「切回来之后窗口一缩放就报错」划算。
    this.root.innerHTML = '';
  }
}
