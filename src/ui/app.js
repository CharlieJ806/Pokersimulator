/**
 * 主控制器:把引擎、AI 代理、3D 场景串起来。
 *
 * 信息隔离的落实点:
 *   · 每个座位一个 PokerAgent 实例,只拿到 viewForSeat(seat) —— 里面没有别人的底牌。
 *   · 3D 场景(你,荷官)拿的是 viewForDealer(),包含全部底牌,但只有「底牌 → 全部翻开」
 *     或摊牌时才渲染成正面。「翻看」只改渲染,不进任何 AI 的提示词。
 *   · 你是荷官:桌上没有你的座位,也没有你的手牌 —— 你只负责发牌、控节奏、看牌。
 *
 * ────────────────────────────────────────────────────────────
 * 想改什么(这个文件是交互的大脑,改流程基本都在这里):
 *   · 一手打完后要不要自动开下一手 → 搜 autoNextHand
 *   · 一手的完整流程                 → dealNext() / playHandLoop() / finishHand()
 *   · 一个 AI 怎么决策               → takeTurn()(搜 thinkingSeat)
 *   · 玩家模式我下注那一段           → waitForMyAction() / updatePlayerBar()
 *   · 思考气泡的内容与时机           → takeTurn() 里的 onThink 回调
 *   · 顶部那一行状态文字             → updateHint()
 *   · 发牌按钮能不能点               → canDeal() / refreshDealButton()
 *   · 界面每帧的数据打包             → ctx()(给 3D 场景的那个对象)
 * ============================================================ */

import { PokerEngine } from '../core/engine.js';
import { SceneTable, fmt } from '../ui3d/sceneFull.js';
import { createSetup } from '../ui3d/setup3d.js';
import { characterForModel, assignAccents, assignDisplayNames, displayNameForModel, GENERIC_CHAR } from '../ai/portraits.js';
import { baseAccentFor, preloadPortraits } from '../ui3d/portraits2d.js';
import { PERSONA_MAP } from '../ai/personas.js';
import { createHome } from './home.js';
import { createPlayerBar } from './playerbar.js';
import { createReviewPanel } from './review.js';
import { createModelsPanel } from './models.js';
import { FlowController, MODE_INFO } from './flow.js';
import { assignPersonas, PERSONAS } from '../ai/personas.js';
import { PokerAgent } from '../ai/agent.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** 街道名 → 中文(顶栏显示用) */
const STREET_TEXT = {
  idle: '等待开局', preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌',
};

/**
 * 把流式片段整理成一句可读的思考。
 *
 * 这段文本的唯一来源是**模型的正式输出**(那段 JSON 里的 `thinking` 字段)——
 * 也就是模型「给出动作的同时附带的那句中文」。
 * 思维链(reasoning_content)完全不经过这里:它在 onThink 回调里就按
 * `isReasoning` 标记被跳过了,永远不进界面。
 *
 * 所以这里处理的都是「JSON 还在流、内容不完整」带来的问题:
 *   1. 只抠 `"thinking":"…"` 里的内容(还没出现就返回空,界面显示「正在思考中…」);
 *   2. 清掉 JSON 语法、转义符、以及 thinking 后面跟出来的 `"action"/"amount"` 残渣;
 *   3. 清掉模型写给自己的格式指令(「We need output JSON only.」这类);
 *   4. 实在不像人话(只剩符号 / 没有中文)就返回空。
 *
 * ⚠️ 曾经在这里加过「识别并过滤英文推理」的逻辑 —— 那是**走错了方向**:
 *    推理根本不显示,不需要过滤;真正要保证的是「只渲染正式输出里的 thinking」。
 */
