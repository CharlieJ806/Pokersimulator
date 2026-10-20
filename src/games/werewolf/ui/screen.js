/**
 * 「狼人杀」的画面 —— 3D 桌 + HTML 面板 + 两种模式(观看 / 自己加入)。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么屏幕**自己**驱动整局(而不是像扑克那样由 app.js 一手一手地点)
 *
 * 扑克是「发牌 → 一条街 → 每条街问一圈 → 摊牌」,每一步都由 app.js 的
 * playHandLoop 推着走;狼人杀是**轮次制**的(夜 → 天 → 投票 → 判负),流程就是一个
 * 循环,而且节奏、气泡、面板、天黑遮罩全绑在一起。拆给宿主只会让 app.js 多出一条
 * 只有狼人杀才走的驱动分支 —— 那正是重构要拆掉的那种耦合。
 * 所以这里:屏幕持有 kernel + runner,自己跑;宿主只提供「模型配置 / 保存设置 /
 * 打开模型面板 / 回主页」这几个回调(见 index.mjs 的 mount)。
 *
 * ────────────────────────────────────────────────────────────────
 * 信息隔离在画面上的落点(用户明确要求:**渲染前就不取**)
 *
 * 玩家模式只调 view.js 的 buildRenderView(state, {mode:'join'}) ——
 * 它返回的对象**没有**别人的身份、**没有**别人的查验与用药。这里所有 DOM/3D
 * 文本都从那一份对象取,所以不存在「先渲染再 CSS 隐藏」的路径:
 * 别人的身份根本没有进入这个屏幕的数据流(道具层的 labels 里也只有自己那一格有
 * roleLabel,别人的卡片画成「?」)。
 * 观看模式才走 buildGodView,并且**只有那一条分支**会画上帝面板。
 * 同理,runner 在玩家模式下拿到 revealSecrets:false —— 夜里的真实刀口/用药
 * **连事件对象里都没有**,屏幕想画也画不出来。
 *
 * 3D 用的是共享场景:sceneCore(房间/桌椅/座位/立绘/相机/气泡)+ props/werewolf
 * 的道具层(每人面前一张身份牌 + 桌面中央的天/夜牌 + 出局标记)。
 * sceneCore 一行都没为狼人杀改过。
 */

import * as THREE from '../../../../vendor/three.module.js';
import { createStage, addLights, addRoom } from '../../../ui3d/sceneCore/stage.js';
import { Table3D } from '../../../ui3d/sceneCore/table.js';
import { bubbleHtml, ThinkingBubble } from '../../../ui3d/sceneCore/bubble.js';
import { WerewolfProps } from '../../../ui3d/props/werewolf/markerProps.js';
import { createKernel } from '../engine/kernel.js';
import { buildRenderView, buildTableViewModel } from '../view.js';
import { WerewolfRunner } from '../runner.js';
import { createWerewolfStore } from '../store.js';
import { assignPersonas } from '../personas.js';
import { MatchStandings, matchSummary as matchSummaryOf } from '../scoring.js';
import { cleanBubble, checkReasonLeak, neutralSpeech } from '../filter.js';
import { WEREWOLF_CSS } from './theme.js';
import { RoundGate, ROUND_HOLD_MS } from '../../../shared/roundGate.mjs';
import {
  characterForModel, assignAccents, GENERIC_CHAR, displayNameForModel, assignDisplayNames,
} from '../../../ai/portraits.js';
import { preloadPortraits } from '../../../ui3d/sceneCore/portraits2d.js';

const PHASE_LABEL = {
  idle: '未开局', night: '夜晚', day: '白天发言', vote: '放逐投票', end: '结束',
};
const STEP_LABEL = { wolves: '狼人行动', seer: '预言家验人', witch: '女巫用药', done: '天亮' };
const ROLE_LABEL = {
  werewolf: '狼人', seer: '预言家', witch: '女巫', villager: '平民',
};

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

/** 建一块狼人杀屏幕(index.mjs 的 mount 用它;壳只拿返回值当通用界面句柄) */
export function createScreen(root, hooks = {}) {
  return new WerewolfScreen(root, hooks);
}

/** 样式只注入一次(同一页面反复进出这个游戏不该堆一堆 <style>) */
function ensureStyle(doc) {
  if (!doc || doc.querySelector('style[data-werewolf]')) return;
  const s = doc.createElement('style');
  s.setAttribute('data-werewolf', '1');
  s.textContent = WEREWOLF_CSS;
  doc.head.appendChild(s);
}

