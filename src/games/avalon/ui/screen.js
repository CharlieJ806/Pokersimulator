/**
 * 「阿瓦隆」的画面 —— 3D 桌 + HTML 面板 + 两种模式(观看 / 自己加入)。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么屏幕**自己**驱动整局(而不是像扑克那样由 app.js 一手一手地点)
 *
 * 阿瓦隆是**轮次制**的:队长选人 → 投票 → 上车 → 下一轮,流程是一个循环,
 * 而节奏、气泡、面板、进度条全绑在一起。拆给宿主只会让 app.js 多出一条
 * 只有阿瓦隆才走的驱动分支 —— 那正是重构要拆掉的那种耦合。
 * 所以这里:屏幕持有 kernel + runner,自己跑;宿主只提供「模型配置 / 保存设置 /
 * 打开模型面板 / 回主页」这几个回调(见 index.mjs 的 mount)。
 *
 * ────────────────────────────────────────────────────────────────
 * 信息隔离在画面上的落点(用户明确要求:**渲染前就不取**)
 *
 * 玩家模式只调 view.js 的 buildRenderView(state, {mode:'join'}) ——
 * 它返回的对象**没有**别人的身份、**没有**别人的任务卡。这里所有 DOM/3D
 * 文本都从那一份对象取,所以不存在「先渲染再 CSS 隐藏」的路径:
 * 别人的身份根本没有进入这个屏幕的数据流(道具层的 labels 里也只有自己那一格有
 * roleLabel,别人的卡片画成「?」)。
 * 观看模式才走 buildGodView,并且**只有那一条分支**会画上帝面板。
 * 同理,runner 在玩家模式下拿到 revealSecrets:false —— 谁出了失败卡
 * **连事件对象里都没有**,屏幕想画也画不出来。
 *
 * 3D 用的是共享场景:sceneCore(房间/桌椅/座位/立绘/相机/气泡)+ props/avalon
 * 的道具层(每人面前一张状态牌 + 桌面中央的任务牌与五轮进度)。
 * sceneCore 一行都没为阿瓦隆改过。
 */

import * as THREE from '../../../../vendor/three.module.js';
import { createStage, addLights, addRoom } from '../../../ui3d/sceneCore/stage.js';
import { Table3D } from '../../../ui3d/sceneCore/table.js';
import { bubbleHtml, ThinkingBubble } from '../../../ui3d/sceneCore/bubble.js';
import { AvalonProps } from '../../../ui3d/props/avalon/missionProps.js';
import { createKernel } from '../engine/kernel.js';
import { buildRenderView, buildTableViewModel } from '../view.js';
import { AvalonRunner } from '../runner.js';
import { createAvalonStore } from '../store.js';
import { assignPersonas } from '../personas.js';
import { MatchStandings } from '../scoring.js';
import { cleanBubble, checkReasonLeak, neutralReason } from '../filter.js';
import { roleLabel, rosterText } from '../engine/kernel.js';
import { AVALON_CSS } from './theme.js';
import {
  characterForModel, assignAccents, GENERIC_CHAR, displayNameForModel, assignDisplayNames,
} from '../../../ai/portraits.js';
import { preloadPortraits } from '../../../ui3d/sceneCore/portraits2d.js';