function tidyThinking(text) {
  if (!text) return '';
  let t = String(text);

  // 1. 抠出 thinking 字段的值。没出现就说明还在开头,先不显示内容。
  const m = t.match(/"thinking"\s*:\s*"([\s\S]*)$/);
  if (m) t = m[1];
  else if (/\{\s*$|^\s*\{\s*"/.test(t)) {
    return '';
  }

  // 2. 清理:代码块、转义、JSON 语法、字段名
  t = t
    .replace(/```(?:json)?/gi, '')
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\r/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    // —— 先处理「thinking 还没结束就截断」的情况 ——
    // JSON 是一边生成一边流的:thinking 的值可能还没闭合,后面的
    // `","action":"raise","amount":520}` 就已经吐出来了。那时下面那条
    // `"thinking":"(.*)"` 会把 action/amount 一起吞进去,气泡尾巴上就会挂出
    // 「…我加注试试 , , 520」这种东西(实测踩过)。
    // 所以在剥引号之前,先把 thinking 值后面的 JSON 尾巴切掉。
    //   ① 出现 `","` 这种「键值对边界」→ 从这里断开
    //   ② 出现独立的 `"action"` / `"amount"` 等键名 → 从这里断开
    .replace(/"\s*,\s*"(?:action|amount|thinking|reasoning)"[\s\S]*$/i, '')
    .replace(/"?\b(?:action|amount)\b"?\s*:\s*[\s\S]*$/i, '')
    .replace(/["{}[\]]/g, ' ')
    .replace(/\b(thinking|action|amount|reasoning|fold|check|call|raise)\b\s*:?/gi, ' ')
    .replace(/^\s*[,:]\s*/, '')
    // —— 再清掉孤立的数字残渣 ——
    // 上一步断掉之后可能还剩「, , 520」这样的尾巴(逗号 + 数字)。
    // 只在**句尾**处理,免得把正文里的「跟 20」这种正常数字也删了。
    .replace(/[\s,，、:：]+-?\d+(?:\s*[.,，、:：]\s*-?\d+)*\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 2b. 清掉「给模型自己的格式指令」和「重复提示词」这两类内容。
  //     它们出现在推理里很常见,但完全不是给用户看的。
  t = t
    // 整句英文的格式要求 / 输出要求
    .replace(/\b(?:we|I)\s+(?:need|must|should|have to|will)\s+[^.!?]*?\b(?:json|format|output|respond|answer)\b[^.!?]*[.!?]?/gi, ' ')
    .replace(/\b(?:need|must)\s+to\s+(?:answer|respond|output|reply)\b[^.!?]*[.!?]?/gi, ' ')
    .replace(/\b(?:json|JSON)\s+(?:only|format)\b[^.!?]*[.!?]?/g, ' ')
    // 复述自己的身份 / 任务设定的句子
    .replace(/\b(?:my|the)\s+(?:task|job|role)\s+is\b[^.!?]*[.!?]?/gi, ' ')
    .replace(/\b(?:as|being)\s+an?\s+[^.!?]*?\b(?:player|assistant|AI|model)\b[^.!?]*[.!?]?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 3. 兜底判定。
  //    ⚠️ 不能只判「有没有中文」—— 英文推理里夹一个中文名字就能过,
  //       于是整段英文被显示出来(踩过:气泡里出现 "We need answer JSON only…")。
  //       改成判**中文占比**:中文太少说明这是英文原文,不显示,
  //       界面会退回显示「正在思考中…」。
  if (!/\p{Script=Han}/u.test(t)) return '';
  const hanCount = (t.match(/\p{Script=Han}/gu) || []).length;
  const letterish = t.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '').length;
  if (letterish < 2) return '';
  if (hanCount / Math.max(1, letterish) < 0.3) return '';

  // 4. 截断:优先在标点处断开,别把词切一半(以前直接 slice(0,200),
  //    会看到 "…BTN 阿哲 ca" 这种断在半个词上的结尾)。
  const LIMIT = 200;
  if (t.length > LIMIT) {
    const head = t.slice(0, LIMIT);
    const cut = Math.max(
      head.lastIndexOf('。'), head.lastIndexOf('!'), head.lastIndexOf('?'),
      head.lastIndexOf('？'), head.lastIndexOf('！'), head.lastIndexOf('，'),
      head.lastIndexOf(','), head.lastIndexOf(';'), head.lastIndexOf('；'),
      head.lastIndexOf(' '),
    );
    t = cut > LIMIT * 0.5 ? head.slice(0, cut) : head;
  }
  // 去掉结尾残留的标点/空白
  return t.replace(/[\s,，、;；:：.\-]+$/, '');
}

/** 判断整理出来的思考是否算「有内容」 */
function hasThinking(t) {
  if (!t) return false;
  if (!/\p{Script=Han}/u.test(t)) return false;
  const hanCount = (t.match(/\p{Script=Han}/gu) || []).length;
  const letterish = t.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '').length;
  if (letterish < 2) return false;
  // 与 tidyThinking 同一套判据:英文为主的原文不算「有内容」
  return hanCount / Math.max(1, letterish) >= 0.3;
}

export class GameApp {
  constructor(root) {
    this.root = root;
    this.cfg = null;
    this.engine = null;
    this.agents = new Map();
    this.personaMap = new Map();
    /** 座位 → { charId, accent }:该座位显示哪套 2D 立绘(由模型决定) */
    this.portraitMap = new Map();
    this.table = null;
    this.setup = null;
    this.drawer = null;
    this.modelsPanel = null;
    this.home = null;
    this.mode = null;              // 'dealer' | 'player' —— 由主页选择

    this.busy = false;
    this.running = false;
    this.abort = new AbortController();
    this.generation = 0;
    this.activeLoop = null;
    this.confirmEl = null;
    this.pendingGameSettings = null;
    this.forceRestart = false;
    this.debugErrors = [];
    this.localOnly = false;

    this.ui = { showThinking: true, deckView: 'down' };
    this.deckView = 'down';        // down 全部盖着 | board 只看公共牌 | up 全部翻开(荷官特权)
    this.thinkLive = false;        // 气泡是否正停在「等你点下一位」
    this.gameSettings = null;
    // AI 的记性:每几手写一次读人笔记(0 = 不写、不记忆)
    this.notesEvery = 3;
    this.noteWritesEnabled = true;
    this._noteInFlight = 0;

    this.flow = new FlowController({
      mode: 'manual',
      onWaitChange: (waiting) => {
        this.thinkLive = waiting;
        this.table?.setNextEnabled(waiting);
        this.render();
        this.updateHint();
      },
      onModeChange: () => this.syncTopbar(),
    });
  }

  /** 把动作译成中文(思考记录里显示用) */
  static actionLabel(a, amount) {
    const t = { fold: '弃牌', check: '看牌', call: '跟注', raise: '加注', allin: '全下' }[a] || a || '—';
    if (a === 'raise' && amount) return `加注到 ${amount}`;
    return t;
  }

  /* ------------------------------------------------------------ 启动 */

  async init() {
    this.cfg = await window.pokerAPI.getConfig();
    this.ui = { ...this.ui, ...(this.cfg.ui || {}) };
    this.deckView = this.ui.deckView || 'down';

    // 恢复上次的节奏设置
    if (this.ui.flowMode && MODE_INFO[this.ui.flowMode]) this.flow.mode = this.ui.flowMode;
    if (this.ui.flowSpeed) this.flow.setSpeed(Number(this.ui.flowSpeed) || 1);
    if (this.ui.thinkDelayMs !== undefined) this.flow.thinkDelayMs = Number(this.ui.thinkDelayMs) || 0;

    // 3D 牌桌
    const tableRoot = document.createElement('div');
    tableRoot.className = 'tableRoot';
    this.root.appendChild(tableRoot);
    this.table = new SceneTable(tableRoot, {
      getPersona: (seat) => this.personaMap.get(seat),
      getPortrait: (seat) => this.portraitMap.get(seat),
    });
    this.bindTableButtons();

    // 开局设置(大厅)
    const setupRoot = document.createElement('div');
    setupRoot.className = 'setupRoot';
    this.root.appendChild(setupRoot);
    this.setup = createSetup(setupRoot, {
      mode: 'lobby',
      onSaveAI: (patch) => this.saveConfig(patch),
      onStart: (values, opts) => this.startGame(values, opts),
    });

    // 中途改规则(抽屉)
    const drawerRoot = document.createElement('div');
    drawerRoot.className = 'drawerRoot';
    this.root.appendChild(drawerRoot);
    this.drawer = createSetup(drawerRoot, {
      mode: 'drawer',
      onSaveAI: (patch) => this.saveConfig(patch),
      onStart: (values) => this.applyGameSettings(values),
      onExitHome: () => this.exitToHome(),
    });

    // 按座位分配模型
    const modelsRoot = document.createElement('div');
    modelsRoot.className = 'drawerRoot';
    this.root.appendChild(modelsRoot);
    this.modelsPanel = createModelsPanel(modelsRoot, {
      onSave: (patch) => this.saveModelAssignment(patch),
    });

    // 预填上次的设置
    this.setup.fill(this.cfg);
    this.drawer.fill(this.cfg);
    this.modelsPanel.fill(this.cfg);
    this.setup.setApiNote(this.hasAnyKey());
    this.drawer.setApiNote(this.hasAnyKey());

    if (!this.hasAnyKey()) {
      this.table.toast('本地策略模式', 'info', 2600);
    }
    this.table.setSidePanelOpen(true);
    this.table.setHint('');

    // 玩家模式的下注操作条 + 上一手回顾面板
    const pbarRoot = document.createElement('div');
    pbarRoot.className = 'pbarRoot';
    this.root.appendChild(pbarRoot);
    this.playerBar = createPlayerBar(pbarRoot, {
      onAct: (action) => {
        const resolve = this.myActionResolve;
        if (resolve) resolve(action);
      },
      onReview: () => this.openReview(),
    });
    // 这个元素是刚建出来的,场景构造时还不存在 —— 主动交进去,否则它定位不了
    this.table.setPlayerBarEl(this.playerBar.el);

    const reviewRoot = document.createElement('div');
    reviewRoot.className = 'drawerRoot';
    this.root.appendChild(reviewRoot);
    this.reviewPanel = createReviewPanel(reviewRoot, {});

    // 主页:先选模式,选完再决定是进设置还是直接开局
    const homeRoot = document.createElement('div');
    homeRoot.className = 'setupRoot';
    this.root.appendChild(homeRoot);
    this.home = createHome(homeRoot, {
      // 主页只传一个模式名(第二参数 opts 已经不用了 ——
      // 原来「跳过,直接用上次设置开局」那个按钮会带 skipSetup 过来,按钮已删,
      // 对应的分支也一起去掉,免得留一条永远不会走到的死路)。
      onPick: (mode) => {
        if (mode === 'player') {
          this.enterPlayerMode();
        } else {
          this.mode = 'dealer';
          this.setup.show();
        }
      },
    });
    this.home.show();
  }

  /** 玩家模式入口。玩法定下来之前,先把界面切成「我上桌打」的样子 */
  enterPlayerMode() {
    this.mode = 'player';
    this.playerSeat = 0;                    // 我坐 0 号位
    this.deckView = 'down';
    this.applyModeFlowPolicy();
    // 玩家模式下顶栏那几个荷官特权(底牌三态)没有意义,收起来
    this.table.setDealerOnlyUI(false);
    this.playerBar.show();
    this.setup.setPlayerMode?.(true);
    this.drawer.setPlayerMode?.(true);
    this.setup.show();
    this.table.toast('玩家模式:设置好之后开始,轮到你会出现下注操作条', 'ok', 4200);
  }

  /**
   * 退出本局,回到主页重新选模式。
   *
   * 要把在跑的东西全部停干净:牌局循环、正在等的模型请求、玩家操作的 Promise。
   * 手法跟「中途改规则重开」一致 —— bump generation,让旧的循环自己退出。
   */
  exitToHome() {
    this.generation += 1;                   // 旧循环看到这个就会中止
    this.abort?.abort();
    this.abort = new AbortController();
    if (this.myActionResolve) {
      // 正在等我下注:先把这个 Promise 解掉,否则 playHandLoop 会一直挂着
      const r = this.myActionResolve;
      this.myActionResolve = null;
      this.myTurnSeat = null;
      try { r({ type: 'fold' }); } catch { /* 忽略 */ }
    }
    this.busy = false;
    this.running = false;
    this.activeLoop = null;
    this.thinkingSeat = null;
    this.thinkingText = '';
    this.thinkLive = false;
    this.handThoughts = [];
    this.actionSeat = null;              // 动作气泡(思考结束后显示「做了什么」)
    this.actionText = '';
    this.actionUntil = 0;
    this.pendingGameSettings = null;
    this.forceRestart = false;

    // 退出这一局时立刻停掉所有飞牌动画 ——
    // 否则残留的动画会在下一局的牌桌上继续飞(牌已经不在了,看着很怪)。
    try { this.table?.table?.stopAnimations?.(); } catch { /* 忽略 */ }

    this.playerBar?.hide();
    this.reviewPanel?.hide();
    this.drawer.hide();
    this.setup.hide();
    this.modelsPanel?.hide();
    // 退出时把「玩家模式」的界面改动恢复回去
    this.setup.setPlayerMode?.(false);
    this.drawer.setPlayerMode?.(false);
    document.body.classList.remove('is-player-mode', 'is-sidepanel-open');

    // 牌局清空:回到主页重新来
    this.engine = null;
    this.agents.clear();
    this.personaMap.clear();
    this.portraitMap.clear();
    this.mode = null;
    this.table.setMode('dealer', null);
    this.table.setDealEnabled(false);
    this.table.clearLog();
    this.home?.show();
  }

  /** 是否至少配了一家厂商的 Key(本地模型算已配置) */
  hasAnyKey() {
    const c = this.cfg || {};
    const list = c.providerList || [];
    if (list.some((p) => p.noKey)) return true;
    if (c.apiKey) return true;
    return Object.values(c.keys || {}).some((k) => k && k.trim());
  }

  /**
   * 底部提示。
   * 只保留「现在该干什么」这一种真正需要提示的情况(手动模式下等你看完思考),
   * 其余那些「点这个按钮开始」之类的说明文字一律不显示 —— 按钮上写着呢。
   */
  updateHint() {
    if (!this.table) return;
    if (this.busy && this.thinkLive) {
      this.table.setHint(`看完 ${this.thinkingName || '这位'} 的想法了?点「下一位」继续`, true);
    } else if (this.busy) {
      this.table.setHint('AI 正在思考…', true);
    } else {
      this.table.setHint('');
    }
  }

  /* ------------------------------------------------------------ 配置 */

  async saveConfig(patch) {
    const res = await window.pokerAPI.setConfig(patch);
    if (res?.config) {
      this.cfg = { ...res.config, hasKey: res.hasKey, configPath: this.cfg?.configPath, providerList: this.cfg?.providerList };
      if (patch?.ui) this.applyFlowSettings(patch.ui);
      this.syncAgents();
      this.syncTopbar();
    }
    return { hasKey: !!this.cfg?.hasKey };
  }

  /** 保存「按座位分配模型」的结果 */
  async saveModelAssignment(patch) {
    const res = await window.pokerAPI.setConfig(patch);
    if (res?.config) {
      this.cfg = { ...res.config, hasKey: res.hasKey, configPath: this.cfg?.configPath, providerList: this.cfg?.providerList };
      this.syncAgents();
      // 立绘跟着模型走:换了某个座位的模型就立刻换立绘 + 改名,不用等重开一局
      if (this.engine) {
        this.refreshSeatNames();
        this.buildPortraits();
        this.table.applyPortraits?.();
        this.render();
      }
      this.syncTopbar();
      this.render();
      this.table.toast(`模型已更新:${this.llmSummary()}`, 'ok', 3200);
    }
    return { hasKey: !!this.cfg?.hasKey };
  }

  /** 应用节奏设置(设置面板传来的 ui 字段) */
  applyFlowSettings(ui = {}) {
    if (ui.flowMode && MODE_INFO[ui.flowMode]) this.flow.mode = ui.flowMode;
    if (ui.thinkDelayMs !== undefined) this.flow.thinkDelayMs = Number(ui.thinkDelayMs) || 0;
    // AI 记性:「每几手写一次读人笔记」。0 = 关闭(不记忆,不额外花调用)。
    if (ui.notesEvery !== undefined) this.notesEvery = Math.max(0, Number(ui.notesEvery) || 0);
    // 玩家模式:自己上桌打,记性同样生效 —— 别的 AI 会记住「你」怎么打
    if (ui.rememberPlayers === false) this.noteWritesEnabled = false;
    else if (ui.rememberPlayers === true) this.noteWritesEnabled = true;
    this.ui = { ...this.ui, ...ui };
    // 玩家模式下节奏由玩家自己的操作驱动,AI 之间不能再停下来等「下一位」按钮 ——
    // 那个按钮在玩家模式里是隐藏的,一旦等下去就是死锁。
    // (这个 bug 用本地策略时立刻暴露:决策瞬间返回,AI 每走一步就卡死。)
    this.applyModeFlowPolicy();
    this.syncTopbar();
  }

  /**
   * 按玩法模式兜住节奏控制器的模式。
   *
   * 荷官模式:三种节奏都能用(手动 / 手动+连打 / 自动),因为「下一位」按钮在。
   * 玩家模式:强制 auto —— 否则 AI 走完一步会等一个永远点不到的按钮。
   */
  applyModeFlowPolicy() {
    if (this.mode === 'player') {
      if (this.flow.mode !== 'auto') this.flow.mode = 'auto';
      // 气泡停留也没意义(玩家看不到思考),设 0 让 AI 之间不空等
      this.flow.minBubbleMs = 0;
      this.flow.thinkDelayMs = 0;
    } else {
      this.flow.minBubbleMs = 5000;
      this.flow.thinkDelayMs = Number(this.ui?.thinkDelayMs) || 0;
    }
  }

  /** 一行说明当前各座位用什么模型 */
  llmSummary() {
    if (this.localOnly) return '全部本地策略';
    const list = this.cfg?.providerList || [];
    const nameOf = (id) => list.find((p) => p.id === id)?.name || id;
    if (!this.agents.size) {
      const p = this.cfg?.defaultProvider || 'deepseek';
      return `${nameOf(p)}/${this.cfg?.model || '默认模型'}`;
    }
    const used = new Set();
    for (const agent of this.agents.values()) used.add(agent.modelLabel || '本地策略');
    const arr = [...used];
    return arr.length <= 2 ? arr.join(' + ') : `${arr.length} 种模型`;
  }

  /** 这个座位该用哪家/哪个模型 */
  resolveSeatLLM(seat) {
    if (this.localOnly) return { providerId: 'local', model: '' };
    const c = this.cfg || {};
    const pid = c.seatProviders?.[seat] || c.defaultProvider || 'deepseek';
    if (pid === 'local') return { providerId: 'local', model: '' };
    const list = c.providerList || [];
    const p = list.find((x) => x.id === pid);
    const model = c.seatModels?.[seat] || (seat === 0 ? c.model : '') || p?.defaultModel || '';
    return { providerId: pid, model };
  }

  /**
   * 该座位用哪个自定义中转站的 Key。
   *
   * 中转站的特点是:**一个地址 + 多个 Key**,每个 Key 能调的模型不一定相同。
   * 所以座位要先选 Key(seatCustomKeys),再填模型名(seatModels)。
   * 没选就用第一个 Key。
   */
  customKeyFor(seat) {
    const list = this.cfg?.customKeys || [];
    const wanted = this.cfg?.seatCustomKeys?.[seat];
    return list.find((k) => k.id === wanted) || list[0] || null;
  }

  agentCfg(seat) {
    const { providerId, model } = this.resolveSeatLLM(seat);
    const keys = this.localOnly ? {} : (this.cfg?.keys || {});
    const list = this.cfg?.providerList || [];
    const p = list.find((x) => x.id === providerId);

    // 自定义中转站:地址来自配置(全局一个),Key 来自该座位选的那个
    if (providerId === 'custom') {
      const endpoint = String(this.cfg?.customEndpoint || '').trim();
      const ck = this.customKeyFor(seat);
      const key = String(ck?.key || '').trim();
      return {
        providerId,
        provider: p,
        model,
        apiKey: key,
        enabled: !!endpoint && !!key && !this.localOnly,
        endpoint,
        kind: 'openai',
      };
    }

    const enabled = providerId !== 'local' && (!!p?.noKey || !!keys[providerId]) && !this.localOnly;
    return {
      providerId,
      provider: p,
      model,
      apiKey: keys[providerId] || '',
      enabled,
      endpoint: p?.endpoint,
      kind: p?.kind || 'openai',
    };
  }

  /** 配置变了之后,把每个代理的参数刷新一遍(不用重开牌局) */
  syncAgents() {
    for (const [seat, agent] of this.agents) {
      agent.setConfig(this.agentCfg(seat));
    }
  }

  /* ------------------------------------------------------------ 开局 */

  async startGame(values, opts = {}) {
    this.localOnly = !!opts.forceLocal;
    this.mode = this.mode || 'dealer';
    this.applyFlowSettings(values.ui || {});
    this.gameSettings = { ...values.game };
    this.buildEngine();
    this.table.buildSeats(values.game.seats);
    this.table.clearLog();
    this.running = true;
    this.handThoughts = [];
    this.myTurnSeat = null;
    this.myActionResolve = null;
    this.metaByName = null;                 // 重新按座位建表
    this.home?.hide();
    this.setup.hide();
    this.drawer.hide();
    this.reviewPanel?.hide();
    this.table.setMode(this.mode, this.engine.state.humanSeat);
    this.updatePlayerBar();
    this.renderIdle();
    this.refreshDealButton();
    this.table.toast(this.localOnly
      ? '本地策略'
      : `${values.game.seats} 位 AI 牌手 · ${this.llmSummary()}`, 'ok', 2600);
    this.table.setHint('');
  }

  buildEngine() {
    const g = this.gameSettings;
    this.engine = new PokerEngine({
      seats: g.seats,
      smallBlind: g.smallBlind,
      bigBlind: g.bigBlind,
      startingStack: g.startingStack,
      ante: g.bigBlindAnte ? 0 : g.ante,     // 大盲前注和普通前注二选一
      bigBlindAnte: !!g.bigBlindAnte,
      blindLevelUp: !!g.blindLevelUp,
      shortDeck: g.shortDeck,
      blindUpEvery: g.blindUpEvery || 0,
      // 玩家模式:人坐 0 号位(座位名后面会被 persona 覆盖)
      humanSeat: this.mode === 'player' ? (this.playerSeat ?? 0) : null,
    });

    // 每个座位一个独立 AI 实例。
    //
    // 名字与性格现在是**两条独立的线**(用户的要求):
    //   · 名字跟着**模型**走 —— 同名(同一个模型族群)自动加序号区分,
    //     由 assignDisplayNames 统一编号,保证一桌不重名;
    //   · 性格可以在「模型」面板里逐座位指定(seatPersonas),留空则随机。
    // 所以这里先随机分性格(拿它的打法参数),再把名字换成模型名。
    const personas = assignPersonas(g.seats);
    const human = this.mode === 'player' ? (this.playerSeat ?? 0) : null;

    // —— 先算显示名:玩家座位固定叫「你」,其余按模型 ——
    const nameEntries = [];
    for (let seat = 0; seat < g.seats; seat++) {
      if (seat === human) { nameEntries.push({ seat, name: '你' }); continue; }
      const { providerId, model } = this.resolveSeatLLM(seat);
      nameEntries.push({ seat, name: displayNameForModel(providerId, model) });
    }
    const names = assignDisplayNames(nameEntries);
    this.seatNames = names;

    this.agents.clear();
    this.personaMap.clear();
    for (let seat = 0; seat < g.seats; seat++) {
      const base = personas[seat];
      // 玩家模式下,humanSeat 是「我」:不建 AI 实例,名字固定「你」
      if (seat === human) {
        this.personaMap.set(seat, { id: 'you', name: '你', tag: '你自己', emoji: '🙂', seed: 0 });
        this.engine.state.players[seat].name = '你';
        continue;
      }
      // 配置里指定了性格就用它(留空/认不出则沿用随机结果)
      const wanted = this.cfg?.seatPersonas?.[seat];
      const picked = (wanted && PERSONA_MAP?.[wanted]) || base;
      // 名字换成模型名,但**保留性格的打法参数**(vpip/aggression/risk…)与标签
      const persona = { ...picked, personaName: picked.name, name: names[seat] };
      this.personaMap.set(seat, persona);
      const agent = new PokerAgent(seat, persona, this.agentCfg(seat), {});
      this.agents.set(seat, agent);
      this.engine.state.players[seat].name = persona.name;
      this.engine.state.players[seat].persona = {
        id: persona.id, name: persona.name, tag: persona.tag, emoji: persona.emoji, seed: persona.seed,
      };
    }
    // 玩家模式下人坐的座位不参与 AI 循环,所以不用 agent
    for (const [seat] of [...this.agents]) {
      if (seat === human) this.agents.delete(seat);
    }
    this.syncAgents();
    this.engine.onLog = (entry) => this.table.pushLog(entry);
    this.buildPortraits();
    this.syncTopbar();
  }

  /**
   * 重新计算座位显示名并应用到引擎/personaMap。
   *
   * 名字跟着**模型**走,所以在「模型」面板里改了某人的模型之后要立刻改名 ——
   * 否则会出现「立绘换了、名字还是旧的」这种对不上的状态。
   * (不改打法:打法由性格决定,那次改动只需要 syncAgents。)
   */
  refreshSeatNames() {
    const players = this.engine?.state?.players || [];
    if (!players.length) return;
    const human = this.mode === 'player' ? (this.playerSeat ?? 0) : null;
    const entries = players.map((p) => {
      if (p.seat === human) return { seat: p.seat, name: '你' };
      const { providerId, model } = this.resolveSeatLLM(p.seat);
      return { seat: p.seat, name: displayNameForModel(providerId, model) };
    });
    const names = assignDisplayNames(entries);
    this.seatNames = names;
    for (const p of players) {
      if (names[p.seat]) p.name = names[p.seat];
      const persona = this.personaMap.get(p.seat);
      if (persona && names[p.seat]) persona.name = names[p.seat];
    }
  }

  /**
   * 决定每个座位显示哪套 2D 立绘。
   * 立绘由**该座位用的模型**决定(见 ai/portraits.js 的映射规则),
   * 认不出来的模型用通用占位。同一套立绘被同桌多个座位用到时,
   * 用不同 accent 色调区分(光看立绘分不出谁是谁)。
   *
   * 必须在 table.buildSeats() **之前**算好 —— 建座位时会同步读这张表。
   */
  buildPortraits() {
    const players = this.engine?.state?.players || [];
    if (!players.length) { this.portraitMap.clear(); return; }
    const human = this.mode === 'player' ? (this.playerSeat ?? 0) : null;

    const entries = [];
    for (const p of players) {
      let charId;
      if (p.seat === human) {
        // 「你」不是 AI,没有模型可对应 —— 用中性占位,不冒用任何厂商形象
        charId = GENERIC_CHAR;
      } else {
        const { providerId, model } = this.resolveSeatLLM(p.seat);
        charId = characterForModel(providerId, model);
      }
      entries.push({ seat: p.seat, char: charId, baseAccent: baseAccentFor(charId) });
    }

    const accents = assignAccents(entries);
    this.portraitMap.clear();
    for (const e of entries) this.portraitMap.set(e.seat, { charId: e.char, accent: accents[e.seat] });

    // 开局前先把 idle 图热一下,免得第一帧是空的
    preloadPortraits([...new Set(entries.map((e) => e.char))], ['idle']);
  }

  /** 中途改规则:需要重开一局 */
  async applyGameSettings(values) {
    const { game } = values;
    if ((this.busy || this.running) && !this.forceRestart) {
      this.pendingGameSettings = values;
      this.showConfirm(
        '修改规则需要重开一局',
        '当前这一手会立刻结束,筹码按新规则重发。',
        () => { this.forceRestart = true; this.applyGameSettings(this.pendingGameSettings); },
      );
      return;
    }
    this.forceRestart = false;
    await this.cancelRun();
    this.applyFlowSettings(values.ui || {});
    this.gameSettings = { ...game };
    this.buildEngine();
    this.table.buildSeats(game.seats);
    this.table.clearLog();
    this.running = true;
    this.drawer.hide();
    this.table.toast('规则已更新', 'ok');
    this.renderIdle();
    this.refreshDealButton();
    this.table.setHint('');
  }

  /** 应用内的确认框(不用原生 confirm —— 它会阻塞渲染线程) */
  showConfirm(title, sub, onOk) {
    this.hideConfirm();
    const mask = document.createElement('div');
    mask.className = 'confirm';
    mask.innerHTML = `
      <div class="confirm__box">
        <div class="confirm__title"></div>
        <div class="confirm__sub"></div>
        <div class="confirm__btns">
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn btn--primary" data-act="ok">确定重开</button>
        </div>
      </div>`;
    mask.querySelector('.confirm__title').textContent = title;
    mask.querySelector('.confirm__sub').textContent = sub || '';
    mask.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act;
      if (act === 'ok') { this.hideConfirm(); onOk(); }
      else if (act === 'cancel' || e.target === mask) this.hideConfirm();
    });
    this.confirmEl = mask;
    this.root.appendChild(mask);
  }

  hideConfirm() {
    if (this.confirmEl) { this.confirmEl.remove(); this.confirmEl = null; }
  }

  /* ------------------------------------------------------------ 一手的流程 */

  /** 中止当前这一手(改规则 / 重新开局时用) */
  cancelRun() {
    this.generation = (this.generation || 0) + 1;
    this.thinkingSeat = null;
    this.thinkingText = '';
    this.thinkingLive = false;
    try { this.abort?.abort(); } catch { /* ignore */ }
    this.abort = new AbortController();
    this.flow.abort();
    this.busy = false;
  }

  sleep(ms) { return sleep(ms); }

  async dealNext() {
    if (this.busy) return;
    const st = this.engine.state;
    if (st.street !== 'idle' && !st.handOver) return;

    const aliveCount = st.players.filter((p) => p.stack > 0).length;
    if (aliveCount < 2) {
      const champ = st.players.find((p) => p.stack > 0);
      this.table.toast(`牌局结束:${champ ? champ.name : '?'} 赢下全场`, 'ok', 8000);
      this.table.setDealEnabled(false);
      this.running = false;
      return;
    }

    this.busy = true;
    this.table.setDealEnabled(false);
    this.flow.reset();
    const gen = this.generation;

    // 新手开始:清掉上一手的思考留档(玩家模式「上一手回顾」用的)
    this.handThoughts = [];
    this.myTurnSeat = null;
    this.myActionResolve = null;
    // 新手开始:把上一手留下的「第 N 手记录」按钮收起来,等这一手结束再亮
    this.table.setReviewEnabled?.(false);
    // 动作气泡也清掉(上一手最后一个动作的残留,别带到新的一手)
    this.actionSeat = null;
    this.actionText = '';
    this.actionUntil = 0;

    const run = (async () => {
      try {
        this.engine.startHand();
        this.render();
        await sleep(200);
        const completed = await this.playHandLoop(gen);
        if (completed && gen === this.generation) await this.finishHand();
      } catch (err) {
        console.error(err);
        (this.debugErrors ||= []).push('发牌出错: ' + (err?.message || err));
        this.table.toast('发牌出错:' + (err?.message || err), 'err', 6000);
      }
    })();

    this.activeLoop = run;
    try {
      await run;
    } finally {
      if (this.activeLoop === run) {
        this.activeLoop = null;
        this.busy = false;
      }
      this.refreshDealButton();
    }

    // 一手打完之后是否自动开下一手 —— 默认**否**,必须由人点「发牌 / 下一手」。
    //
    // 为什么默认关掉:自动连打会让结算画面一闪而过(摊牌横幅、赢家高亮、
    // 筹码飞过去都还没看清,下一手已经发牌了)。
    // 节奏模式只管「AI 之间怎么推进」,不再决定「要不要开下一手」。
    // 想连打就在设置里把「自动开下一手」打开(配置项 ui.autoNextHand)。
    const autoNext = !!this.ui?.autoNextHand;
    if (autoNext && this.running && gen === this.generation) {
      await this.flow.pauseBetweenHands();
      if (this.running && gen === this.generation) this.dealNext();
      else this.refreshDealButton();
    } else {
      this.refreshDealButton();
    }
  }

  async playHandLoop(gen = this.generation) {
    let guard = 0;
    let softRetry = 0;              // 「状态刚好变了」这类时序问题允许重试,但要有上限
    let lastSignature = '';
    while (!this.engine.state.handOver && guard++ < 400) {
      if (gen !== this.generation) {
        (this.debugErrors ||= []).push('牌局已重开,中止上一手的行动循环');
        return false;
      }
      const seat = this.engine.state.actor;
      if (seat === null) break;

      // 玩家模式:轮到我 → 停下等操作条给动作,不自动决策
      if (this.mode === 'player' && seat === this.engine.state.humanSeat) {
        const ok = await this.waitForMyAction(gen);
        if (!ok) return false;
        softRetry = 0;
        continue;
      }

      const agent = this.agents.get(seat);
      if (!agent) break;
      const signature = `${this.engine.state.handNo}:${this.engine.state.street}:${seat}:${this.engine.state.players[seat]?.betThisRound}`;
      try {
        await this.stepOnce(seat, agent);
        softRetry = 0;
      } catch (err) {
        const st = this.engine.state;
        // 状态确实已经变了(例如刚结算完):再转一圈看看还要不要行动。
        // 用签名判断,避免同一状态无限重试。
        if ((st.handOver || st.actor !== seat) && signature !== lastSignature && softRetry < 3) {
          lastSignature = signature;
          softRetry++;
          continue;
        }
        softRetry = 0;
        (this.debugErrors ||= []).push(`seat=${seat}: ${err?.message || err}`);
        console.error('AI 行动步骤出错:', err);
        if (gen !== this.generation) return false;
        const la = this.engine.legalActions(seat);
        try {
          this.engine.act(seat, la?.canCheck ? { type: 'check' } : { type: 'fold' });
        } catch (e2) {
          (this.debugErrors ||= []).push(`兜底动作也失败 seat=${seat}: ${e2.message}`);
          break;
        }
      }
    }
    return gen === this.generation;
  }

  /**
   * 玩家模式:轮到我时挂起,等操作条给出动作。
   *
   * 用一个 Promise 把「循环」和「点击」对接起来 —— 循环里只 await,
   * 界面回调里只 resolve,双方都不需要知道对方的存在。
   */
  waitForMyAction(gen) {
    const seat = this.engine.state.humanSeat;
    this.myTurnSeat = seat;
    this.updatePlayerBar();
    this.render();
    this.table.setHint('');
    return new Promise((resolve) => {
      this.myActionResolve = (action) => {
        this.myTurnSeat = null;
        this.myActionResolve = null;
        // 重新确认一次:等待期间牌局可能已经重开或结束
        if (gen !== this.generation || this.engine.state.handOver
          || this.engine.state.actor !== seat) {
          this.updatePlayerBar();
          resolve(false);
          return;
        }
        try {
          this.engine.act(seat, action);
        } catch (err) {
          (this.debugErrors ||= []).push(`玩家动作被拒 ${JSON.stringify(action)}: ${err.message}`);
          this.table.toast(`这个动作不合法(${err.message})`, 'warn', 2800);
          // 不结束等待:让玩家重新选
          this.myTurnSeat = seat;
          this.updatePlayerBar();
          this.render();
          return;
        }
        this.thinkingSeat = null;
        this.updatePlayerBar();
        this.render();
        resolve(true);
      };
    });
  }

  /** 把「轮到我」的状态推给操作条 */
  updatePlayerBar() {
    if (!this.playerBar || this.mode !== 'player') return;
    const st = this.engine?.state;
    if (!st || st.humanSeat === null || st.humanSeat === undefined) return;
    const myTurn = this.myTurnSeat === st.humanSeat && !st.handOver;
    const legal = myTurn ? this.engine.legalActions(st.humanSeat) : null;
    const me = st.players[st.humanSeat];

    // —— 这一手的结果(手牌结束后显示输赢)——
    // lastResult.deltas 是每个座位本手的净输赢,直接拿来用。
    let result = null;
    if (st.handOver && st.lastResult) {
      const d = st.lastResult.deltas?.find((x) => x.seat === st.humanSeat);
      if (d) {
        const won = st.lastResult.winners?.some((w) => w.seat === st.humanSeat);
        // 牌型名:摊牌时才有,拿来做「三条 8 +1200」这种更有信息量的标签
        const w = st.lastResult.winners?.find((x) => x.seat === st.humanSeat);
        const label = w?.handName ? `${w.handName}` : (won ? '赢' : '');
        result = { delta: d.delta, label };
      }
    }

    // —— 现在该谁行动(不是我的时候用来显示「等待 XXX 行动…」)——
    let actingName = '';
    if (!myTurn && !st.handOver && st.actor !== null && st.actor !== undefined) {
      const a = st.players[st.actor];
      const persona = this.personaMap?.get(st.actor);
      actingName = persona?.name || a?.name || `座位${st.actor + 1}`;
    }

    // —— 提示文案:根据当前局面说清楚「该你做什么」——
    let promptText = '';
    if (myTurn && legal) {
      promptText = legal.canCheck
        ? '轮到你:可以过牌,也可以下注'
        : `轮到你:跟注要 ${legal.callAmount},也可以弃牌或加注`;
    }

    this.playerBar.update({
      myTurn,
      seat: st.humanSeat,
      position: this.engine.positionLabels()[st.humanSeat] || '',
      stack: me.stack,
      betThisRound: me.betThisRound,
      bigBlind: st.bigBlind,
      hasBoard: st.board.length >= 3,      // 翻前按 BB 倍数给尺度,翻后按底池比例
      pot: this.engine.totalPot(),
      legal,
      result,
      actingName,
      handOver: !!st.handOver,
      promptText,
      resultText: st.handOver
        ? (result
          ? (result.delta > 0 ? `本手结束:你赢了 ${Math.round(result.delta)}`
            : result.delta < 0 ? `本手结束:你输了 ${Math.abs(Math.round(result.delta))}`
              : '本手结束:打平')
          : '本手结束')
        : '',
    });

    // 结算时让筹码数字闪一下,把注意力引到「我的筹码变了」
    if (st.handOver && !this._chipsPulsedFor) this._chipsPulsedFor = st.handNo;
    else if (!st.handOver) this._chipsPulsedFor = null;
    if (st.handOver && this._chipsPulsedFor === st.handNo && !this._chipsPulsedDone) {
      this._chipsPulsedDone = st.handNo;
      this.playerBar.pulseChips?.();
    }
    if (!st.handOver) this._chipsPulsedDone = null;

    // 一手结束后亮出「第 N 手记录」按钮(在手牌一览的公共牌行上,紧挨着「本手结束」)。
    // 两种模式都显示 —— 荷官也想回看某一手谁说了什么。
    this.table.setReviewEnabled?.(
      !!st.handOver && st.handNo > 0,
      `📋 第 ${st.handNo} 手记录`,
    );
  }

  /** 玩家模式:收集本手每个 AI 的思考,供「上一手回顾」使用 */
  recordHandThought(seat, name, text) {
    if (!text) return;
    if (!this.handThoughts) this.handThoughts = [];
    this.handThoughts.push({ seat, name, text });
  }

  /* ------------------------------------------------------------ 记忆 / 读人笔记 */

  /**
   * 组装给某个座位看的「记忆载荷」。
   *
   * 内容全是**公开信息**:最近几手的动作摘要 + 摊牌亮过的牌 + 对手名单。
   * 座位名用界面上真正的性格名(引擎里可能还叫「座位 N」)。
   */
  memoryFor(seat) {
    const st = this.engine.state;
    const names = {};
    for (const p of st.players) {
      names[p.seat] = this.personaMap?.get(p.seat)?.name || p.name;
    }
    return {
      recentHands: this.engine.recentHands(),
      opponentNames: names,
      opponents: st.players
        .filter((p) => p.seat !== seat)
        .map((p) => ({ seat: p.seat, name: names[p.seat] })),
    };
  }

  /**
   * 触发「写读人笔记」。
   *
   * 几个刻意的设计:
   *   · **不 await**:调用方(finishHand)不等它,玩家看结算画面的同时它在后台跑;
   *   · **限并发**:最多同时 3 个请求。9 人桌一起打容易被上游限流,手机端也顶不住;
   *   · **失败静默**:写不出来就保留旧笔记,绝不影响牌局;
   *   · **每 N 手一次**:频率由 agent.cfg.notesEvery 决定(默认 3,0 = 关闭)。
   */
  kickNoteWrites() {
    if (this.noteWritesEnabled === false) return;
    if (this.localOnly) return;              // 本地策略没有模型可问
    const st = this.engine.state;
    const handNo = st.handNo;
    if (!handNo) return;
    if (this._noteInFlight >= 3) return;     // 上一批还没跑完,等下一手
    for (const [seat, agent] of this.agents) {
      if (!agent.cfg?.enabled) continue;
      // 频率交给 agent 自己判断(它记着上次是第几手写的)
      if (!agent.shouldWriteNotes(handNo, this.notesEvery ?? 3)) continue;
      this._noteInFlight = (this._noteInFlight || 0) + 1;
      const memory = this.memoryFor(seat);
      // 把记忆也交给它,这样它**下一次决策**立刻就能用上新笔记
      agent.memory = memory;
      Promise.resolve(agent.writeNotes(memory, handNo))
        .then((okWrite) => {
          if (okWrite && this.debugNotes) {
            console.debug(`[notes] seat${seat} ${agent.name}:`, agent.notes);
          }
        })
        .catch(() => { /* 静默:笔记失败不影响牌局 */ })
        .finally(() => { this._noteInFlight = Math.max(0, (this._noteInFlight || 1) - 1); });
    }
  }

  openReview() {
    if (!this.reviewPanel) return;
    try {
      const data = this.engine.reviewHand();
      this.reviewPanel.fill(data, this.handThoughts || []);
      this.reviewPanel.show();
    } catch (err) {
      this.table.toast(err.message, 'warn', 2600);
    }
  }

  /**
   * 单个座位的一次行动:气泡 → 决策 → 展示思考(等人点「下一位」或自动停留)→ 交引擎。
   */
  async stepOnce(seat, agent) {
    const st = this.engine.state;
    if (st.actor !== seat || st.handOver) {
      throw new Error(`轮次已变化(期望座位 ${st.actor},实际 ${seat})`);
    }

    const persona = this.personaMap.get(seat);
    this.thinkingSeat = seat;
    this.thinkingName = persona?.name || `座位${seat + 1}`;
    this.thinkingText = '';
    this.render();
    await this.flow.pauseBeforeAct();
    if (st.handOver || st.actor !== seat) return;

    // 让这个 AI 决策(它只看得到自己的牌)
    const view = this.engine.viewForSeat(seat);
    const history = this.engine.actionHistory();
    // 每次决策前都把最新的「牌桌记忆」挂上去 ——
    // 它自己的读人笔记 + 最近几手的公开过程都会进提示词。
    // 这样 AI 不是每手从零开始,而是带着对桌上每个人的判断做决定。
    agent.memory = this.memoryFor(seat);
    agent.setConfig({ notesEvery: this.notesEvery ?? 3 });
    let streamed = '';
    agent.hooks = {
      /**
       * 流式回调:onThink(delta, full, isReasoning)
       *
       * 关键区别:
       *   · isReasoning=true  → 这是**思维链**(reasoning_content),模型给自己看的草稿。
       *     它是什么语言、多长、有没有格式指令,全都无所谓 —— 因为
       *     **我们根本不显示它**,所以这里直接跳过。
       *   · isReasoning=false → 这是**正式输出**(那段 JSON),里面就装着要给玩家看的
       *     中文 `thinking`。随着 JSON 一点点吐出来,tidyThinking() 会把
       *     `"thinking":"…"` 里的内容抠出来实时显示。
       *
       * `full` 是「正式输出的累计」,不含思维链 —— 所以气泡里的文字永远来自
       * 模型的正式回答,推理不会混进来。
       */
      onThink: (_delta, full, isReasoning) => {
        if (isReasoning) return;          // 思维链不进界面
        streamed = full || '';
        if (!this.ui.showThinking) return;
        // JSON 还没长完时可能抠不出内容,那就先让界面显示「正在思考中…」
        this.thinkingText = tidyThinking(streamed);
        this.renderSeatOnly(seat);
      },
      onError: () => this.table.toast(`${agent.name} 的模型调用失败,已用本地策略`, 'warn', 3200),
    };

    const t0 = Date.now();
    const decision = await agent.decide(view, history, { signal: this.abort?.signal });
    const elapsed = Date.now() - t0;
    if (st.handOver || st.actor !== seat) return;

    // 模型给动作的同时也给了这段中文思考 —— 它才是要显示给玩家看的东西。
    // 优先用解析出来的 thinking 字段(最准),拿不到就退回流式过程中整理出的文本。
    const cleanedStream = tidyThinking(streamed);
    const cleanedFinal = tidyThinking(decision.thinking);
    let finalThink = cleanedFinal || cleanedStream;

    // 兜底:模型偶尔会给英文 thinking、或者干脆没写(提示词要求了也未必听)。
    // 那种句子不能显示给玩家(看不懂),但也不能**编一句像真的思考** ——
    // 回顾面板里那些文字是用来判断「他当时怎么想的」,塞一句假的会误导。
    // 所以这里给一个明确标出「这是占位」的短句,回顾里一眼能认出来。
    if (!finalThink) {
      finalThink = '（这次模型没给出可读的思考）';
    }
    this.thinkingText = this.ui.showThinking ? finalThink : '';
    this.thinkingSeat = seat;
    this.thinkingLive = true;
    this.render();
    if (!st.handOver && st.actor === seat) {
      this.table.setNextEnabled(true);
      this.updateHint();
      await this.flow.waitAfterThink(elapsed);
    }

    if (st.handOver || st.actor !== seat) { this.thinkingLive = false; return; }

    // 交给引擎(非法的加注额会被引擎降级)
    agent.lastDecision = { ...decision, thinking: finalThink };
    try {
      this.engine.act(seat, { type: decision.action, amount: decision.amount });
    } catch (err) {
      const la = this.engine.legalActions(seat);
      const safe = la?.canCheck ? { type: 'check' } : { type: 'fold' };
      (this.debugErrors ||= []).push(`动作被拒 seat=${seat} ${JSON.stringify(decision)}: ${err.message}`);
      this.table.toast(`${agent.name} 的动作被拒绝(${err.message}),按${la?.canCheck ? '看牌' : '弃牌'}处理`, 'warn', 3600);
      this.engine.act(seat, safe);
    }

    const applied = this.engine.state.players[seat]?.lastAction;
    this.recordThink(
      seat, agent, finalThink,
      applied?.label || GameApp.actionLabel(decision.action, decision.amount),
      decision.source,
    );

    // 玩家模式:思考在牌局进行中不显示,但要留档给「上一手回顾」
    if (this.mode === 'player') {
      this.recordHandThought(seat, agent?.name || this.engine.seatName(seat), finalThink);
    }

    // 动作气泡:思考气泡收掉之后,原地再显示一小会儿「他做了什么」。
    //
    // 为什么要这个:玩家模式下看不到别人的思考内容,如果气泡直接消失,
    // 就只剩「刚才有人动了但不知道动了什么」—— 得去翻日志才知道。
    // 现在气泡会接着显示「跟注 20」这样的结果,看完自然消失。
    const label = applied?.label || GameApp.actionLabel(decision.action, decision.amount);
    if (this.mode === 'player' && label) {
      this.actionSeat = seat;
      this.actionText = label;
      this.actionUntil = performance.now() + Math.max(1400, 2600 / (this.flow.speed || 1));
    }

    this.thinkingSeat = null;
    this.thinkingText = '';
    this.thinkingLive = false;
    this.table.setNextEnabled(false);
    this.render();
  }

  /** 写一条思考记录 */
  recordThink(seat, agent, thinking, actionLabel, source) {
    this.table.pushThink({
      seat,
      name: agent?.name || this.engine.seatName(seat),
      persona: this.personaMap.get(seat),
      model: agent?.modelLabel,
      handNo: this.engine.state.handNo,
      street: this.engine.state.street,
      thinking,
      action: actionLabel,
      source,
    });
  }

  async finishHand() {
    const st = this.engine.state;
    const result = st.lastResult;
    this.thinkingSeat = null;
    this.thinkingText = '';
    // 把结算数据交给场景:筹码飞向赢家的动画要靠 payouts 区分主池/边池。
    // 必须在 render 之前给 —— render 里会走到那个动画的触发点。
    this.table?.table?.setLastResult?.(result);
    this.render({ revealAllOnShowdown: true });

    // AI 的记性:这一手打完了,让它们各自更新「读人笔记」(每 3 手一次)。
    // 放在这里是因为此刻引擎的公开摘要已经生成、而玩家还在看结算画面 ——
    // 笔记请求和看画面并行,不占额外等待时间。
    this.kickNoteWrites();

    if (result) {
      if (result.type === 'showdown') {
        const winNames = result.winners.map((w) => `${this.engine.seatName(w.seat)} +${fmt(w.amount)}`).join(' ');
        this.table.showBanner('摊牌', winNames, 2600);
      } else if (result.type === 'fold-win') {
        const w = result.winners[0];
        this.table.showBanner('收池', `${this.engine.seatName(w.seat)} +${fmt(w.amount)}(其他人弃牌)`, 2200);
      }
      this.table.celebrate(result.winners.map((w) => w.seat));
    }

    // 结算动画结束后再把筹码堆刷成最终值 ——
    // 提前刷的话,赢家的筹码数会瞬间跳到位,飞过去的动画就显得没意义了。
    const waitSettle = () => {
      const t = this.table?.table;
      const info = t?.__settleInfo?.();
      return info ? 1 : 0;
    };
    if (waitSettle()) {
      // 等飞行结束(最多 2.5 秒)再收尾,避免动画还在飞就被下一手覆盖
      for (let i = 0; i < 50; i++) {
        const alive = this.table?.table?.__animAlive?.() || 0;
        if (!alive) break;
        await sleep(50);
      }
    }

    this.refreshDealButton();
    this.updateHint();
  }

  /* ------------------------------------------------------------ 渲染 */

  syncTopbar() {
    if (!this.table) return;
    const VIEW_LABEL = { down: '盖着', board: '只看公共牌', up: '全部翻开' };
    const VIEW_ICON = { down: '🂠', board: '👀', up: '👁' };
    const btn = this.table.dom.btnPeek;
    btn.innerHTML = `${VIEW_ICON[this.deckView] || '🂠'} 底牌 <b>${VIEW_LABEL[this.deckView] || '盖着'}</b>`;
    btn.classList.toggle('is-active', this.deckView === 'up');

    const t = this.table.dom.btnThink;
    t.innerHTML = `💭 气泡 <b>${this.ui.showThinking ? '开' : '关'}</b>`;
    t.classList.toggle('is-active', this.ui.showThinking);

    const m = this.table.dom.btnMode;
    const info = MODE_INFO[this.flow.mode];
    m.innerHTML = `${info.icon} ${info.label}`;
    m.classList.toggle('is-active', this.flow.mode === 'auto');

    this.table.dom.btnSpeed.textContent = `⏱ ${this.flow.speed.toFixed(1)}x`;
  }

  /** 三态循环:盖着 → 只看公共牌 → 全部翻开 */
  cycleDeckView() {
    const order = ['down', 'board', 'up'];
    const idx = order.indexOf(this.deckView);
    this.deckView = order[(idx + 1) % order.length];
    this.ui.deckView = this.deckView;
    this.render();
    this.syncTopbar();
    const msg = {
      down: '底牌:盖着',
      board: '底牌:只看公共牌',
      up: '底牌:全部翻开',
    }[this.deckView];
    this.table.toast(msg, 'info', 2400);
    this.saveConfig({ ui: { deckView: this.deckView } });
  }

  renderIdle() {
    const view = this.engine.viewForDealer();
    this.table.updateTopbar(view, this.statLine(), STREET_TEXT[view.street]);
    this.table.updatePot(view.pot, false);
    this.table.updateSeats(view, this.ctx());
  }

  ctx(extra = {}) {
    const st = this.engine.state;
    const handOver = st.handOver;
    const showdown = st.lastResult?.type === 'showdown' && handOver;
    const isPlayer = this.mode === 'player';
    return {
      // 三态语义:
      //   up    → 全部翻开(荷官特权)
      //   down  → 默认;摊牌时自动亮出参与者的底牌
      //   board → 只看公共牌;连摊牌也不亮底牌
      revealAll: this.deckView === 'up',
      // 思考气泡:
      //   · 玩家模式也要显示「正在思考中」—— 否则桌上的人全都不动,
      //     你不知道是在等他、还是卡住了。(之前这里直接置 null,等于完全不显示。)
      //   · 但**思考内容**在玩家模式下不下发(那是别人脑子里的东西)。
      //     靠 revealThinking 告诉场景层:能显示气泡,但别显示文字。
      thinkingSeat: this.thinkingSeat ?? null,
      revealThinking: !isPlayer,
      thinkingText: this.thinkingText || '',
      // ⚠️ 这里用的是 thinkingLive(「模型正在吐字」),不是 thinkLive
      //    (「在等你点下一位」)。两个状态不一样,以前传错了 ——
      //    结果气泡的「正在思考」高亮一直跟着「等待放行」走,该亮的时候不亮。
      thinkingLive: this.thinkingLive,
      // 动作气泡:思考收掉之后的「他做了什么」。只在玩家模式用,
      // 而且是**时效性**的 —— 时间一过就返回 null,气泡自然消失。
      actionBubble: (isPlayer && this.actionSeat !== null && this.actionSeat !== undefined
        && performance.now() < (this.actionUntil || 0))
        ? { seat: this.actionSeat, text: this.actionText || '' }
        : null,
      personaMap: this.personaMap,
      deltas: st.lastResult?.deltas,
      winnerSeats: st.lastResult && handOver
        ? st.lastResult.winners?.map((w) => w.seat) : null,
      showdownReveal: !isPlayer && showdown && this.deckView !== 'board',
      humanSeat: st.humanSeat,
      ...extra,
    };
  }

  render(extra = {}) {
    const view = this.engine.viewForDealer();
    const ctx = this.ctx(extra);
    this.table.updateTopbar(view, this.statLine(), STREET_TEXT[view.street]);
    this.table.updatePot(view.pot, true);
    this.table.updateSeats(view, ctx);
    if (!this.busy) this.table.setDealEnabled(this.canDeal());
    this.updatePlayerBar();
  }

  renderSeatOnly(seat) {
    const view = this.engine.viewForDealer();
    this.table.updateSeats(view, this.ctx());
    void seat;
  }

  statLine() {
    const st = this.engine.state;
    const alive = st.players.filter((p) => p.stack > 0).length;
    const avg = Math.round(st.players.reduce((s, p) => s + p.stack, 0) / Math.max(1, alive));
    return `存活 ${alive}/${st.players.length} · 平均筹码 ${fmt(avg)} · 模型 ${this.llmSummary()}`;
  }

  /** 现在能不能发下一手 */
  canDeal() {
    const st = this.engine?.state;
    if (!st || this.busy || !this.running) return false;
    return st.street === 'idle' || st.handOver;
  }

  refreshDealButton() {
    this.table.setDealEnabled(this.canDeal());
    this.updateHint();
  }

  /* ------------------------------------------------------------ 按钮 */

  bindTableButtons() {
    const d = this.table.dom;

    d.btnDeal.addEventListener('click', () => {
      if (!this.canDeal()) return;
      this.dealNext();
    });

    // 「第 N 手记录」:一手结束后出现在手牌一览的公共牌行上
    this.table.onReviewClick?.(() => this.openReview());

    // 「下一位」:手动模式下放行当前思考
    d.btnNext.addEventListener('click', () => {
      this.flow.advance();
      this.updateHint();
    });

    // 模式循环:手动 → 手动+连打 → 自动
    d.btnMode.addEventListener('click', async () => {
      const mode = this.flow.cycleMode();
      this.syncTopbar();
      await this.saveConfig({ ui: { flowMode: mode } });
      const info = MODE_INFO[mode];
      this.table.toast(
        mode === 'auto'
          ? '已切到自动:思考气泡会完整停留至少 5 秒'
          : `已切到「${info.label}」:${info.hint}`,
        'info', 3000,
      );
      this.updateHint();
    });

    d.btnSpeed.addEventListener('click', async () => {
      const steps = [0.5, 1, 1.5, 2, 3];
      const i = steps.indexOf(this.flow.speed);
      const next = steps[(i + 1) % steps.length] ?? 1;
      this.flow.setSpeed(next);
      this.syncTopbar();
      await this.saveConfig({ ui: { flowSpeed: next } });
      this.table.toast(`节奏 ${next}x`, 'info', 1500);
    });

    d.btnPeek.addEventListener('click', () => this.cycleDeckView());

    d.btnModels.addEventListener('click', () => {
      const seats = this.engine?.state?.players?.length || this.cfg?.game?.seats || 6;
      // 第三个参数是座位显示名(模型名),面板用它展示「这个名字是谁」
      this.modelsPanel.setSeats(seats, this.personaMap, this.seatNames);
      this.modelsPanel.fill(this.cfg);
      this.modelsPanel.show();
    });

    d.btnThink.addEventListener('click', async () => {
      this.ui.showThinking = !this.ui.showThinking;
      this.syncTopbar();
      await this.saveConfig({ ui: { showThinking: this.ui.showThinking } });
      this.render();
    });

    d.btnThinkLog.addEventListener('click', () => {
      this.table.setSidePanelOpen(true);
      this.table.setPanel('think');
    });

    d.btnLog.addEventListener('click', () => {
      const collapsed = d.sidePanel.classList.contains('is-collapsed');
      this.table.setSidePanelOpen(collapsed);
      if (collapsed) this.table.setPanel('log');
    });

    d.btnClearLog.addEventListener('click', () => this.table.clearLog());

    d.btnSetup.addEventListener('click', () => {
      this.drawer.fill(this.cfg);
      this.drawer.setApiNote(this.hasAnyKey());
      this.drawer.show();
    });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      // 空格 / 回车 = 下一位;没有在等待时就发牌
      if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) {
        e.preventDefault();
        if (this.flow.waiting) this.flow.advance();
        else if (!d.btnDeal.disabled) this.dealNext();
      }
      if (e.key === 'p' || e.key === 'P') d.btnPeek.click();
      if (e.key === 'm' || e.key === 'M') d.btnModels.click();
      if (e.key === 't' || e.key === 'T') d.btnThinkLog.click();
      if (e.key === 'a' || e.key === 'A') d.btnMode.click();
      if (e.key === 'Escape') { this.drawer.hide(); this.modelsPanel.hide(); }
    });
  }
}

export { PERSONAS };
// 思考文本的整理逻辑单独导出,便于测试直接覆盖各种「半个 JSON / 英文推理」的情况
// (这段逻辑以前出过问题:模型的英文推理混着中文名字,老判据挡不住,整段糊到气泡上)
export { tidyThinking, hasThinking };