export class WerewolfScreen {
  constructor(root, hooks = {}) {
    this.root = root;
    this.hooks = hooks;
    /** 'watch' | 'join' —— 由主页第二层那张卡决定(showLobby 的参数) */
    this.mode = 'watch';
    this.humanSeat = null;
    this.kernel = null;
    this.runner = null;
    this.agents = new Map();
    this._abort = null;
    this.running = false;
    /** 本场积分(同一场连打多局累计;大厅「开始」或换人数时清空) */
    this.standings = new MatchStandings(0);
    /**
     * 这一场是否已经交给平台记过分(幂等闸)。
     * 「新开一场」/「退出本局」/「拆屏幕」三条路都会结算,同一次操作里
     * handleExit → onExitHome → 宿主 exitToHome → stopGame → destroy 会走好几条,
     * 没有这个标记一场会被记成好几场。
     */
    this._matchRecorded = false;
    /** 上帝视角看到的夜里动作(玩家模式不会往这里写) */
    this.nightActs = [];
    this.feed = [];
    this._pendingSnap = null;
    this._thinkingSeat = null;
    this._thinkingText = '';
    this._thinkingLive = false;
    this._actionBubble = null;
    this._actionTimer = null;
    this._toastTimer = null;
    this._humanResolve = null;
    this.destroyed = false;
    this._seenFeed = 0;
    /**
     * 回合(天)之间的闸门 —— 自动停顿 1.4s + 暂停/单步。
     * 屏幕持有它:一局重开/恢复时跟着新的 AbortSignal 重置,「暂停」不跨局保留。
     */
    this.roundGate = new RoundGate({
      holdMs: ROUND_HOLD_MS,
      onChange: (s) => this._paintPace(s),
    });
    /** 正在回合边界上(「第 N 天结束 → 第 N+1 天开始」),_render 用它覆盖天数标签 */
    this._roundEnd = null;

    ensureStyle(root.ownerDocument || document);

    root.innerHTML = `
      <div class="ww">
        <canvas id="wwGl" class="ww__gl"></canvas>
        <div class="grid-vignette"></div>

        <div class="ww__nightMask" id="wwNightMask" hidden>
          <div class="ww__nightHead"><b>天 黑 请 闭 眼</b><span id="wwNightSub"></span></div>
        </div>

        <header class="ww__top">
          <div class="ww__brand">
            <span class="ww__icon">🐺</span>
            <span class="ww__title">狼人杀</span>
            <span class="ww__tag" id="wwDayTag">未开局</span>
            <span class="ww__tag" id="wwPhaseTag"></span>
            <span class="ww__tag" id="wwRuleTag"></span>
          </div>
          <div class="ww__topBtns">
            <button class="btn btn--ghost" id="wwBtnPace" title="暂停在回合边界上,一天一看"><span class="ww__paceIcon">⏸</span><span class="ww__paceLabel"> 暂停</span></button>
            <button class="btn btn--ghost" id="wwBtnModels">🤖 模型</button>
            <button class="btn btn--ghost" id="wwBtnSetup">⚙ 设置</button>
            <button class="btn btn--ghost" id="wwBtnExit">↩ 退出本局</button>
          </div>
        </header>

        <!-- 观看模式:上帝面板(每个人真实的身份 + 夜里的每一步)。玩家模式下这个元素不会出现。 -->
        <aside class="ww__god" id="wwGod" hidden></aside>
        <!-- 本场积分榜(两种模式都有:用户要的「局内积分」) -->
        <aside class="ww__score" id="wwScore" hidden></aside>

        <!-- 玩家模式:我的身份卡 -->
        <section class="ww__me" id="wwMe" hidden></section>

        <!-- 公开信息:发言 / 票型 / 死讯时间线 -->
        <section class="ww__feed" id="wwFeed"></section>

        <aside class="ww__side" id="wwSide">
          <div class="ww__sideHead">现场记录</div>
          <div class="ww__log" id="wwLog"></div>
        </aside>

        <footer class="ww__action" id="wwAction" hidden></footer>

        <div class="hud">${bubbleHtml()}</div>
        <div class="ww__banner" id="wwBanner" hidden></div>
        <div class="toast" id="wwToast"></div>

        <div class="ww__lobby" id="wwLobby" hidden>
          <div class="ww__lobbyCard">
            <div class="ww__lobbyHead">
              <span class="ww__lobbyIcon">🐺</span>
              <div>
                <h2>狼人杀 <span class="ww__lobbySub">WEREWOLF</span></h2>
                <p id="wwLobbySub"></p>
              </div>
            </div>
            <div class="ww__fields">
              <label class="ww__field">人数
                <select id="wwSeats">
                  <option value="6">6 人(2 狼)</option>
                  <option value="7">7 人(2 狼)</option>
                  <option value="8">8 人(2 狼)</option>
                  <option value="9">9 人(3 狼)</option>
                  <option value="10">10 人(3 狼)</option>
                  <option value="11">11 人(3 狼)</option>
                  <option value="12">12 人(4 狼)</option>
                </select>
              </label>
              <label class="ww__field">胜负规则
                <select id="wwRule">
                  <option value="side">屠边(杀光平民 或 杀光神职)</option>
                  <option value="all">屠城(杀光所有好人)</option>
                </select>
              </label>
              <label class="ww__field">天数上限
                <select id="wwMaxDays">
                  <option value="4">4 天</option>
                  <option value="6">6 天(推荐)</option>
                  <option value="8">8 天</option>
                </select>
              </label>
            </div>
            <div class="ww__lobbyBtns">
              <button class="btn btn--primary btn--big" id="wwStart">开始</button>
              <button class="btn btn--ghost" id="wwResume" hidden>继续上一局</button>
              <button class="btn btn--ghost" id="wwModels">🤖 模型与 API Key</button>
              <button class="btn btn--ghost" id="wwBack">← 返回主页</button>
            </div>
            <p class="ww__lobbyNote" id="wwLobbyNote"></p>
          </div>
        </div>
      </div>`;

    const q = (id) => root.querySelector('#' + id);
    this.dom = {
      canvas: q('wwGl'), bubble: q('bubbleEl'),
      dayTag: q('wwDayTag'), phaseTag: q('wwPhaseTag'), ruleTag: q('wwRuleTag'),
      nightMask: q('wwNightMask'), nightSub: q('wwNightSub'),
      god: q('wwGod'), score: q('wwScore'), me: q('wwMe'), feed: q('wwFeed'),
      side: q('wwSide'), log: q('wwLog'), action: q('wwAction'),
      banner: q('wwBanner'), toast: q('wwToast'),
      lobby: q('wwLobby'), lobbySub: q('wwLobbySub'), lobbyNote: q('wwLobbyNote'),
      seats: q('wwSeats'), rule: q('wwRule'), maxDays: q('wwMaxDays'),
      start: q('wwStart'), resume: q('wwResume'),
      pace: q('wwBtnPace'),
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
    // 唯一的游戏道具:每人面前一张身份牌 + 中央的天/夜牌(道具层契约见 sceneCore/propLayer.js)
    this.props = new WerewolfProps();
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
    q('wwBtnModels')?.addEventListener('click', () => this.hooks.onModels?.());
    q('wwBtnPace')?.addEventListener('click', () => this._onPaceClick());
    q('wwBtnSetup')?.addEventListener('click', () => this.showLobby(this.mode));
    q('wwBtnExit')?.addEventListener('click', () => this.handleExit());
    this.dom.start?.addEventListener('click', () => { this._startNew(); });
    this.dom.resume?.addEventListener('click', () => this._resume());
    q('wwModels')?.addEventListener('click', () => this.hooks.onModels?.());
    q('wwBack')?.addEventListener('click', () => this.handleExit());

    this.store = createWerewolfStore({ getKernel: () => this.kernel });
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  /* ============================================================ 大厅 */

  /** 从配置里读狼人杀那一格(设置的真源是 games.werewolf) */
  _configValues() {
    const cfg = this.hooks.getConfig?.() || {};
    return { ...(cfg.games?.werewolf || {}) };
  }

  /**
   * 显示大厅。`mode` 是主页那张模式卡交回来的 'dealer' | 'player'
   * (界面历史叫法;狼人杀内部叫 watch / join)。
   */
  showLobby(mode = 'dealer') {
    if (this.destroyed) return;
    this.mode = mode === 'player' ? 'join' : 'watch';
    const v = this._configValues();
    const seats = Number(v.seats) || 9;
    if (this.dom.seats) this.dom.seats.value = String([6, 7, 8, 9, 10, 11, 12].includes(seats) ? seats : 9);
    if (this.dom.rule) this.dom.rule.value = v.winCondition === 'all' ? 'all' : 'side';
    if (this.dom.maxDays) this.dom.maxDays.value = String([4, 6, 8].includes(Number(v.maxDays)) ? v.maxDays : 6);
    this.dom.lobbySub.textContent = this.mode === 'join'
      ? '你也是桌上的一员:只知道自己的身份,天亮之后靠自己听、自己判断、自己投。'
      : '所有人的身份、夜里的每一步你都看得到 —— 看它怎么把谎圆下去。';
    if (this.dom.start) {
      this.dom.start.textContent = this.mode === 'join' ? '开始(我加入)' : '开始(看 AI 玩)';
    }
    // 上一局的存档(只在同一模式下才给继续;模式不同会出现「存档里没有你」的怪局)
    this._pendingSnap = null;
    try { this._pendingSnap = this.store?.loadValid?.() || null; } catch { this._pendingSnap = null; }
    const snapOk = !!this._pendingSnap
      && ((this._pendingSnap.config?.humanSeat === null) === (this.mode === 'watch'));
    if (this.dom.resume) {
      this.dom.resume.hidden = !snapOk;
      if (snapOk) {
        const d = this._pendingSnap.progress?.handNo || 1;
        this.dom.resume.textContent = `继续上一局(第 ${d} 天)`;
      }
    }
    this.dom.lobbyNote.textContent = this._pendingSnap && !snapOk
      ? '有一份存档,但它是另一种模式下的(观看 / 自己加入不能互换)—— 开新的一局即可。'
      : (this.standings.rounds
        ? `本场已打 ${this.standings.rounds} 局。点「开始」会**开新的一场**,积分清零。`
        : '');
    this.dom.lobby.hidden = false;
  }

  hideLobby() { this.dom.lobby.hidden = true; }

  _collect() {
    return {
      seats: Number(this.dom.seats?.value) || 9,
      winCondition: this.dom.rule?.value === 'all' ? 'all' : 'side',
      maxDays: Number(this.dom.maxDays?.value) || 6,
    };
  }

  /** 建每个座位的性格、显示名、立绘 —— 与扑克/卧底同一套规则(名字跟模型走) */
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
  _buildAgents(seats, humanSeat) {
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
      // 设置**只写 games.werewolf**(只对这个游戏生效);global 的模型/Key 不在这里碰
      try { await this.hooks.onSaveConfig?.({ games: { werewolf: cfg } }); } catch { /* 存不下设置也能玩 */ }
      this.humanSeat = this.mode === 'join' ? 0 : null;
      const seats = cfg.seats;
      const names = this._buildCast(seats, this.humanSeat);
      const kernel = createKernel({ ...cfg, humanSeat: this.humanSeat });
      // 大厅「开始」= 开新的一场 → 积分清零(结算后的「再来一局」才累计)
      // ★ 清零**之前**先把上一场的最终排名交出去(记全局分);顺序反了
      //   resize 已经把积分抹掉,结算出来全是 0。
      try { this._recordMatch(); } catch { /* 记分失败不阻断开局 */ }
      this.standings.resize(seats);
      this._matchRecorded = false;
      this._begin(kernel, names, { resume: false });
    } finally {
      this._busy = false;
    }
  }

  /** 同一场再来一局:清掉局面,保留积分与人数/规则 */
  _again() {
    if (this._busy || !this.kernel) return;
    const cfg = { ...this.kernel.config };
    const seats = cfg.seats;
    const names = this._buildCast(seats, this.humanSeat);
    const kernel = createKernel({ ...cfg, humanSeat: this.humanSeat });
    this._begin(kernel, names, { resume: false });
  }

  async _resume() {
    const snap = this._pendingSnap || this.store?.loadValid?.();
    if (!snap) { this.dom.lobbyNote.textContent = '那份存档读不出来了(可能已被清掉)。'; return; }
    try {
      const cfg = snap.config || {};
      const humanSeat = cfg.humanSeat ?? null;
      this.mode = humanSeat === null ? 'watch' : 'join';
      this.humanSeat = humanSeat;
      const seats = Number(cfg.seats) || 9;
      const names = this._buildCast(seats, humanSeat);
      const kernel = createKernel({ ...cfg, humanSeat });
      kernel.restore(snap);
      // 名字以存档里那份为准(不然「恢复」之后人全改名了)
      if (Array.isArray(snap.state?.names) && snap.state.names.length === seats) {
        for (let s = 0; s < seats; s++) if (snap.state.names[s]) names[s] = snap.state.names[s];
      }
      this._begin(kernel, names, { resume: true });
      this.toast(`已恢复:第 ${kernel.state.day} 天`, 'ok');
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
    const myAbort = new AbortController();
    this._abort = myAbort;
    const seats = kernel.state.alive.length;
    this.agents = this._buildAgents(seats, this.humanSeat);
    if (!this.standings.seats || this.standings.seats !== seats) this.standings.resize(seats);
    const human = this.humanSeat === null ? null : {
      seat: this.humanSeat,
      speak: (view) => this._askHumanSpeak(view),
      vote: (view) => this._askHumanVote(view),
      nightAct: (view, step) => this._askHumanNight(view, step),
    };
    this.dom.god.hidden = this.mode !== 'watch';
    this.dom.me.hidden = this.mode !== 'join';
    this.dom.banner.hidden = true;
    this.dom.log.innerHTML = '';
    this.feed = [];
    this._seenFeed = 0;
    this.nightActs = [];
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

    this.runner = new WerewolfRunner({
      kernel,
      agents: this.agents,
      human,
      delayMs: Number(this._configValues().speakDelayMs) || 0,
      // ★ 玩家模式**根本不给**私有夜间行动:事件对象里连 target 字段都没有
      revealSecrets: this.mode === 'watch',
      signal: this._abort.signal,
      roundGate: this.roundGate,
      // ★ 本场积分榜的公开快照 —— 提示词里的【你的最终目标】要用它。
      //   只有 seat / name / 积分(这张榜本来就画在侧栏上,是公开信息);
      //   身份 / 队友 / 刀口不在里面,也从这里进不去提示词。
      matchStandings: () => ({
        rounds: this.standings.rounds,
        ranking: this.standings.ranking().map((r) => ({
          seat: r.seat,
          name: this.personaMap.get(r.seat)?.name || `${r.seat + 1}号`,
          score: r.total,
        })),
      }),
      hooks: {
        names,
        onEvent: (ev) => this._onEvent(ev),
        onThinking: (seat) => { this._thinkingSeat = seat; this._thinkingText = ''; },
      },
    });
    this.running = true;
    this.hooks.onGameStarted?.();
    this._log(resume ? `恢复对局:第 ${kernel.state.day} 天` : `${seats} 人局开始,天黑请闭眼…`, 'ok');
    this.runner.run().catch((err) => {
      // ⚠️ 判断「是不是我被取消了」必须看**这一次 run 自己的** controller。
      //    看 this._abort 是不可靠的:重开一局时 this._abort 已经指向新的那个
      //    (它没被 abort),于是上一局的取消会被当成真错误闪一条
      //    「对局中断:调用已取消」的红色 toast —— 换模式 / 再来一局时必现。
      if (err?.canceled || myAbort.signal.aborted || this._abort !== myAbort) return;
      this._log(`对局中断:${err?.message || err}`, 'err');
      this.toast(`对局中断:${err?.message || err}`, 'err', 6000);
      this.running = false;
      this.hooks.onGameEnded?.();
    }).finally(() => {
      if (this.destroyed || this._abort !== myAbort) return;
      if (!this.running) this.dom.action.hidden = true;
    });
  }

  _teardownRun() {
    try { this.runner?.stop(); } catch { /* 忽略 */ }
    try { this._abort?.abort(); } catch { /* 忽略 */ }
    // 闸门里可能正挂着一次「等下一回合」—— 不放掉的话退出本局会留在 await 里
    try { this.roundGate?.clear(); } catch { /* 忽略 */ }
    this._roundEnd = null;
    this.runner = null;
    this._abort = null;
    this.running = false;
    this._resolveHuman(null);
  }

  /* ============================================================ 事件 */

  _onEvent(ev) {
    if (this.destroyed) return;
    switch (ev.type) {
      case 'start':
        this._log(`${ev.seats} 人局,角色构成 ${ev.roster.werewolf} 狼 / 预言家 / 女巫 / ${ev.roster.villager} 民`);
        break;
      case 'night':
        this.nightActs = [];
        this._log(`第 ${ev.day} 夜`, 'ok');
        break;
      case 'nightStep':
        this._log(`${ev.label}行动中…`);
        break;
      case 'nightSkip':
        this._log(`${STEP_LABEL[ev.step] || ev.step}:${ev.why}`, 'warn');
        break;
      case 'nightInvalid':
        this._log(`⚠ ${ev.message}`, 'warn');
        break;
      case 'nightAct':
        // 只有观看模式才会有 target/thinking 字段(玩家模式 runner 不填)
        this.nightActs.push(ev);
        this._log(`${seatLabel(ev.seat)} ${this._actText(ev)}`, ev.action === 'none' ? 'warn' : '');
        break;
      case 'dawn':
        this._thinkingSeat = null;
        this._thinkingLive = false;
        if (ev.peaceful) this._log(`第 ${ev.day} 天:平安夜`, 'ok');
        else this._log(`第 ${ev.day} 天:${ev.deaths.map((s) => seatLabel(s)).join('、')} 出局(身份不公开)`, 'warn');
        break;
      case 'speaker':
        this._thinkingSeat = ev.seat;
        this._thinkingText = '';
        this._thinkingLive = !ev.human;
        break;
      case 'speech':
        this._thinkingSeat = null;
        this._thinkingLive = false;
        this._actionBubble = { seat: ev.seat, say: (ev.say || []).slice(0, 1).join(''), text: '' };
        this._clearActionTimer();
        this._actionTimer = setTimeout(() => { this._actionBubble = null; this._render(); }, 2600);
        this._log(`${seatLabel(ev.seat)}:${(ev.say || []).join(' ')}${ev.quality === 'low' ? '(中性兜底)' : ''}`,
          ev.quality === 'low' ? 'warn' : '');
        this._persist();
        break;
      case 'voteStart':
        this._thinkingSeat = ev.seat;
        this._thinkingLive = true;
        break;
      case 'vote':
        this._thinkingSeat = null;
        this._thinkingLive = false;
        this._actionBubble = {
          seat: ev.from,
          say: '',
          text: ev.to === null ? '弃票' : `投 ${seatLabel(ev.to)}${ev.reason ? `(${ev.reason})` : ''}`,
        };
        this._clearActionTimer();
        this._actionTimer = setTimeout(() => { this._actionBubble = null; this._render(); }, 2400);
        this._log(`${seatLabel(ev.from)} ${ev.to === null ? '弃票' : `→ ${seatLabel(ev.to)}`}${ev.reason ? `:${ev.reason}` : ''}`);
        if (ev.consistency && !ev.consistency.explained) {
          this._log(`⚠ ${seatLabel(ev.from)} 改票未说明(发言说要投 ${seatLabel(ev.consistency.stake)})`, 'warn');
        }
        this._persist();
        break;
      case 'exile':
        this._log(`${seatLabel(ev.seat)} 以 ${ev.votes} 票被放逐(身份不公开)`, 'warn');
        this._persist();
        break;
      case 'tie':
        this._log(ev.text || '平票,无人出局');
        break;
      case 'round': {
        // 兼容事件:一条「新一天开始」的短日志(边界本身由 roundEnd/roundStart 负责)
        this._log(`第 ${ev.round} 天开始`, 'ok');
        this._persist();
        break;
      }
      case 'roundEnd':
        // ★ 回合边界。天数已经在**内核**里 +1 了,这里要同时说清「结束的是哪一天」,
        //   否则观众看到的就是标签悄悄从 2 跳成 3 —— 像卡了一下又突然变了。
        this._roundEnd = ev;
        this._log(`第 ${ev.round} 天结束 → 第 ${ev.next} 天开始${ev.eliminated?.length
          ? `(${ev.eliminated.map(seatLabel).join('、')} 被放逐)` : '(平票,无人出局)'}`, 'ok');
        this.toast(`第 ${ev.round} 天结束 → 第 ${ev.next} 天开始`, 'ok', 2200);
        this._persist();
        break;
      case 'roundStart':
        this._roundEnd = null;
        break;
      case 'stepError':
        // 一步没问出来(模型炸/解析失败)—— 降级继续,但现场记录里要看得见
        this._log(`⚠ ${seatLabel(ev.seat)} 这一步没问出来(${ev.step}),已降级继续:${ev.message}`, 'warn');
        break;
      case 'repair':
        this._log(`⚠ 状态自相矛盾(${ev.why}),已修复:${ev.fix}`, 'warn');
        break;
      case 'end': {
        this._thinkingSeat = null;
        this._thinkingLive = false;
        this._actionBubble = null;
        this._clearActionTimer();
        this.bubble?.hide?.();
        const win = ev.winner === 'werewolf' ? '狼人胜' : '好人胜';
        this._log(`${win}(${ev.reason})`, 'ok');
        // 结算 → 记进本场积分(用户要的「局内积分」,不跨场保留)
        const rows = this._recordScore();
        this.showBanner(win, `${this._endSubText()}<br>${this._scoreLine(rows)}`, true);
        this.toast(win, ev.winner === 'werewolf' ? 'warn' : 'ok', 4200);
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

  /* ============================================================ 节奏控制 */

  /**
   * 「暂停 / 下一回合 / 继续」—— 一个按钮三种含义,按闸门当前状态决定。
   *
   * 为什么需要:观看模式下一天要几十秒(夜里三步 + 一轮发言 + 一轮投票),
   * 想停下来看上帝面板、或者让「谁被放逐」多停一会儿,原来只能干瞪眼。
   * 三种状态**不叠加**:没暂停 → 点一下暂停;暂停且没停在边界 → 点一下继续;
   * 暂停且停在边界 → 点一下放行**这一天**。最后这条就是幂等:
   * 连点两下不会跳两天(闸门里只有一份等待,见 shared/roundGate.mjs)。
   */
  _onPaceClick() {
    const g = this.roundGate;
    if (!g) return;
    // 连点两下 = 一下:第二下如果变成「继续」,就会把「暂停」整个取消掉,
    // 在用户看来就是「点了两下下一回合,结果一路跑过去了」。350ms 内的重复点击直接忽略。
    const now = Date.now();
    if (now - (this._paceAt || 0) < 350) return;
    this._paceAt = now;
    if (!g.paused) { g.pause(); this.toast('已暂停:下一天边界会停住', 'info', 1800); }
    else if (g.waiting) { g.step(); }
    else { g.resume(); this.toast('继续', 'info', 1200); }
    this._paintPace();
  }

  /** 按钮文案跟着闸门状态走(暂停中停在边界 → 「下一回合」) */
  _paintPace(state = this.roundGate?.state) {
    const btn = this.dom?.pace;
    if (!btn) return;
    const s = state || { paused: false, waiting: false };
    const icon = btn.querySelector('.ww__paceIcon');
    const label = btn.querySelector('.ww__paceLabel');
    if (icon) icon.textContent = !s.paused ? '⏸' : (s.waiting ? '⏭' : '▶');
    if (label) label.textContent = !s.paused ? ' 暂停' : (s.waiting ? ' 下一回合' : ' 继续');
    btn.title = !s.paused ? '暂停在回合边界上,一天一看'
      : (s.waiting ? '放行这一天(下一回合)' : '继续自动推进');
    btn.classList.toggle('is-armed', !!(s.paused && s.waiting));
  }

  _actText(ev) {    if (ev.action === 'kill') return `刀 ${seatLabel(ev.target)}`;
    if (ev.action === 'check') return `验 ${seatLabel(ev.target)}`;
    if (ev.action === 'save') return `用解药救 ${seatLabel(ev.target)}`;
    if (ev.action === 'poison') return `用毒药毒 ${seatLabel(ev.target)}`;
    return '这一晚没有动作';
  }

  /** 结算时把这一局记进本场积分榜,返回这一局的 score 行 */
  _recordScore() {
    if (!this.kernel) return [];
    try {
      const r = this.standings.addRound(this.kernel.state);
      this._lastRows = r.rows;
      return r.rows;
    } catch (err) {
      this._log(`积分计算失败:${err?.message || err}`, 'warn');
      return [];
    }
  }

  /** 一行积分摘要(给结算横幅) */
  _scoreLine(rows = this._lastRows || []) {
    if (!rows.length) return '';
    const top = [...rows].sort((a, b) => b.delta - a.delta)[0];
    return `本场第 ${this.standings.rounds} 局 · 本局最高:${seatLabel(top.seat)} +${top.delta}`;
  }

  _endSubText() {
    const st = this.kernel?.state;
    if (!st) return '';
    const wolves = st.roles.map((r, s) => (r === 'werewolf' ? seatLabel(s) : null)).filter(Boolean);
    const gods = st.roles.map((r, s) => (r === 'seer' || r === 'witch' ? `${seatLabel(s)}${ROLE_LABEL[r]}` : null)).filter(Boolean);
    return `狼人:${wolves.join('、')}<br>神职:${gods.join('、')}<br>规则:${st.config.winCondition === 'all' ? '屠城' : '屠边'}`;
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
    // ★ 两种模式在这里分流:玩家模式拿到的对象里根本没有别人的身份
    const view = buildRenderView(st, { mode: this.mode, humanSeat: this.humanSeat });
    this._lastView = view;

    // 玩家模式左上角有一张「我的身份」卡,积分榜要往下让一格(否则两块面板叠在一起)。
    // 用 class 而不是 inline style:桌面让 146px、手机横屏让 96px,规则都在 theme.js 里。
    const shell = this.root.querySelector('.ww');
    if (shell) shell.classList.toggle('is-join', this.mode === 'join');

    const night = st.phase === 'night';
    this.dom.dayTag.textContent = st.phase === 'idle' ? '未开局'
      : this._roundEnd ? `第 ${this._roundEnd.next} 天`
        : night ? `第 ${st.day} 夜` : `第 ${st.day} 天 / 共 ${st.config.maxDays} 天`;
    // 回合边界上:阶段标签改成「第 N 天结束 →」,让「刚才那一天结束了」这件事
    // 在画面上**停留**一会儿(自动推进约 1.4s;暂停时一直停着,直到按「下一回合」)
    this.dom.phaseTag.textContent = this._roundEnd
      ? `第 ${this._roundEnd.round} 天结束 →`
      : night
        ? `夜晚 · ${STEP_LABEL[st.nightStep] || ''}`
        : (PHASE_LABEL[st.phase] || '');
    this.dom.phaseTag.classList.toggle('is-night', night && !this._roundEnd);
    this.dom.phaseTag.classList.toggle('is-vote', st.phase === 'vote' && !this._roundEnd);
    this.dom.phaseTag.classList.toggle('is-boundary', !!this._roundEnd);
    this.dom.ruleTag.textContent = st.config.winCondition === 'all' ? '屠城' : '屠边';

    // 天黑遮罩:夜里盖上(两种模式都盖 —— 玩家也是「闭眼」的)
    this.dom.nightMask.hidden = !night;
    if (night) {
      this.dom.nightSub.textContent = this.mode === 'watch'
        ? `第 ${st.day} 夜 · 狼人 → 预言家 → 女巫`
        : `第 ${st.day} 夜 · 天亮了才知道昨晚发生了什么`;
    }

    // 上帝面板:只有观看模式才画(玩家模式连 DOM 都不填)
    if (this.mode === 'watch') this._renderGod(view, night);
    else this.dom.god.innerHTML = '';

    if (this.mode === 'join') this._renderMe(view);
    this._renderFeed(view);
    this._renderScore();

    // 3D:通用座位视图 + 狼人杀自己的一层 ctx(labels 里该有谁,由上面的 view 决定)
    const actor = night ? (this._thinkingSeat ?? null)
      : st.phase === 'day' ? (st.order[st.orderIdx] ?? null)
        : st.phase === 'vote' ? (this.kernel.pendingVoters()[0] ?? null) : null;
    const labels = this._buildLabels(view, st);
    this.table.update(buildTableViewModel(st, { actor }), {
      labels,
      phaseText: st.phase === 'end'
        ? (st.winner === 'werewolf' ? '狼人胜' : '好人胜')
        : this._roundEnd ? `第 ${this._roundEnd.round} 天结束 → 第 ${this._roundEnd.next} 天`
          : night ? `第 ${st.day} 夜` : `第 ${st.day} 天 · ${PHASE_LABEL[st.phase] || ''}`,
      phaseHint: st.phase === 'end' ? '点「设置」可以再来一局'
        : `存活 ${st.alive.filter(Boolean).length} 人 · ${st.config.winCondition === 'all' ? '屠城' : '屠边'}`,
      night,
      thinkingSeat: this._thinkingSeat,
    });

    // 气泡:玩家模式不给别人的思考文字(revealThinking:false → 只显示「正在思考中…」)
    this.bubble.update(this._bubbleCtx(), this.personaMap);
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
   * 道具层要的 labels。
   *
   * ⚠️ 玩家模式**只给自己那一格 roleLabel** —— 别人的卡片画成「?」,
   *    而不是「画上了再遮住」。出局是公开信息,所以 dead/voted/say 两种模式都传。
   */
  _buildLabels(view, st) {
    const out = {};
    const curVotes = new Map();
    for (const e of st.events) {
      if (e.kind === 'vote' && e.day === st.day && e.target !== null) curVotes.set(e.seat, e.target);
    }
    const lastSay = new Map();
    for (const e of st.events) {
      if (e.kind === 'speech') lastSay.set(e.seat, (e.say || []).join(' '));
    }
    for (const s of view.seats) {
      // 观看模式的 view.seats 带 roleLabel;玩家模式的只有 {seat,name,alive}
      const roleLabel = this.mode === 'watch'
        ? (s.roleLabel || '')
        : (s.seat === this.humanSeat ? ROLE_LABEL[view.me?.role] : '');
      out[s.seat] = {
        seat: s.seat,
        name: s.name || '',
        roleLabel,
        dead: !s.alive,
        voted: curVotes.has(s.seat) ? curVotes.get(s.seat) : null,
        say: lastSay.get(s.seat) || '',
      };
    }
    return out;
  }

  _renderGod(view, night) {
    const st = this.kernel.state;
    const rows = view.seats.map((s) => {
      const role = s.role === 'werewolf' ? '<b class="is-wolf">狼人</b>'
        : s.role === 'villager' ? '<span class="is-good">平民</span>'
          : `<b class="is-god">${ROLE_LABEL[s.role] || s.role}</b>`;
      const lastSay = [...st.events].reverse()
        .find((e) => e.kind === 'speech' && e.seat === s.seat);
      // 面板里只放**一句的摘要**:完整发言在下面的时间线里。
      // 不截断的话(模型一开口 200 字)整张表会被撑到半屏高。
      const raw = lastSay ? (lastSay.say || []).join(' ') : '';
      const brief = raw.length > 34 ? `${raw.slice(0, 34)}…` : raw;
      return `<tr class="${s.alive ? '' : 'is-out'}">
        <td>${s.seat + 1}号</td>
        <td class="ww__name">${esc(s.name)}</td>
        <td>${role}</td>
        <td class="ww__say">${esc(brief || '—')}</td>
      </tr>`;
    }).join('');
    const nightInfo = night ? this._nightInfoHtml() : '';
    this.dom.god.innerHTML = `
      <div class="ww__panelHead">
        <span>上帝视角 · ${esc(view.rosterText)}</span>
        <span class="ww__panelHint">${st.config.winCondition === 'all' ? '屠城' : '屠边'} · 第 ${st.day} ${night ? '夜' : '天'} · 存活 ${st.alive.filter(Boolean).length} 人</span>
      </div>
      <table class="ww__table">
        <thead><tr><th>座位</th><th>名字</th><th>身份</th><th>最近一句</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${nightInfo}`;
    this.dom.god.hidden = false;
  }

  /** 夜里的动作清单(只有观看模式会用到 target/thinking) */
  _nightInfoHtml() {
    if (!this.nightActs.length) return '<div class="ww__nightActs">夜里的动作会一条条出现在这里。</div>';
    const lines = this.nightActs.map((a) => `<div>· ${seatLabel(a.seat)} ${esc(this._actText(a))}`
      + `${a.thinking ? ` <span class="ww__panelHint">「${esc(String(a.thinking).slice(0, 40))}」</span>` : ''}</div>`).join('');
    return `<div class="ww__nightActs"><b>今晚发生了什么</b>${lines}</div>`;
  }

  _renderMe(view) {
    const me = view.me || {};
    const alive = me.alive;
    const extra = me.role === 'werewolf'
      ? `你的队友:${(me.teammates || []).map((t) => `${seatLabel(t.seat)}${t.alive ? '' : '(已出局)'}`).join('、') || '没有(你是最后一狼)'}`
      : me.role === 'seer'
        ? `查验记录:${(me.checks || []).map((c) => `${seatLabel(c.target)}=${c.result === 'wolf' ? '狼' : '好'}`).join('、') || '还没有'}`
        : me.role === 'witch'
          ? `药:解药${me.witch?.antidote ? '在' : '已用'} · 毒药${me.witch?.poison ? '在' : '已用'}`
          : '你没有夜间技能:只有一张票和一张嘴。';
    this.dom.me.innerHTML = `
      <div class="ww__meLabel">你的身份</div>
      <div class="ww__meRole">${esc(me.roleLabel || '')}</div>
      <div class="ww__meHint">${esc(extra)}</div>
      <div class="ww__meHint">${alive
    ? '别人只知道「有人在说谎」—— 你的身份只有你自己和主持人知道。'
    : '你已经出局了,只能看着他们继续。'}</div>`;
    this.dom.me.classList.toggle('is-out', !alive);
  }

  /** 公开信息时间线:死讯 / 发言 / 票型 / 放逐(全部来自公开事件) */
  _renderFeed(view) {
    const items = [];
    const st = this.kernel.state;
    for (const e of st.events) {
      if (e.visibility !== 'public') continue;
      if (e.kind === 'dawn') {
        items.push(`<div class="ww__item ww__itemDeath"><span class="ww__itemSys">第 ${e.day} 天 · </span>`
          + `${(e.deaths || []).length ? `${e.deaths.map((s) => seatLabel(s)).join('、')} 出局(身份不公开)` : '平安夜'}</div>`);
      } else if (e.kind === 'speech') {
        items.push(`<div class="ww__item${e.quality === 'low' ? ' ww__itemLow' : ''}">`
          + `<span class="ww__itemWho">${seatLabel(e.seat)}</span>:${esc((e.say || []).join(' '))}</div>`);
      } else if (e.kind === 'vote') {
        items.push(`<div class="ww__item ww__itemVote">`
          + `<span class="ww__itemWho">${seatLabel(e.seat)}</span> ${e.target === null ? '弃票' : `→ ${seatLabel(e.target)}`}`
          + `${e.reason ? `(${esc(e.reason)})` : ''}</div>`);
      } else if (e.kind === 'exile') {
        items.push(`<div class="ww__item ww__itemDeath"><span class="ww__itemWho">${seatLabel(e.seat)}</span> 以 ${e.votes} 票被放逐(身份不公开)</div>`);
      } else if (e.kind === 'tie') {
        items.push(`<div class="ww__item ww__itemSys">${esc(e.text)}</div>`);
      }
    }
    const head = `<div class="ww__feedHead">现场 <span>第 ${st.day} ${st.phase === 'night' ? '夜' : '天'}`
      + ` · 存活 ${st.alive.filter(Boolean).length} 人 · ${st.config.winCondition === 'all' ? '屠城' : '屠边'}</span></div>`;
    this.dom.feed.innerHTML = head + (items.length ? items.slice(-40).join('') : '<div class="ww__item ww__itemSys">还没有公开发言。</div>');
    this.dom.feed.scrollTop = this.dom.feed.scrollHeight;
    void view;
  }

  /** 本场积分榜(打完一局之后才有内容) */
  _renderScore() {
    if (!this.standings.rounds) { this.dom.score.hidden = true; return; }
    const rank = this.standings.ranking();
    const rows = rank.map((r) => `<tr>
      <td>${r.rank}</td>
      <td>${seatLabel(r.seat)}</td>
      <td class="ww__name">${esc(this.personaMap.get(r.seat)?.name || '')}</td>
      <td><b>${r.total}</b></td>
      <td class="ww__say">+${r.lastDelta}</td>
    </tr>`).join('');
    this.dom.score.innerHTML = `
      <div class="ww__panelHead">
        <span>本场积分 · 第 ${this.standings.rounds} 局</span>
        <span class="ww__panelHint">参与+1 / 阵营胜+3 / 存活+1 / MVP+1~2(只在**这一场**累计)</span>
      </div>
      <table class="ww__table">
        <thead><tr><th>#</th><th>座位</th><th>名字</th><th>总分</th><th>本局</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    this.dom.score.hidden = false;
  }

  _log(text, kind = '') {
    const line = el('div', `ww__logLine${kind ? ` is-${kind}` : ''}`, text);
    this.dom.log.appendChild(line);
    while (this.dom.log.children.length > 200) this.dom.log.removeChild(this.dom.log.firstChild);
    this.dom.log.scrollTop = this.dom.log.scrollHeight;
  }

  /* ============================================================ 玩家操作 */

  _clearActionTimer() {
    if (this._actionTimer) { clearTimeout(this._actionTimer); this._actionTimer = null; }
  }

  _resolveHuman(result) {
    const r = this._humanResolve;
    this._humanResolve = null;
    this.dom.action.hidden = true;
    this.dom.action.innerHTML = '';
    // 手机上操作区会占掉底部一整条:撤掉标记,时间线/现场记录才能回到原位
    this.root.querySelector('.ww')?.classList.remove('is-acting');
    if (r) r(result);
  }

  _waitHuman(build) {
    return new Promise((resolve) => {
      this._humanResolve = resolve;
      this.dom.action.innerHTML = '';
      this.dom.action.hidden = false;
      // ★ 手机横屏「时间线」和「操作区」都在底部,不加这个标记就会叠在一起
      const shell = this.root.querySelector('.ww');
      shell?.classList.add('is-acting');
      build(this.dom.action, (result) => this._resolveHuman(result));
      // 操作区高度由 JS 量出来写进 CSS 变量(与扑克的 --actionbar-h 同一个做法),
      // 时间线/现场记录用 calc() 让开它 —— 写死数字必然被改结构的人改坏。
      // ⚠️ 同步量一次(强制布局)+ 下一帧补量一次:只靠 rAF 会拿到旧值,
      //    面板就仍按兜底的 74px 让位,底部被操作区压掉几十像素。
      this._measureAction();
      requestAnimationFrame(() => this._measureAction());
    });
  }

  /** 把操作区的实测高度写进 --ww-act-h(手机横屏的面板让位靠它) */
  _measureAction() {
    const shell = this.root.querySelector('.ww');
    if (!shell || !this.dom.action || this.dom.action.hidden) return;
    shell.style.setProperty('--ww-act-h', `${Math.ceil(this.dom.action.offsetHeight)}px`);
  }

  /**
   * 玩家发言:一个输入框 + 一条代码级过滤。
   * ⚠️ 玩家自己也可能「说漏嘴」(狼人玩家打出「我们狼队」),
   *    所以和 AI 走同一个过滤器 —— 规则对人不该更松。
   */
  _askHumanSpeak(view) {
    return this._waitHuman((box, done) => {
      const wrap = el('div', 'ww__act');
      wrap.innerHTML = `
        <div class="ww__actHead">轮到你发言(第 ${view.day} 天)</div>
        <div class="ww__actRow">
          <input class="ww__input" id="wwSayInput" maxlength="220" placeholder="一到三句话:怀疑谁、信谁、这一票给谁">
          <button class="btn btn--primary" id="wwSayGo">说</button>
          <button class="btn btn--ghost" id="wwSayAuto" title="让系统给一句确定性的中性发言">随便说一句</button>
        </div>
        <div class="ww__actNote" id="wwSayNote">不要说出自己的狼队友或夜里真实刀口 —— 那是自曝。</div>`;
      box.appendChild(wrap);
      const input = wrap.querySelector('#wwSayInput');
      const note = wrap.querySelector('#wwSayNote');
      input.focus();
      const submit = () => {
        const raw = String(input.value || '').replace(/\s+/g, ' ').trim();
        const bubbles = raw.split(/(?<=[。!?！?；;])/).map((s) => cleanBubble(s, 60)).filter(Boolean).slice(0, 4);
        if (!bubbles.length || !/\p{Script=Han}/u.test(bubbles.join(''))) {
          note.textContent = '要一句中文发言。'; return;
        }
        const leak = bubbles.map((b) => checkReasonLeak(b)).find(Boolean);
        if (leak) { note.textContent = `这句不能公开说:${leak.why}。改一下。`; return; }
        done({ say: bubbles, thinking: '', stake: null });
      };
      wrap.querySelector('#wwSayGo').addEventListener('click', submit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      wrap.querySelector('#wwSayAuto').addEventListener('click', () => {
        done({ say: neutralSpeech(view.seat, view.day), thinking: '', stake: null, quality: 'low' });
      });
    });
  }

  /** 玩家投票:按钮 + 可选理由;投自己 / 已出局的人不会出现在按钮里 */
  _askHumanVote(view) {
    return this._waitHuman((box, done) => {
      const wrap = el('div', 'ww__act');
      const btns = view.voteCandidates.map((seat) => {
        const p = this.personaMap.get(seat);
        return `<button class="btn btn--ghost ww__voteBtn" data-seat="${seat}">
          <b>${seat + 1}号</b>${p ? ` ${esc(p.name)}` : ''}</button>`;
      }).join('');
      const stake = Number.isInteger(view.myStakeToday) ? view.myStakeToday : null;
      wrap.innerHTML = `
        <div class="ww__actHead">轮到你投票${stake !== null ? ` —— 你发言里说了要投 ${seatLabel(stake)}` : ''}</div>
        <div class="ww__actRow">
          ${btns}
          <button class="btn btn--ghost" data-seat="abstain">弃票</button>
        </div>
        <div class="ww__actRow">
          <input class="ww__input" id="wwVoteReason" maxlength="25" placeholder="公开理由(可留空,≤25 字)">
        </div>`;
      box.appendChild(wrap);
      const reasonEl = wrap.querySelector('#wwVoteReason');
      wrap.querySelectorAll('.ww__voteBtn, [data-seat="abstain"]').forEach((b) => {
        b.addEventListener('click', () => {
          const raw = b.dataset.seat;
          const reason = cleanBubble(reasonEl.value, 25);
          // 理由泄漏不弃票:票是动作,理由只是修辞(与 agent.vote 的处理一致)
          const leak = checkReasonLeak(reason);
          done({
            target: raw === 'abstain' ? null : Number(raw),
            reason: leak ? '' : reason,
          });
        });
      });
    });
  }

  /** 玩家夜间行动:按钮按角色/阶段变 */
  _askHumanNight(view, step) {
    return this._waitHuman((box, done) => {
      const wrap = el('div', 'ww__act');
      const alive = view.seats.filter((s) => s.alive).map((s) => s.seat);
      const mates = new Set((view.me.teammates || []).map((t) => t.seat));
      let pool = alive.filter((s) => s !== view.seat);
      let head = '';
      if (step === 'wolves') {
        pool = pool.filter((s) => !mates.has(s));
        head = '狼人行动:今晚刀谁?';
      } else if (step === 'seer') {
        head = '预言家行动:今晚验谁?';
      } else {
        const w = view.me.witch || {};
        const kill = w.killTarget;
        head = `女巫行动:今晚被刀的是 ${kill === null || kill === undefined ? '(没人被刀)' : seatLabel(kill)}`;
        if (kill === null || kill === undefined || !w.antidote) pool = pool.filter(() => false);
        else pool = [kill].filter((s) => s !== view.seat);
      }
      const btns = pool.map((seat) => `<button class="btn btn--ghost ww__voteBtn" data-seat="${seat}">${seatLabel(seat)}</button>`).join('');
      const noneText = step === 'wolves' ? '空刀' : step === 'seer' ? '不验' : '不用药';
      const saveBtn = step === 'witch' && (view.me.witch?.antidote) && view.me.witch?.killTarget !== null
        && view.me.witch?.killTarget !== undefined
        ? `<button class="btn btn--ghost" data-act="save">用解药救 ${seatLabel(view.me.witch.killTarget)}</button>` : '';
      wrap.innerHTML = `
        <div class="ww__actHead">${esc(head)}</div>
        <div class="ww__actRow">
          ${btns}
          ${saveBtn}
          <button class="btn btn--ghost" data-seat="none">${noneText}</button>
        </div>
        <div class="ww__actNote">选了就生效 —— 夜里没有撤回。</div>`;
      box.appendChild(wrap);
      wrap.querySelectorAll('[data-seat], [data-act]').forEach((b) => {
        b.addEventListener('click', () => {
          if (b.dataset.act === 'save') { done({ action: 'save', target: view.me.witch.killTarget }); return; }
          const raw = b.dataset.seat;
          if (raw === 'none') { done({ action: 'none', target: null }); return; }
          const action = step === 'wolves' ? 'kill' : step === 'seer' ? 'check' : 'poison';
          done({ action, target: Number(raw) });
        });
      });
    });
  }

  /* ============================================================ 存档 */

  _persist() {
    if (!this.kernel || !this.running) return;
    try { this.store?.save(); } catch (err) { console.warn('[werewolf] 存档失败', err); }
  }

  /* ============================================================ 3D 循环 */

  _resize() {
    this._baseResize?.();
    const w = this.dom.canvas.clientWidth || window.innerWidth || 1440;
    const h = this.dom.canvas.clientHeight || window.innerHeight || 800;
    const aspect = Math.max(0.6, w / Math.max(1, h));
    this.table.layoutTable?.(aspect);
    const seats = this.kernel?.state.alive.length || 9;
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

  /**
   * 结算横幅。
   * @param {string} title
   * @param {string} sub 允许 <br>(内部拼的,不含用户输入)
   * @param {boolean} [withAgain] 是否带「再来一局(同一场继续)」
   */
  showBanner(title, sub = '', withAgain = false) {
    this.dom.banner.innerHTML = `<b>${esc(title)}</b><span>${sub}</span>`;
    if (withAgain) {
      const btn = el('button', 'btn btn--primary', '再来一局(本场继续)');
      btn.style.marginTop = '10px';
      btn.addEventListener('click', () => { this.dom.banner.hidden = true; this._again(); });
      this.dom.banner.appendChild(btn);
    }
    this.dom.banner.hidden = false;
  }

  /**
   * 一场结束 → 把**本场最终排名**交给平台(壳据此折成全局分、写排行榜)。
   *
   * 「一场」= 从大厅点「开始」到退出/再点「开始」之间的所有局
   * (与 MatchStandings 的口径一致)。结算卡/侧栏里的本场积分照旧显示,
   * 这一步只是**多写一次排行榜**。
   *
   * ⚠️ 幂等:新开一场 / 退出本局 / 拆屏幕都会调到这里,同一次操作里
   *    真会走好几条路(handleExit → onExitHome → stopGame → destroy)。
   * ⚠️ 一局都没打完(rounds=0)不记 —— 否则「全员 0 分」会凭空排出冠军。
   */
  _recordMatch() {
    if (this._matchRecorded) return;
    if (!this.standings || !this.standings.rounds) return;
    this._matchRecorded = true;
    try {
      const summary = matchSummaryOf(this.standings, {
        nameOf: (seat) => this.personaMap.get(seat)?.name || `${seat + 1}号`,
      });
      if (summary) this.hooks.onMatchEnded?.(summary);
    } catch (err) {
      // 记不上分绝不能让退出/开新局卡住 —— 最坏是丢一场战绩
      console.warn('[werewolf] 本场结算失败', err);
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
  buildSeats(n) { if (this.table) this.table.buildSeats(Number(n) || 9); }
  applyPortraits() { this.table?.applyPortraits?.(); }
  updateSeats() {}

  destroy() {
    // ★ 先把这一场交出去再拆(幂等):destroy 是最后一条还能拿到积分榜的路。
    try { this._recordMatch(); } catch { /* 记分失败不阻断拆除 */ }
    this.destroyed = true;
    this._teardownRun();
    if (this._actionTimer) clearTimeout(this._actionTimer);
    if (this._toastTimer) clearTimeout(this._toastTimer);
    try { this.table?.destroy?.(); } catch { /* 忽略 */ }
    try { this.props?.destroy?.(); } catch { /* 忽略 */ }
    // ⚠️ 这里**不** renderer.dispose():createStage 在 window 上挂了 resize 监听
    //    (那是场景核心的公共实现,拿不到句柄去摘),dispose 之后一次窗口缩放
    //    就会对已销毁的上下文调 setSize 并抛错。canvas 会随 root.innerHTML 一起消失。
    this.root.innerHTML = '';
  }
}