const PHASE_LABEL = {
  idle: '未开局', team: '组队', vote: '投票', mission: '任务', assassinate: '刺杀', end: '结束',
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
function seatsText(list) { return (list || []).map((s) => seatLabel(s)).join('、'); }

/** 建一块阿瓦隆屏幕(index.mjs 的 mount 用它;壳只拿返回值当通用界面句柄) */
export function createScreen(root, hooks = {}) {
  return new AvalonScreen(root, hooks);
}

/** 样式只注入一次(同一页面反复进出这个游戏不该堆一堆 <style>) */
function ensureStyle(doc) {
  if (!doc || doc.querySelector('style[data-avalon]')) return;
  const s = doc.createElement('style');
  s.setAttribute('data-avalon', '1');
  s.textContent = AVALON_CSS;
  doc.head.appendChild(s);
}

export class AvalonScreen {
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
    /** 上帝视角看到的任务卡(玩家模式不会往这里写) */
    this.cardActs = [];
    this._pendingSnap = null;
    this._thinkingSeat = null;
    this._thinkingText = '';
    this._thinkingLive = false;
    this._actionBubble = null;
    this._actionTimer = null;
    this._toastTimer = null;
    this._humanResolve = null;
    this.destroyed = false;
    /** 本轮票型(还没揭晓时为空;揭晓后是 [{seat,approve,reason}]) —— 只用于画牌 */
    this.liveVotes = [];
    this.liveCards = [];
    this._busy = false;

    ensureStyle(root.ownerDocument || document);

    root.innerHTML = `
      <div class="av">
        <canvas id="avGl" class="av__gl"></canvas>
        <div class="grid-vignette"></div>

        <header class="av__top">
          <div class="av__brand">
            <span class="av__icon">⚔️</span>
            <span class="av__title">阿瓦隆</span>
            <span class="av__tag" id="avRoundTag">未开局</span>
            <span class="av__tag" id="avPhaseTag"></span>
            <span class="av__tag" id="avRuleTag"></span>
          </div>
          <div class="av__topBtns">
            <button class="btn btn--ghost" id="avBtnModels">🤖 模型</button>
            <button class="btn btn--ghost" id="avBtnSetup">⚙ 设置</button>
            <button class="btn btn--ghost" id="avBtnExit">↩ 退出本局</button>
          </div>
        </header>

        <!-- 五轮任务进度(公开信息):顶栏下面那一条 -->
        <div class="av__track" id="avTrack" hidden>
          <span id="avTrackText">任务 0 / 0</span>
          <span class="av__trackDots" id="avTrackDots"></span>
        </div>

        <!-- 观看模式:上帝面板(每个人真实的身份 + 这一轮的票/卡)。玩家模式下这个元素不会出现。 -->
        <aside class="av__god" id="avGod" hidden></aside>
        <!-- 本场积分榜(两种模式都有:用户要的「局内积分」) -->
        <aside class="av__score" id="avScore" hidden></aside>

        <!-- 玩家模式:我的身份卡 -->
        <section class="av__me" id="avMe" hidden></section>

        <!-- 公开信息:提名 / 票型 / 任务结果 / 刺杀 -->
        <section class="av__feed" id="avFeed"></section>

        <aside class="av__side" id="avSide">
          <div class="av__sideHead">现场记录</div>
          <div class="av__log" id="avLog"></div>
        </aside>

        <footer class="av__action" id="avAction" hidden></footer>

        <div class="hud">${bubbleHtml()}</div>
        <div class="av__banner" id="avBanner" hidden></div>
        <div class="toast" id="avToast"></div>

        <div class="av__lobby" id="avLobby" hidden>
          <div class="av__lobbyCard">
            <div class="av__lobbyHead">
              <span class="av__lobbyIcon">⚔️</span>
              <div>
                <h2>阿瓦隆 <span class="av__lobbySub">AVALON</span></h2>
                <p id="avLobbySub"></p>
              </div>
            </div>
            <div class="av__fields">
              <label class="av__field">人数
                <select id="avSeats">
                  <option value="5">5 人(3 好 / 2 坏)</option>
                  <option value="6">6 人(4 好 / 2 坏)</option>
                  <option value="7">7 人(4 好 / 3 坏 · 有莫德雷德)</option>
                  <option value="8">8 人(5 好 / 3 坏 · 有莫德雷德)</option>
                  <option value="9">9 人(6 好 / 3 坏 · 有莫德雷德)</option>
                  <option value="10">10 人(6 好 / 4 坏 · 有莫德雷德 + 爪牙)</option>
                </select>
              </label>
              <label class="av__field">角色变体
                <select id="avVariant">
                  <option value="classic">完整版(梅林 / 派西维尔 / 忠臣 + 刺客 / 莫甘娜 / 莫德雷德 / 爪牙)</option>
                  <option value="plain">简化版(没有派西维尔与莫甘娜)</option>
                </select>
              </label>
            </div>
            <div class="av__lobbyBtns">
              <button class="btn btn--primary btn--big" id="avStart">开始</button>
              <button class="btn btn--ghost" id="avResume" hidden>继续上一局</button>
              <button class="btn btn--ghost" id="avModels">🤖 模型与 API Key</button>
              <button class="btn btn--ghost" id="avBack">← 返回主页</button>
            </div>
            <p class="av__lobbyNote" id="avLobbyNote"></p>
          </div>
        </div>
      </div>`;

    const q = (id) => root.querySelector('#' + id);
    this.dom = {
      canvas: q('avGl'), bubble: q('bubbleEl'),
      roundTag: q('avRoundTag'), phaseTag: q('avPhaseTag'), ruleTag: q('avRuleTag'),
      track: q('avTrack'), trackText: q('avTrackText'), trackDots: q('avTrackDots'),
      god: q('avGod'), score: q('avScore'), me: q('avMe'), feed: q('avFeed'),
      side: q('avSide'), log: q('avLog'), action: q('avAction'),
      banner: q('avBanner'), toast: q('avToast'),
      lobby: q('avLobby'), lobbySub: q('avLobbySub'), lobbyNote: q('avLobbyNote'),
      seats: q('avSeats'), variant: q('avVariant'),
      start: q('avStart'), resume: q('avResume'),
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
    // 唯一的游戏道具:每人面前一张状态牌 + 中央的任务牌(道具层契约见 sceneCore/propLayer.js)
    this.props = new AvalonProps();
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
    q('avBtnModels')?.addEventListener('click', () => this.hooks.onModels?.());
    q('avBtnSetup')?.addEventListener('click', () => this.showLobby(this.mode));
    q('avBtnExit')?.addEventListener('click', () => this.handleExit());
    this.dom.start?.addEventListener('click', () => { this._startNew(); });
    this.dom.resume?.addEventListener('click', () => { this._resume(); });
    q('avModels')?.addEventListener('click', () => this.hooks.onModels?.());
    q('avBack')?.addEventListener('click', () => this.handleExit());

    this.store = createAvalonStore({ getKernel: () => this.kernel });
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  /* ============================================================ 大厅 */

  /** 从配置里读阿瓦隆那一格(设置的真源是 games.avalon) */
  _configValues() {
    const cfg = this.hooks.getConfig?.() || {};
    return { ...(cfg.games?.avalon || {}) };
  }

  /**
   * 显示大厅。`mode` 是主页那张模式卡交回来的 'dealer' | 'player'
   * (界面历史叫法;阿瓦隆内部叫 watch / join)。
   */
  showLobby(mode = 'dealer') {
    if (this.destroyed) return;
    this.mode = mode === 'player' ? 'join' : 'watch';
    const v = this._configValues();
    const seats = Number(v.seats) || 7;
    if (this.dom.seats) this.dom.seats.value = String([5, 6, 7, 8, 9, 10].includes(seats) ? seats : 7);
    if (this.dom.variant) this.dom.variant.value = v.variant === 'plain' ? 'plain' : 'classic';
    this.dom.lobbySub.textContent = this.mode === 'join'
      ? '你也坐在圆桌旁:只知道自己的身份,选人、投票、上车,最后还有人要刺杀梅林。'
      : '谁是谁、每一轮是谁投了失败卡,你都看得到 —— 看他们怎么演。';
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
        const r = this._pendingSnap.progress?.handNo || 1;
        this.dom.resume.textContent = `继续上一局(第 ${r} 轮)`;
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
      seats: Number(this.dom.seats?.value) || 7,
      variant: this.dom.variant?.value === 'plain' ? 'plain' : 'classic',
    };
  }

  /** 建每个座位的性格、显示名、立绘 —— 与其它游戏同一套规则(名字跟模型走) */
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
      // 设置**只写 games.avalon**(只对这个游戏生效);global 的模型/Key 不在这里碰
      try { await this.hooks.onSaveConfig?.({ games: { avalon: cfg } }); } catch { /* 存不下设置也能玩 */ }
      this.humanSeat = this.mode === 'join' ? 0 : null;
      const seats = cfg.seats;
      const names = this._buildCast(seats, this.humanSeat);
      const kernel = createKernel({ ...cfg, humanSeat: this.humanSeat });
      // 大厅「开始」= 开新的一场 → 积分清零(结算后的「再来一局」才累计)
      this.standings.resize(seats);
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
      const seats = Number(cfg.seats) || 7;
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
    const myAbort = new AbortController();
    this._abort = myAbort;
    const seats = kernel.state.alive.length;
    this.agents = this._buildAgents(seats, this.humanSeat);
    if (!this.standings.seats || this.standings.seats !== seats) this.standings.resize(seats);
    const human = this.humanSeat === null ? null : {
      seat: this.humanSeat,
      proposeTeam: (view) => this._askHumanTeam(view),
      vote: (view) => this._askHumanVote(view),
      playCard: (view) => this._askHumanCard(view),
      assassinate: (view) => this._askHumanAssassinate(view),
    };
    this.dom.god.hidden = this.mode !== 'watch';
    this.dom.me.hidden = this.mode !== 'join';
    this.dom.banner.hidden = true;
    this.dom.log.innerHTML = '';
    this.cardActs = [];
    this.liveVotes = [];
    this.liveCards = [];
    this._actionBubble = null;
    this._thinkingSeat = null;
    this._thinkingText = '';
    this._thinkingLive = false;
    this._clearActionTimer();
    this.bubble?.hide?.();
    // 座位数变了 → 3D 重建(道具层会跟着重建,见 sceneCore/table.js 的 buildSeats)
    this.table.buildSeats(seats);
    this._render();

    this.runner = new AvalonRunner({
      kernel,
      agents: this.agents,
      human,
      delayMs: Number(this._configValues().speakDelayMs) || 0,
      // ★ 玩家模式**根本不给**私有信息:事件里连 card 字段都没有
      revealSecrets: this.mode === 'watch',
      signal: this._abort.signal,
      hooks: {
        names,
        onEvent: (ev) => this._onEvent(ev),
        onThinking: (seat) => { this._thinkingSeat = seat; this._thinkingText = ''; },
      },
    });
    this.running = true;
    this.hooks.onGameStarted?.();
    this._log(resume ? `恢复对局:第 ${kernel.state.round} 轮` : `${seats} 人局开始:${rosterText(kernel.state.roster)}`, 'ok');
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
        this._log(`${ev.seats} 人局,角色构成 ${rosterText(ev.roster)}`);
        break;
      case 'round':
        this.liveVotes = [];
        this.liveCards = [];
        this._log(`第 ${ev.round} 轮:要 ${ev.teamSize} 人上车,需要 ${ev.failNeed} 张失败票;`
          + `队长 ${seatLabel(ev.leader)}`, 'ok');
        break;
      case 'leader':
        this._log(`第 ${ev.round} 轮第 ${ev.proposalNo} 次提名:${seatLabel(ev.seat)} 是队长`);
        break;
      case 'teamInvalid':
        this._log(`⚠ ${seatLabel(ev.seat)} 给的队伍不合法(要 ${ev.want} 人),已换成确定性队伍`, 'warn');
        break;
      case 'proposal':
        this._actionBubble = { seat: ev.seat, say: (ev.say || []).join(''), text: '' };
        this._clearActionTimer();
        this._actionTimer = setTimeout(() => { this._actionBubble = null; this._render(); }, 2600);
        this._log(`${seatLabel(ev.seat)} 提名:${seatsText(ev.team)}。他说:${(ev.say || []).join(' ')}`
          + `${ev.quality === 'low' ? '(中性兜底)' : ''}`, ev.quality === 'low' ? 'warn' : '');
        this._persist();
        break;
      case 'voteStart':
        this._thinkingSeat = null;
        this._log(`全员投票:${seatsText(ev.team)}(同时亮票,投完一起揭晓)`);
        break;
      case 'voteThoughts':
        // 只有观看模式才有内容(玩家模式看别人心里怎么想就是作弊)。
        // 这里只留最近一次票的私密理由,给上帝面板下面那行旁白用 —— 不塞进时间线,
        // 时间线只放**公开信息**,否则「谁心里在骂谁」会变成所有人可见。
        this._voteThoughts = (this.mode === 'watch' && ev.thoughts?.length) ? ev.thoughts : null;
        break;
      case 'votes': {
        this.liveVotes = (ev.votes || []).slice();
        const yes = (ev.votes || []).filter((v) => v.approve).map((v) => seatLabel(v.seat));
        const no = (ev.votes || []).filter((v) => !v.approve).map((v) => seatLabel(v.seat));
        this._log(`表决 ${ev.yes} 赞成 / ${ev.no} 反对 → ${ev.passed ? '通过' : '否决'};`
          + `赞成 ${yes.join('、') || '无'};反对 ${no.join('、') || '无'}`,
        ev.passed ? 'ok' : 'warn');
        this._persist();
        break;
      }
      case 'rejected':
        this._log(`队伍被否 → 第 ${ev.proposalNo} 次提名,队长换成 ${seatLabel(ev.leader)}`, 'warn');
        break;
      case 'forced':
        this._log(`第 5 次提名也被否 —— 这一队**强制上车**`, 'warn');
        break;
      case 'missionStart':
        this._thinkingSeat = null;
        this.liveCards = [];
        this._log(`第 ${ev.round} 轮任务:${seatsText(ev.team)} 上车投卡(需要 ${ev.failNeed} 张失败票)`);
        break;
      case 'card':
        // 只有观看模式才有 card 字段(玩家模式 runner 不填)
        this.cardActs.push(ev);
        this.liveCards.push({ seat: ev.seat, card: ev.card });
        this._log(`${seatLabel(ev.seat)} 投出 ${ev.card === 'fail' ? '**失败**' : '成功'}卡`,
          ev.card === 'fail' ? 'warn' : '');
        break;
      case 'cardInvalid':
        this._log(`⚠ ${ev.message}`, 'warn');
        break;
      case 'quest': {
        this.liveCards = [];
        this._actionBubble = null;
        this._clearActionTimer();
        this._log(`第 ${ev.round} 轮任务${ev.result === 'success' ? '**成功**' : '**失败**'}`
          + `(${ev.fails} 张失败票,需要 ${ev.failNeed} 张)—— 当前 ${ev.successes} 成功 / ${ev.failsTotal} 失败`,
        ev.result === 'success' ? 'ok' : 'warn');
        this._persist();
        break;
      }
      case 'assassinateStart':
        this._log('好人已经拿到 3 次任务成功 —— 刺客开始刺杀梅林', 'warn');
        break;
      case 'assassinateInvalid':
        this._log(`⚠ 刺杀目标不合法(${ev.target}),已改为确定性目标`, 'warn');
        break;
      case 'assassinate':
        this._log(`刺客刺杀了 ${seatLabel(ev.target)} —— ${ev.hit ? '**是梅林**' : '不是梅林'}`,
          ev.hit ? 'err' : 'ok');
        break;
      case 'end': {
        this._thinkingSeat = null;
        this._thinkingLive = false;
        this._actionBubble = null;
        this._clearActionTimer();
        this.bubble?.hide?.();
        const win = ev.winner === 'good' ? '好人胜' : '坏人胜';
        this._log(`${win}(${ev.reason})`, 'ok');
        // 结算 → 记进本场积分(用户要的「局内积分」,不跨场保留)
        const rows = this._recordScore();
        this.showBanner(win, `${this._endSubText()}<br>${this._scoreLine(rows)}`, true);
        this.toast(win, ev.winner === 'good' ? 'ok' : 'warn', 4200);
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

  /** 结算副标题:整张身份表 + 任务结果(打完了才给看) */
  _endSubText() {
    const st = this.kernel?.state;
    if (!st) return '';
    const evil = st.roles.map((r, s) => (['assassin', 'morgana', 'mordred', 'minion'].includes(r)
      ? `${seatLabel(s)}${roleLabel(r)}` : null)).filter(Boolean);
    const merlin = st.roles.findIndex((r) => r === 'merlin');
    const quests = (st.quests || []).map((q) => `${q.round}:${q.result === 'success' ? '成' : '败'}`).join(' ');
    return `坏人:${evil.join('、')}<br>梅林:${merlin >= 0 ? seatLabel(merlin) : '—'} · `
      + `任务 ${quests}<br>规则:${st.config.variant === 'plain' ? '简化版' : '完整版'}`;
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

    this.dom.roundTag.textContent = st.phase === 'idle' ? '未开局' : `第 ${st.round} 轮 / 共 5 轮`;
    this.dom.phaseTag.textContent = PHASE_LABEL[st.phase] || '';
    this.dom.phaseTag.classList.toggle('is-vote', st.phase === 'vote');
    this.dom.phaseTag.classList.toggle('is-mission', st.phase === 'mission' || st.phase === 'assassinate');
    this.dom.ruleTag.textContent = `${st.config.variant === 'plain' ? '简化版' : '完整版'} · `
      + `${st.config.seats} 人`;

    // 五轮进度条:公开信息(两种模式都画)
    const quests = (st.quests || []).map((q) => ({ result: q.result }));
    this.dom.track.hidden = st.phase === 'idle';
    if (!this.dom.track.hidden) {
      this.dom.trackText.textContent = `${st.successes} 成功 / ${st.fails} 失败`;
      this.dom.trackDots.innerHTML = Array.from({ length: 5 }, (_, i) => {
        const q = quests[i];
        const cls = q ? (q.result === 'success' ? 'is-success' : 'is-fail') : '';
        const now = !q && i === st.round - 1 && st.phase !== 'end' ? ' is-now' : '';
        const mark = q ? (q.result === 'success' ? '✓' : '✗') : (i + 1);
        return `<span class="av__dot ${cls}${now}" title="第 ${i + 1} 轮">${mark}</span>`;
      }).join('');
    }

    // 上帝面板:只有观看模式才画(玩家模式连 DOM 都不填)
    if (this.mode === 'watch') this._renderGod(view);
    else this.dom.god.innerHTML = '';

    // 玩家模式左上角已经有一张「你的身份」卡,积分榜要往下让一格(否则两块面板叠在一起)
    if (this.dom.score) this.dom.score.style.top = this.mode === 'join' ? '210px' : '92px';

    if (this.mode === 'join') this._renderMe(view);
    this._renderFeed();
    this._renderScore();

    // 3D:通用座位视图 + 阿瓦隆自己的一层 ctx(labels 里该有谁,由上面的 view 决定)
    const actor = this._thinkingSeat ?? (st.phase === 'team' ? st.leader : null);
    const labels = this._buildLabels(view, st);
    this.table.update(buildTableViewModel(st, { actor }), {
      labels,
      phaseText: st.phase === 'end'
        ? (st.winner === 'good' ? '好人胜' : '坏人胜')
        : st.phase === 'assassinate' ? '刺杀' : `第 ${st.round} 轮 · ${PHASE_LABEL[st.phase] || ''}`,
      phaseHint: st.phase === 'end' ? '点「设置」可以再来一局'
        : `要 ${this.kernel.teamSize()} 人上车 · ${this.kernel.failNeed()} 票失败 · 队长 ${seatLabel(st.leader)}`,
      quests,
      round: st.round,
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
   *    而不是「画上了再遮住」。票型/上车/任务结果都是公开信息,两种模式都传。
   */
  _buildLabels(view, st) {
    const out = {};
    const votes = new Map((this.liveVotes || []).map((v) => [v.seat, v.approve]));
    const cards = new Map((this.liveCards || []).map((c) => [c.seat, c.card]));
    const quests = (view.quests || []).map((q) => ({ result: q.result }));
    for (const s of view.seats) {
      // 观看模式的 view.seats 带 roleLabel;玩家模式的只有 {seat,name,alive}
      const roleText = this.mode === 'watch'
        ? (s.roleLabel || '')
        : (s.seat === this.humanSeat ? roleLabel(view.me?.role) : '');
      out[s.seat] = {
        seat: s.seat,
        name: s.name || '',
        roleLabel: roleText,
        leader: st.phase !== 'end' && st.leader === s.seat,
        onTeam: (view.team || []).includes(s.seat),
        // ⚠️ 任务卡只在观看模式有数据(玩家模式 runner 不填),所以这里天然是 null
        card: cards.has(s.seat) ? cards.get(s.seat) : null,
        vote: votes.has(s.seat) ? (votes.get(s.seat) ? 'approve' : 'reject') : null,
        quests,
      };
    }
    return out;
  }

  _renderGod(view) {
    const st = this.kernel.state;
    const rows = view.seats.map((s) => {
      const role = s.role === 'merlin' ? '<b class="is-merlin">梅林</b>'
        : ['assassin', 'morgana', 'mordred', 'minion'].includes(s.role)
          ? `<b class="is-evil">${roleLabel(s.role)}</b>`
          : `<span class="is-good">${roleLabel(s.role)}</span>`;
      const vote = (this.liveVotes || []).find((v) => v.seat === s.seat);
      const card = (this.liveCards || []).find((c) => c.seat === s.seat);
      const voteText = vote ? (vote.approve ? '<span class="av__yes">赞成</span>' : '<span class="av__no">反对</span>') : '—';
      const cardText = card ? (card.card === 'fail' ? '<b class="is-evil">失败</b>' : '成功') : '';
      const mark = st.leader === s.seat ? ' ★' : '';
      return `<tr>
        <td>${s.seat + 1}号${mark}</td>
        <td class="av__name">${esc(s.name)}</td>
        <td>${role}</td>
        <td>${voteText}</td>
        <td>${cardText}</td>
      </tr>`;
    }).join('');
    // 刺客是谁(只在观看模式显示):玩家模式不画,连 DOM 都没有
    const assassin = view.assassin
      ? `${seatLabel(view.assassin.seat)}${view.assassin.target !== null ? ` → 刺 ${seatLabel(view.assassin.target)}` : ''}`
      : '—';
    // 上一轮谁出了什么卡:这是这个游戏**只有上帝看得到**的那一条真相。
    // 任务阶段一结束 liveCards 就被清掉(下一轮开始),所以这里从累积的 cardActs 里取最近一轮。
    const lastRound = this.cardActs.length ? this.cardActs[this.cardActs.length - 1].round : 0;
    const lastCards = this.cardActs.filter((c) => c.round === lastRound);
    const cardsLine = lastCards.length
      ? lastCards.map((c) => `${seatLabel(c.seat)}${c.card === 'fail' ? '<b class="is-evil">失败</b>' : '成功'}`).join('、')
      : '(还没有打过任务)';
    // 每个人这一轮投票时的私密理由 —— 只有上帝视角才有这份数据(runner 在玩家模式不填)
    const thoughts = (this._voteThoughts || []).filter((t) => t.thinking);
    const thoughtLine = thoughts.length
      ? thoughts.slice(0, 3)
        .map((t) => `${seatLabel(t.seat)}「${esc(String(t.thinking).replace(/\s+/g, ' ').slice(0, 16))}」`)
        .join(' ')
      : '';
    this.dom.god.innerHTML = `
      <div class="av__panelHead">
        <span>上帝视角 · ${esc(view.rosterText)}</span>
        <span class="av__panelHint">第 ${st.round} 轮 · 要 ${this.kernel.teamSize()} 人 / ${this.kernel.failNeed()} 票失败
          · 本轮第 ${st.proposalNo} 次提名 · 刺客:${esc(assassin)}</span>
      </div>
      <table class="av__table">
        <thead><tr><th>座位</th><th>名字</th><th>身份</th><th>本轮票</th><th>任务卡</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="av__votes">
        <b>本轮提名</b>:${(st.team || []).map((s) => seatLabel(s)).join('、') || '(还没有)'}
        ${(st.say || []).length ? ` —— 队长说「${esc((st.say || []).join(' '))}」` : ''}
      </div>
      <div class="av__votes"><b>第 ${lastRound || '—'} 轮任务卡</b>:${cardsLine}</div>
      ${thoughtLine ? `<div class="av__votes"><b>投票时的私密理由</b>:${thoughtLine}</div>` : ''}`;
    this.dom.god.hidden = false;
  }

  _renderMe(view) {
    const me = view.me || {};
    let extra = '你没有私有信息:只有一张票和一张嘴。';
    if (me.side === 'evil') {
      extra = `你的同伴:${(me.teammates || []).map((t) => seatLabel(t.seat)).join('、') || '没有(你是唯一的坏人)'}`;
    } else if (me.role === 'merlin') {
      extra = `你知道的坏人:${(me.knownEvil || []).map((t) => seatLabel(t.seat)).join('、') || '没有'}`
        + `${me.mordredInPlay ? '(莫德雷德不在名单里,你看不到他)' : ''}`;
    } else if (me.role === 'percival') {
      extra = `你看到的两个人:${(me.merlinCandidates || []).map((t) => seatLabel(t.seat)).join(' 和 ')}`
        + `${me.morganaInPlay ? '(分不清谁是梅林、谁是莫甘娜)' : '(这一局没有莫甘娜,他就是梅林)'}`;
    }
    this.dom.me.innerHTML = `
      <div class="av__meLabel">你的身份</div>
      <div class="av__meRole">${esc(me.roleLabel || '')}</div>
      <div class="av__meHint">${esc(extra)}</div>
      <div class="av__meHint">${me.side === 'evil'
    ? '别让人看出你:破坏要克制,刺杀要等最后一刻。'
    : '别把「你知道什么」直接说出来 —— 那是刺客唯一的线索。'}</div>`;
  }

  /** 公开信息时间线:提名 / 票型 / 任务结果 / 刺杀(全部来自公开事件) */
  _renderFeed() {
    const items = [];
    const st = this.kernel.state;
    for (const e of st.events) {
      if (e.visibility !== 'public') continue;
      if (e.kind === 'round') {
        items.push(`<div class="av__item av__itemSys">第 ${e.round} 轮:要 ${this.kernel.teamSize()} 人上车,`
          + `需要 ${this.kernel.failNeed()} 张失败票</div>`);
      } else if (e.kind === 'proposal') {
        items.push(`<div class="av__item"><span class="av__itemWho">${seatLabel(e.seat)}</span> 提名 `
          + `${seatsText(e.team)}:${esc((e.say || []).join(' '))}</div>`);
      } else if (e.kind === 'votes') {
        const detail = (e.votes || []).map((v) => `${seatLabel(v.seat)}${v.approve ? '✓' : '✗'}`
          + `${v.reason ? `(${esc(v.reason)})` : ''}`).join(' ');
        items.push(`<div class="av__item av__itemVote">表决 ${e.yes}:${e.no} → `
          + `${e.passed ? '通过' : '否决'} · ${detail}</div>`);
      } else if (e.kind === 'rejected') {
        items.push(`<div class="av__item av__itemSys">换队长:${seatLabel(e.leader)}(第 ${e.proposalNo} 次提名)</div>`);
      } else if (e.kind === 'forced') {
        items.push(`<div class="av__item av__itemSys">第 5 次提名被否 —— 强制上车</div>`);
      } else if (e.kind === 'quest') {
        items.push(`<div class="av__item av__itemQuest">第 ${e.round} 轮任务`
          + `${e.result === 'success' ? '成功' : '失败'}(${e.fails}/${e.failNeed} 张失败票)· `
          + `${e.successes} 成功 / ${e.failsTotal} 失败</div>`);
      } else if (e.kind === 'assassinateStart') {
        items.push('<div class="av__item av__itemSys">3 次任务成功 —— 刺客开始刺杀</div>');
      } else if (e.kind === 'win') {
        items.push(`<div class="av__item av__itemWin">${esc(e.text)}</div>`);
      }
    }
    const head = `<div class="av__feedHead">现场 <span>第 ${st.round} 轮 · `
      + `${st.successes} 成功 / ${st.fails} 失败 · ${st.config.variant === 'plain' ? '简化版' : '完整版'}</span></div>`;
    this.dom.feed.innerHTML = head + (items.length
      ? items.slice(-40).join('')
      : '<div class="av__item av__itemSys">还没有人提名。</div>');
    this.dom.feed.scrollTop = this.dom.feed.scrollHeight;
  }

  /** 本场积分榜(打完一局之后才有内容) */
  _renderScore() {
    if (!this.standings.rounds) { this.dom.score.hidden = true; return; }
    const rank = this.standings.ranking();
    const rows = rank.map((r) => `<tr>
      <td>${r.rank}</td>
      <td>${seatLabel(r.seat)}</td>
      <td class="av__name">${esc(this.personaMap.get(r.seat)?.name || '')}</td>
      <td><b>${r.total}</b></td>
      <td class="av__say">+${r.lastDelta}</td>
    </tr>`).join('');
    this.dom.score.innerHTML = `
      <div class="av__panelHead">
        <span>本场积分 · 第 ${this.standings.rounds} 局</span>
        <span class="av__panelHint">参与+1 / 阵营胜+3 / 任务成功+1 / 破坏+2 / 刺杀±2(只在**这一场**累计)</span>
      </div>
      <table class="av__table">
        <thead><tr><th>#</th><th>座位</th><th>名字</th><th>总分</th><th>本局</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    this.dom.score.hidden = false;
  }

  _log(text, kind = '') {
    const line = el('div', `av__logLine${kind ? ` is-${kind}` : ''}`, text);
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
    if (r) r(result);
  }

  _waitHuman(build) {
    return new Promise((resolve) => {
      this._humanResolve = resolve;
      this.dom.action.innerHTML = '';
      this.dom.action.hidden = false;
      build(this.dom.action, (result) => this._resolveHuman(result));
    });
  }

  /**
   * 玩家当队长:点座位按钮选人,选够人数才能确认。
   *
   * ⚠️ 这里**不预选任何人**(不是「先把上一队填进去」):队长每次都是从零开始选,
   *    预选会让「换个队长」看起来像「同一队再投一次」,那是完全不同的信息。
   *    如果玩家点「随便选」,给的是**确定性**方案(座位号从小到大,且不带自己)——
   *    与 AI 降级用的是同一条规则,所以「玩家偷懒」和「模型抽风」产出同一种局面。
   */
  _askHumanTeam(view) {
    return this._waitHuman((box, done) => {
      const need = view.teamSize;
      const picked = new Set();
      const wrap = el('div', 'av__act');
      const btns = view.seats.map((s) => `<button class="btn btn--ghost av__seatBtn" data-seat="${s.seat}">
        <b>${s.seat + 1}号</b>${s.name && s.name !== `${s.seat + 1}号` ? ` ${esc(s.name)}` : ''}</button>`).join('');
      wrap.innerHTML = `
        <div class="av__actHead">你是队长:第 ${view.round} 轮要选 <b>${need}</b> 人上车(需要 ${view.failNeed} 张失败票才失败)</div>
        <div class="av__actRow">${btns}</div>
        <div class="av__actRow" style="margin-top:8px">
          <input class="av__input" id="avTeamSay" maxlength="160" placeholder="当众说一句选人理由(可留空)">
          <button class="btn btn--ghost" id="avTeamAuto">随便选一队</button>
          <button class="btn btn--primary" id="avTeamGo">就这一队</button>
        </div>
        <div class="av__actNote" id="avTeamNote">已选 0 / ${need}</div>`;
      box.appendChild(wrap);
      const note = wrap.querySelector('#avTeamNote');
      const go = wrap.querySelector('#avTeamGo');
      const input = wrap.querySelector('#avTeamSay');
      const refresh = () => {
        note.textContent = `已选 ${picked.size} / ${need}`;
        go.disabled = picked.size !== need;
        wrap.querySelectorAll('.av__seatBtn').forEach((b) => {
          b.classList.toggle('is-on', picked.has(Number(b.dataset.seat)));
        });
      };
      wrap.querySelectorAll('.av__seatBtn').forEach((b) => {
        b.addEventListener('click', () => {
          const seat = Number(b.dataset.seat);
          if (picked.has(seat)) picked.delete(seat);
          else if (picked.size < need) picked.add(seat);
          refresh();
        });
      });
      const say = () => cleanBubble(input.value, 60);
      go.addEventListener('click', () => {
        if (picked.size !== need) return;
        done({ team: [...picked].sort((a, b) => a - b), say: say() ? [say()] : [] });
      });
      wrap.querySelector('#avTeamAuto').addEventListener('click', () => {
        // 确定性方案:座位号从小到大,且尽量不含自己(与 AI 降级同一条规则)
        const others = view.seats.map((s) => s.seat).filter((s) => s !== view.seat).sort((a, b) => a - b);
        const team = others.concat([view.seat]).slice(0, need).sort((a, b) => a - b);
        done({ team, say: say() ? [say()] : [] });
      });
      refresh();
    });
  }

  /** 玩家投票:赞成 / 反对 + 可选理由 */
  _askHumanVote(view) {
    return this._waitHuman((box, done) => {
      const wrap = el('div', 'av__act');
      wrap.innerHTML = `
        <div class="av__actHead">轮到你投票:${seatsText(view.team)}(队长 ${seatLabel(view.leader ?? 0)})</div>
        <div class="av__actRow">
          <button class="btn btn--primary" data-vote="approve">赞成</button>
          <button class="btn btn--ghost" data-vote="reject">反对</button>
        </div>
        <div class="av__actRow" style="margin-top:8px">
          <input class="av__input" id="avVoteReason" maxlength="25" placeholder="公开理由(可留空,≤25 字)">
        </div>
        <div class="av__actNote">投完一起亮票 —— 你看到别人的票之前,这一票就已定下。</div>`;
      box.appendChild(wrap);
      const reasonEl = wrap.querySelector('#avVoteReason');
      wrap.querySelectorAll('[data-vote]').forEach((b) => {
        b.addEventListener('click', () => {
          let reason = cleanBubble(reasonEl.value, 25);
          // 理由泄漏不推翻这一票:票是动作,理由只是修辞(与 agent.vote 的处理一致)
          if (checkReasonLeak(reason)) reason = neutralReason(view.seat, view.round);
          done({ approve: b.dataset.vote === 'approve', reason });
        });
      });
    });
  }

  /** 玩家上车投卡:好人只有「成功」一个合法选项(按钮直接不给失败) */
  _askHumanCard(view) {
    return this._waitHuman((box, done) => {
      const good = view.me.side === 'good';
      const wrap = el('div', 'av__act');
      wrap.innerHTML = `
        <div class="av__actHead">你在车上 —— 投一张任务卡(需要 ${view.failNeed} 张失败票这一轮才失败)</div>
        <div class="av__actRow">
          <button class="btn btn--primary" data-card="success">投成功</button>
          ${good
    ? '<button class="btn btn--ghost" disabled title="好人按规则只能投成功">投失败(好人不能选)</button>'
    : '<button class="btn btn--ghost" data-card="fail">投失败(破坏)</button>'}
        </div>
        <div class="av__actNote">${good
    ? '你是好人:规则只允许投成功。'
    : '结果是公开的,但「谁出的失败卡」不公开 —— 破坏不会立刻暴露你。'}</div>`;
      box.appendChild(wrap);
      wrap.querySelectorAll('[data-card]').forEach((b) => {
        b.addEventListener('click', () => done({
          card: b.dataset.card === 'fail' ? 'fail' : 'success',
        }));
      });
    });
  }

  /** 玩家（刺客）刺杀:点一个别人 */
  _askHumanAssassinate(view) {
    return this._waitHuman((box, done) => {
      const wrap = el('div', 'av__act');
      const btns = view.seats.filter((s) => s.seat !== view.seat).map((s) => `<button class="btn btn--ghost av__seatBtn" data-seat="${s.seat}">
        <b>${s.seat + 1}号</b>${s.name && s.name !== `${s.seat + 1}号` ? ` ${esc(s.name)}` : ''}</button>`).join('');
      wrap.innerHTML = `
        <div class="av__actHead">你是刺客 —— 刺一个人。刺中梅林坏人翻盘胜,刺错好人胜。</div>
        <div class="av__actRow">${btns}</div>
        <div class="av__actNote">这一刀没有第二次。</div>`;
      box.appendChild(wrap);
      wrap.querySelectorAll('.av__seatBtn').forEach((b) => {
        b.addEventListener('click', () => done({ target: Number(b.dataset.seat) }));
      });
    });
  }

  /* ============================================================ 存档 */

  _persist() {
    if (!this.kernel || !this.running) return;
    try { this.store?.save(); } catch (err) { console.warn('[avalon] 存档失败', err); }
  }

  /* ============================================================ 3D 循环 */

  _resize() {
    this._baseResize?.();
    const w = this.dom.canvas.clientWidth || window.innerWidth || 1440;
    const h = this.dom.canvas.clientHeight || window.innerHeight || 800;
    const aspect = Math.max(0.6, w / Math.max(1, h));
    this.table.layoutTable?.(aspect);
    const seats = this.kernel?.state.alive.length || 7;
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
   * 退出本局(app.requestExit 会先问这里)。
   * @returns {boolean} true = 这个屏幕自己处理了退出(别再走扑克抽屉那套)
   */
  handleExit() {
    try { this._teardownRun(); } catch { /* 忽略 */ }
    this.running = false;
    this.hooks.onGameEnded?.();
    this.hooks.onExitHome?.();
    return true;
  }

  /** 宿主(exitToHome / 返回键)要求停一局时用 */
  stopGame() {
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
  buildSeats(n) { if (this.table) this.table.buildSeats(Number(n) || 7); }
  applyPortraits() { this.table?.applyPortraits?.(); }
  updateSeats() {}

  destroy() {
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
