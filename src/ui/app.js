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
import { createEquityRun, DEFAULT_SAMPLES } from '../core/equity.js';
// 对局快照:① 共同逻辑(节流 / 版本)在 core/gameStore.js;
// ② 「存在哪」的差异在两个薄适配器里(core/gameStore 的 storage 参数)。
// ⚠️ app.js 本身**不碰 localStorage / IPC** —— 那样就变成两端各一份实现了。
import { createGameStore, snapshotInfo, SAVE_INTERVAL_MS } from '../core/gameStore.js';
import { resolveGameStorage } from '../shared/gameStorage.mjs';
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
// 协议 → kind 的唯一映射(和请求构造、SSE 解析放在同一份共享模块里,
// 免得界面上选的值和底层认的值对不上)
import { kindForProtocol, normalizeReasoningLevel } from '../shared/llmStream.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * 摊牌胜率的采样预算。
 *
 * 一次蒙特卡洛的成本 ≈ 采样数 × 参与人数 × 40µs(7 张牌评估,桌面实测),
 * 所以**按人数反推采样数**:人越多,每人分到的样本越少,总耗时封顶。
 * 6000 次评估 ≈ 0.25s(桌面),手机上再慢几倍 —— 但它跑在空闲时间片里
 * (见 pumpEquity),不占渲染那几帧。
 */
const EQUITY_EVAL_BUDGET = 6000;
/** 采样数下限:低于这个数误差大到没脸显示(±3% 以上) */
const EQUITY_MIN_SAMPLES = 600;

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
    // 返回键退出:当前这条 history 条目上有没有挂「牌局标记」(见 armBackGuard)。
    // 用一个实例字段而不是每次都读 history.state:popstate 里需要区分
    // 「标记刚被消费掉」和「本来就没有标记」这两种情况。
    this.backGuardArmed = false;
    // 「已经弹过一次确认框、还没被处理」的那一轮标记(见 onPopState 的三个分支)
    this.backPromptUsed = false;

    // ⚠️ 这里原来有 showThinking(气泡里显不显示思考文字的可切开关)。
    //    已经删掉了:顶栏那个「💭 气泡 开/关」按钮和设置里的「显示思考气泡」都是它的入口,
    //    而它的语义只是「气泡里显不显示文字」—— 不是「气泡显不显示」。
    //    气泡本身的显隐由 ctx().revealThinking 决定(荷官看内容、玩家只看「正在思考中…」),
    //    那是**信息隔离**,不是偏好设置,不能跟着这个开关走。
    //    现在思考文字恒为「显示」,所以这个字段没有存在意义了,删掉而不是留成死字段。
    this.ui = { deckView: 'down' };
    this.deckView = 'down';        // down 全部盖着 | board 只看公共牌 | up 全部翻开(荷官特权)
    this.thinkLive = false;        // 气泡是否正停在「等你点下一位」
    // 摊牌胜率(只有荷官模式才有值,玩家模式恒为 null —— 见 ensureEquity)
    this.equity = null;            // { pct: Map<座位, 0..1>, exact, samples, ties }
    this._eqSig = '';              // 上次计算对应的状态签名(一样就不重算)
    this._eqRun = null;            // 正在按时间片推进的模拟
    this.gameSettings = null;
    // AI 的记性:每几手写一次读人笔记(0 = 不写、不记忆)
    this.notesEvery = 3;
    this.noteWritesEnabled = true;
    this._noteInFlight = 0;

    /* ---------------------------------------------------------- 对局快照(续玩)
     *
     * 手机上浏览器一进后台就可能被系统回收,刷新也一样 —— 内存里的 state 全丢。
     * 这里把「存档」这件事收敛成**一个**对象 + **一个**方法(app.saveGameNow),
     * 所有入口(引擎的状态回调、页面隐藏、构建期外的任何地方)都走它,
     * 免得出现「A 处写了 B 处没写、刷新后退回上一个画面」这种只在某些路径复现的丢失。
     *
     * ⚠️ 一期**不存 AI 的记忆 / 读人笔记**:丢的代价只是「AI 少记点」,
     *    不影响牌局继续(筹码/底牌/行动顺序全在引擎 state 里)。
     *    把它们也塞进快照会把快照从 5KB 撑到几十 KB,而 localStorage 是同步写入 ——
     *    手机上为了「更聪明的 AI」付主线程卡顿的代价不划算。
     */
    this.gameStore = null;         // window 相关的东西在 init 里再建(构造函数不该碰 DOM/存储)
    this.pendingSnapshot = null;   // 启动时读到的、还没被用户确认的快照
    this._resumeInfo = null;
    this._lifecycleBound = false;
    this._savedHandNo = 0;         // 已经落盘到第几手(用于「继续上一局(第 N 手)」)
    this._restoring = false;       // 恢复过程中禁止写盘(见 saveGame)

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

    // 存档器:storage 适配器按当前环境自动选(桌面版 IPC 文件 / 网页版 localStorage),
    // 但**上层逻辑完全同一份**(core/gameStore.js)—— 这是两端一致性的落实点。
    this.gameStore = createGameStore({
      storage: resolveGameStorage(window),
      getEngine: () => this.engine,
      intervalMs: SAVE_INTERVAL_MS,
    });

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
      // 手牌一览里那个常驻的「退出本局」(手机上的可达入口)。
      // 它和抽屉按钮、返回键共用 requestExit 这一条路。
      onExitGame: () => this.requestExit(),
    });
    this.bindTableButtons();

    // ★ 返回键 / 侧滑返回退出。
    //   popstate 挂在 window 上、只挂一次(不能每次开局都 addEventListener,
    //   那样开几局就会有几个监听器,一次返回弹出好几个确认框)。
    //   牌局不存在时 onPopState 会直接放行(见那里的注释)。
    window.addEventListener('popstate', () => this.onPopState());

    // 开局设置(大厅)
    const setupRoot = document.createElement('div');
    setupRoot.className = 'setupRoot';
    this.root.appendChild(setupRoot);
    this.setup = createSetup(setupRoot, {
      mode: 'lobby',
      onSaveAI: (patch) => this.saveConfig(patch),
      onStart: (values, opts) => this.startGame(values, opts),
      // 还没开局:回主页就是把「进入玩家模式」时改过的界面状态撤回去(exitToHome 全包了)
      onBack: () => this.exitToHome(),
      onModels: (seats) => this.openModelsPanel(seats),
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
      onModels: () => this.openModelsPanel(),
      // 升盲周期(每 N 手按档位表升一档)是个例外:它只决定「这一手打完要不要升档」,
      // 不参与任何一注的计算,所以局中改它**不必重开一局**(其他规则改了都要重发筹码,
      // 见 applyGameSettings)。这里直接打到正在跑的引擎上;点「应用」时仍然会照常写进配置
      // (下次开局面还是它)。
      onBlindLevelHands: (n) => {
        // 还没开局(在主页设置页改的):什么都不用做 —— 「开始 / 保存」会把整份设置写进配置
        if (!this.engine) return;
        const v = this.engine.setBlindLevelHands(n);
        // 主页那个设置页是另一份 DOM,把这一格也同步过去 ——
        // 否则它显示的是旧值,下次点「开始」会把旧值写回配置,把刚调好的节奏悄悄撤掉
        this.setup.setBlindLevelHands(v);
        // 局中就地改的也要落盘:不然「改完直接关掉抽屉」会丢,
        // 下一局又变回旧周期(而设置面板里显示的却是新值 —— 最难查的那种不一致)
        this.saveConfig({ game: { blindLevelHands: v } });
      },
    });

    // 按座位分配模型
    const modelsRoot = document.createElement('div');
    // --top:模型面板要能盖在**主页和设置页之上**打开。
    // 以前它和主页同一层级、DOM 又在主页前面 —— 从主页点「模型与 API Key」时面板其实打开了,
    // 只是被主页整个挡在下面,看起来就是按钮没反应。
    modelsRoot.className = 'drawerRoot drawerRoot--top';
    this.root.appendChild(modelsRoot);
    this.modelsPanel = createModelsPanel(modelsRoot, {
      onSave: (patch) => this.saveModelAssignment(patch),
      /**
       * 「测试」按钮的座位配置由这里组装 —— 面板把**此刻 DOM 上的**配置快照
       * (含还没保存的改动)交回来,走的是和真实调用同一个 agentCfg。
       * 不在面板里重写一份「座位该用哪个厂商/Key/模型」的规则(见 agentCfg 的注释)。
       * localOnly:false —— 测试是排查配置用的,不该因为当前是本地策略模式就被禁掉。
       */
      testSpec: (cfg, seat) => this.agentCfg(seat, cfg, { localOnly: false }),
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
      // 开局前也能配模型 —— 补上「只能开局后配、配了又不生效」那个逻辑漏洞
      onModels: () => this.openModelsPanel(),
      // 「继续上一局 / 放弃」两个入口(见 checkPendingSnapshot)
      onResume: (snap) => this.restoreGame(snap),
      onDiscard: () => this.abandonSnapshot(),
    });
    this.home.show();
    // 主页上还没有牌局 —— 「退出本局」入口从第一帧起就该是收着的。
    // (以前它只在 exitToHome() 里被藏起来,也就是**首次进主页时是显示的**,
    //  点下去只是再回一次主页。实测抓到过。)
    this.table.setExitEnabled(false);

    // 启动时读一次存档:有就在主页显示「继续上一局(第 N 手)」+「放弃」,让用户选。
    // ⚠️ **不静默恢复**:用户可能就是想重新开一局,直接把他丢回上一局的牌桌更像故障。
    //    此刻 init 已把 gameSettings / 表格 / 存档器都备好了,恢复才有条件做。
    this.checkPendingSnapshot();
    this.bindLifecycleSaves();
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
    // (不再弹 toast:设置页标题下已经写了玩家模式的说明,toast 只会压在卡片上)
  }

  /**
   * 退出本局,回到主页重新选模式。
   *
   * 要把在跑的东西全部停干净:牌局循环、正在等的模型请求、玩家操作的 Promise。
   * 手法跟「中途改规则重开」一致 —— bump generation,让旧的循环自己退出。
   */
  exitToHome() {
    // bump generation + 掐断请求 + 解开节奏控制器的等待(旧循环看到这些就会中止)
    this.cancelRun();
    this.hideConfirm();
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
    this.actionSay = '';                 // 模型主动说出口的那句话(玩家模式给玩家看的)
    this.actionUntil = 0;
    this.pendingGameSettings = null;
    this.forceRestart = false;

    // 退出这一局时立刻停掉所有飞牌动画 ——
    // 否则残留的动画会在下一局的牌桌上继续飞(牌已经不在了,看着很怪)。
    try { this.table?.table?.stopAnimations?.(); } catch { /* 忽略 */ }

    // ★ 退出前**先同步存一次**:用户点「退出本局」往往紧接着就是关页面 / 切 App,
    //   这里不存的话,「退出」这个动作本身反而把最后一步进度丢了。
    //   此刻 engine 还在(下面才置 null),存得到。
    this.saveGameNow();

    this.playerBar?.hide();
    this.reviewPanel?.hide();
    this.drawer.hide();
    this.setup.hide();
    this.modelsPanel?.hide();
    // 退出时把「玩家模式」的界面改动恢复回去
    this.setup.setPlayerMode?.(false);
    this.drawer.setPlayerMode?.(false);
    // ⚠️ 这里以前顺手把 body 上的 is-sidepanel-open 也摘掉了 —— 那是**错的**:
    //    那个类不是「玩家模式的标记」,它是「侧栏开着」这个状态的渲染结果
    //    (styles3d.css 靠它把手牌一览的宽度让给侧栏)。
    //    直接摘掉之后,再开一局时侧栏的 DOM 还是展开的、却不再占位 ——
    //    手牌一览铺满整屏、压在侧栏底下(实测:playermode 第 9 步量到
    //    「侧栏开着」和「侧栏收起」的手牌一览都是 1240px 满宽)。
    //    正确做法是什么都不做,让 setSidePanelOpen 保持它的内部状态与类的同步。
    document.body.classList.remove('is-player-mode');

    // 牌局清空:回到主页重新来
    //
    // ★ 退出前**先同步存一次**(进入本段之前就做了,见上面的 saveGameNow)。
    // ★ 存档**故意留着**:用户点的是「回主页」,不是「删除进度」——
    //   顺手删档会变成「一退出就弃局」,而主页上那句「继续上一局」正是为这个场景准备的。
    //   想彻底不要,主页上有「放弃」。
    const resumeKept = this.engine
      ? {
        ...(this._resumeInfo || {}),
        handNo: this.engine.state.handNo | 0,
        street: this.engine.state.street,
        handOver: !!this.engine.state.handOver,
        humanSeat: this.engine.state.humanSeat ?? null,
        players: this.engine.state.players.length,
      }
      : null;
    this.engine = null;
    this.agents.clear();
    this.personaMap.clear();
    this.portraitMap.clear();
    this.mode = null;
    this.table.setMode('dealer', null);
    this.table.setDealEnabled(false);
    // 「退出本局」和返回键标记都要一起收掉:
    //   · 按钮留在主页上说不通(已经没有「本局」可退);
    //   · 标记不清掉的话,退出后按返回会再弹一次确认框 —— 而且这次
    //     engine 是 null,确认框确认之后什么也不会发生(用户被卡在一个死框上)。
    this.table.setExitEnabled(false);
    this.disarmBackGuard();
    this.table.clearLog();
    // 有存档就把「继续上一局」重新挂出来。
    // ⚠️ 用 _resumeInfo / _savedHandNo 里的信息,而不是读 this.engine ——
    //    上面几行已经把 engine 置成 null 了。
    if (resumeKept && resumeKept.handNo > 0) {
      this._resumeInfo = resumeKept;
      // ⚠️ 这里**没有**第二个参数(快照本体):盘上那份还在,由主页「继续」时
      //    重新从存储读一遍 —— 拿内存里的旧快照反而可能落后于最后一次强制保存。
      this.home?.showResume?.(resumeKept);
    } else {
      this.home?.hideResume?.();
    }
    this.home?.show();
  }

  /** 是否至少配了一家厂商的 Key(本地模型算已配置) */
  hasAnyKey() {
    const c = this.cfg || {};
    if (c.apiKey) return true;
    if (Object.values(c.keys || {}).some((k) => k && String(k).trim())) return true;
    // 自定义中转站:地址 + 至少一个填了密钥的 Key
    if (c.customEndpoint && (c.customKeys || []).some((k) => k?.key)) return true;
    // 本地模型不需要 Key —— 但只有**默认厂商就是它**时才算配好了。
    // 以前写成「列表里有任何免 Key 的厂商」:Ollama 永远在列表里,这个判断恒为真,
    // 「本地策略模式」的提示永远不出现,没填 Key 时输入框还显示「已保存」。
    const def = (c.providerList || []).find((p) => p.id === c.defaultProvider);
    return !!def?.noKey;
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

  /**
   * 打开「按座位分配模型」面板 —— 开局**之前**也能开。
   *
   * 为什么单独抽出来:以前入口只在游戏里的顶栏,于是必须先随便开一局、
   * 再进去改模型,而那时候名字和立绘早就按默认模型建好了。
   * 用户看到的就是「只能在开局后配,配了又不生效」这个逻辑漏洞。
   */
  openModelsPanel(seatsHint) {
    const seats = this.engine?.state?.players?.length || seatsHint || this.cfg?.game?.seats || 6;
    // 开局前人数可能变了(设置页滑杆刚拖过):预览用的性格表要按新人数重建
    if (!this.engine && this.personaMap.size !== seats) this.personaMap.clear();
    // 开局前没有牌局,personaMap 是空的 —— 面板里只会显示「座位 1/2/3…」,
    // 用户不知道自己正在给谁配模型。所以这里补一份**预览用**的性格表。
    // 只影响面板的显示;真正开局时 buildEngine 会重新分配,不会被这份污染。
    if (!this.personaMap.size) {
      const wanted = this.cfg?.seatPersonas || {};
      for (let seat = 0; seat < seats; seat++) {
        const p = (wanted[seat] && PERSONA_MAP?.[wanted[seat]]) || PERSONAS[seat % PERSONAS.length];
        if (p) this.personaMap.set(seat, p);
      }
    }
    // 第三个参数是座位显示名(模型名),面板用它展示「这个名字是谁」
    // 先 fill 再 setSeats:fill 会用配置里**上次保存的**人数覆盖座位数,
    // 顺序反了的话,设置页刚把滑杆拖到 8 人,面板里却还是 6 行
    this.modelsPanel.fill(this.cfg);
    this.modelsPanel.setSeats(seats, this.personaMap, this.seatNames);
    this.modelsPanel.show();
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
      // 设置页 / 抽屉里的「默认厂商 / 模型」两格跟着改,否则开局时会被它们的旧值写回去
      this.setup?.syncAI?.(this.cfg);
      this.drawer?.syncAI?.(this.cfg);
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

  /** 这个座位该用哪家/哪个模型
   *
   * cfg / localOnly 两个参数是给「连通性测试」用的:面板上有**还没保存**的改动时,
   * 测试必须按面板里此刻填的东西去测,而不是按上次保存的配置 ——
   * 否则用户改了模型名再点测试,测出来的是旧配置的结论,纯属误导。
   * 所以测试时把面板快照当 cfg 传进来,复用同一个函数,规则不存在第二份。
   */
  resolveSeatLLM(seat, cfg = this.cfg, localOnly = this.localOnly) {
    if (localOnly) return { providerId: 'local', model: '' };
    const c = cfg || {};
    const pid = c.seatProviders?.[seat] || c.defaultProvider || 'deepseek';
    if (pid === 'local') return { providerId: 'local', model: '' };
    const list = c.providerList || [];
    const p = list.find((x) => x.id === pid);
    // 「默认模型」(c.model)对所有**跟随默认厂商**的座位生效。
    // 以前写成 seat === 0 才用它:1 号以后的座位全拿不到(中转站这种没有 defaultModel 的
    // 厂商就会发空模型名、被拒、退回本地策略);玩家模式 0 号是人,等于没有任何 AI 用到它。
    // 反过来,0 号单独换了厂商时也不能套用别家的默认模型名。
    const own = c.seatProviders?.[seat];
    const followsDefault = !own || own === c.defaultProvider;
    const model = c.seatModels?.[seat] || (followsDefault ? c.model : '') || p?.defaultModel || '';
    return { providerId: pid, model };
  }

  /**
   * 该座位用哪个自定义中转站的 Key。
   *
   * 中转站的特点是:**一个地址 + 多个 Key**,每个 Key 能调的模型不一定相同。
   * 所以座位要先选 Key(seatCustomKeys),再填模型名(seatModels)。
   * 没选就用第一个 Key。
   */
  customKeyFor(seat, cfg = this.cfg) {
    const list = cfg?.customKeys || [];
    const wanted = cfg?.seatCustomKeys?.[seat];
    return list.find((k) => k.id === wanted) || list[0] || null;
  }

  /**
   * 组装某个座位真正用于调用模型的配置。
   *
   * ⚠️ 「模型分配」面板的连通性测试按钮**直接调这个函数**(见 createModelsPanel 的
   *    testSpec 回调)。为什么不让面板自己算一遍:座位该用哪个厂商、模型名怎么跟随默认、
   *    中转站没选 Key 时用哪个、协议怎么变成 kind —— 这一串规则只要写第二份,
   *    迟早和这里漂移,而「两条路径各写一份」在这个仓库已经出过两次事故
   *    (一次是参数降级只加在测试路径上,一次是截断重试只加在测试路径上)。
   *
   * @param {number} seat
   * @param {object} [cfg] 配置快照(默认 this.cfg;连通性测试传面板里此刻的 DOM 值)
   * @param {{localOnly?:boolean}} [opts] 测试时传 localOnly:false ——
   *   「全部改用本地策略」不该让测试按钮变得不可用,那正是用户要排查配置的时候。
   */
  agentCfg(seat, cfg = this.cfg, opts = {}) {
    const localOnly = opts.localOnly ?? this.localOnly;
    const { providerId, model } = this.resolveSeatLLM(seat, cfg, localOnly);
    const keys = localOnly ? {} : (cfg?.keys || {});
    const list = cfg?.providerList || [];
    const p = list.find((x) => x.id === providerId);

    // 自定义中转站:地址来自配置(全局一个),Key 与**协议**来自该座位选的那个 Key。
    //
    // 协议为什么挂在 Key 上:中转站的「令牌分组」决定了这个 Key 能调哪些模型,
    // 而分组和协议是绑定的 —— CC 分组的 Claude 只挂 ANTHROPIC 标签,
    // Kimi-sale 的 kimi-k3 只挂 OPENAI-RESPONSE 标签。同一个中转站里
    // 不同分组的 Key 就是不同协议,写死成 openai 会让这些模型全部
    // 报 protocol_not_supported(实测)。
    if (providerId === 'custom') {
      const endpoint = String(cfg?.customEndpoint || '').trim();
      const ck = this.customKeyFor(seat, cfg);
      const key = String(ck?.key || '').trim();
      return {
        providerId,
        provider: p,
        model,
        apiKey: key,
        noKey: false,
        enabled: !!endpoint && !!key && !localOnly,
        endpoint,
        kind: kindForProtocol(ck?.protocol),
        /**
         * 推理档位 —— 压到最低但**不关**(用户在界面上选,默认 low)。
         *
         * 为什么不是「关掉推理」:
         *   关掉之后难题上模型会降智 —— 它连草稿都不打就得直接给结论。
         *   牌桌要的从来不是「不要思考」,而是「别啰嗦」,所以默认最低档:
         *   OpenAI 兼容口发 reasoning_effort:'low',Gemini / Anthropic / Responses
         *   各自的字段(budget_tokens / reasoning.effort / thinkingBudget)由
         *   buildRequest 按协议统一发 —— 这里**只传档位**。
         *
         * ⚠️ 以前这里是硬编码的 `requestExtra:{reasoning_effort:'low'}`,
         *    而且只对 openai 协议发:
         *      · Anthropic 用 thinking、Responses 用 reasoning.effort,
         *        字段名和嵌套层级都不一样,在这里各写一份 = 迟早漂移;
         *      · 更要命的是它**绕过了档位开关** —— 用户选「关闭」也照样发出去,
         *        那这个开关就是骗人的。所以字段全部交给 buildRequest 一处决定。
         *    Node 直连那条路(agent.js 的 callLLMDirect)也读同一个字段,
         *    两条路径的报文因此逐字一致。
         *
         * ⚠️ 只在中转站这条路上把档位交下去:
         *    内置厂商的容忍度是逐家实测定过的(deepseek 有 provider.requestExtra,
         *    别的家不认这个字段的直接 400),一刀切地给所有 openai 兼容厂商加
         *    reasoning_effort 会把这些厂商全部打回降级重试。中转站后面挂的是什么
         *    模型完全不确定,只能按统一档位发 —— 这也正是这个下拉在中转站区块里的原因。
         *
         * ⚠️ timeoutMs / maxTokens 也必须传下去。它们当年就是因为这里没传而变成
         *    **死字段** —— 无论用户填多少,调用层都只用它自己的缺省值。
         *    新加配置项时务必顺着这条链走一遍:界面 → collect → 配置 → agentCfg → agent。
         */
        reasoningLevel: normalizeReasoningLevel(cfg?.reasoningLevel),
        timeoutMs: cfg?.timeoutMs,
        maxTokens: cfg?.maxTokens,
        // 重试策略(times / backoffMs / budgetMs / classifyErrors)也要顺着
        // 「界面 → 配置 → agentCfg → agent」这条链走 —— 漏传就又变成一个死字段,
        // 用户在配置里怎么改都没反应(见上面那段 ⚠️)。
        llmRetry: cfg?.llmRetry,
      };
    }

    const enabled = providerId !== 'local' && (!!p?.noKey || !!keys[providerId]) && !localOnly;
    return {
      providerId,
      provider: p,
      model,
      apiKey: keys[providerId] || '',
      // 本地模型(Ollama / LM Studio)不需要 Key —— 不带上这个标记,
      // agent.decide() 看到 apiKey 为空就直接走本地策略,永远不会真的去调本地模型
      noKey: !!p?.noKey,
      enabled,
      endpoint: p?.endpoint,
      kind: p?.kind || 'openai',
      timeoutMs: cfg?.timeoutMs,
      maxTokens: cfg?.maxTokens,
      llmRetry: cfg?.llmRetry,   // 与上面中转站那条路同一个字段(理由见那里)
    };
  }

  /** 配置变了之后,把每个代理的参数刷新一遍(不用重开牌局) */
  syncAgents() {
    for (const [seat, agent] of this.agents) {
      agent.setConfig(this.agentCfg(seat));
    }
  }

  /* ------------------------------------------------------------ 对局快照(续玩) */

  /**
   * **唯一的保存入口**(节流)。
   *
   * 为什么必须只有一个:保存要在好几个地方发生(引擎每步状态变化、页面隐藏、
   * 未来可能还有别的),任何一处各写一份「取引擎 → 打快照 → 写存储」的话,
   * 迟早有一处忘了处理「引擎是 null(在主页)」「写失败要吞掉」这些边界 ——
   * 而表现是「某些路径下刷新会退回上一个画面」,极难复现。
   */
  saveGame() {
    if (!this.gameStore || !this.engine) return { ok: false, written: false };
    // 恢复过程中**绝对不许写盘**:restoreGame 会先 startGame()(建一个全新的空引擎),
    // 再 restore() 覆盖。如果这中间有一次 onState 落了盘,盘上的存档就被
    // 「第 0 手的空局面」冲掉了 —— 用户的上一局会在「点继续」的瞬间被抹掉。
    if (this._restoring) return { ok: true, written: false, skipped: 'restoring' };
    const res = this.gameStore.save();
    if (res?.written) {
      const st = this.engine.state;
      this._savedHandNo = st.handNo | 0;
      this._resumeInfo = {
        handNo: st.handNo | 0,
        street: st.street,
        handOver: !!st.handOver,
        humanSeat: st.humanSeat ?? null,
        players: st.players.length,
        savedAt: Date.now(),
        version: 1,
      };
    }
    return res;
  }

  /**
   * **强制**保存一次(无视节流),用于「就要离开这个页面」的场景:
   * visibilitychange→hidden、pagehide、beforeunload。
   * 默认走同步通道 —— 这几处之后的异步回调不保证还会执行(见 gameStore.flush 的说明)。
   */
  saveGameNow({ sync = true } = {}) {
    if (!this.gameStore || !this.engine) return { ok: false };
    return this.gameStore.flush({ sync });
  }

  /**
   * 接上「页面即将被回收」的三个信号 —— 这是三个阶段里**最可靠**的一次保存机会:
   *
   *   · visibilitychange → hidden:切到别的 App / 锁屏 / 切标签。移动端**最可靠**,
   *     系统回收基本发生在这之后(这也是 PWA 生命周期里唯一保证会触发的信号);
   *   · pagehide:页面真的要走了(前进后退缓存 bfcache 也会触发)。Safari 上
   *     visibilitychange 不一定发,所以两个都接,重复保存的代价只是一次同步写;
   *   · beforeunload:桌面浏览器关标签的兜底。⚠️ 它**不保证**触发(移动端基本没有),
   *     所以只算兜底,绝不能当成主力。
   *
   * ⚠️ 不要在这里 await 任何东西:这些回调之后事件循环可能就停了。
   */
  bindLifecycleSaves() {
    if (this._lifecycleBound) return;     // init 只跑一次,但重复绑定会重复写盘
    this._lifecycleBound = true;

    this._onVisibilityChange = () => {
      // 只在**变隐藏**时存:变可见时存没有意义,而写盘是同步的,能省就省
      if (document.visibilityState === 'hidden') this.saveGameNow();
    };
    this._onPageHide = () => { this.saveGameNow(); };
    this._onBeforeUnload = (e) => {
      this.saveGameNow();
      // 正在打一手就提示一下(浏览器只会用自己那句通用文案,写什么都一样)。
      // 这不是「保存手段」,是最后一道「别手滑刷新」的提醒。
      if (this.engine && this.engine.state.handNo > 0 && !this.engine.state.handOver) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    window.addEventListener('pagehide', this._onPageHide);
    window.addEventListener('beforeunload', this._onBeforeUnload);
  }

  /**
   * 启动时查一次存档,有就在主页显示「继续上一局(第 N 手)」+「放弃」。
   *
   * 校验用 engine 的静态方法(不建实例也能验):快照里的 seats 越界时
   * `new PokerEngine` 会抛,那种快照必须当场丢掉而不是等到用户点了「继续」才炸。
   */
  checkPendingSnapshot() {
    if (!this.gameStore) return null;
    const snap = this.gameStore.load();
    if (!snap) return null;
    const info = snapshotInfo(snap);
    try {
      const seats = Number(snap?.settings?.seats);
      if (!Number.isFinite(seats) || seats < 2 || seats > 9) throw new Error(`座位数非法(${snap?.settings?.seats})`);
      PokerEngine.validateSnapshot(snap);
    } catch (err) {
      // 坏快照必须**当场丢掉**:留着只会每次启动都在这里失败一次,
      // 而主页上还挂着一个点了就报错的「继续上一局」。
      this.gameStore.clear();
      (this.debugErrors ||= []).push(`丢弃了不可用的对局快照:${err?.message || err}`);
      this.table?.toast(`上一局的存档已损坏,已丢弃(${err?.message || err})`, 'warn', 5000);
      return null;
    }
    this.pendingSnapshot = snap;
    this._resumeInfo = info;
    this.home?.showResume?.(info, snap);
    return info;
  }

  /** 「放弃」:丢掉存档,回到普通主页(不弹二次确认 —— 用户已经明确点了一次) */
  abandonSnapshot() {
    this.pendingSnapshot = null;
    this._resumeInfo = null;
    this.gameStore?.clear();
    this.home?.hideResume?.();
    this.table?.toast('已放弃上一局', 'info', 2400);
  }

  /**
   * 用快照恢复到牌桌上。
   *
   * ⚠️ 重建的范围:引擎 state 之外的东西**本来就不进快照**,要重新算 ——
   *    · agents / personaMap / portraitMap:由配置(座位模型、性格)推导,走 buildEngine
   *      同一套逻辑(它还会同步每个 AI 的 cfg);
   *    · 座位名:按模型重新编号(assignDisplayNames 要保证一桌不重名);
   *    · AI 的记忆 / 读人笔记:**一期不存**,确认丢失也没关系 ——
   *      它们只影响「AI 记不记得对手怎么打」,不影响筹码、底牌、行动顺序任何一项。
   */
  async restoreGame(snap = this.pendingSnapshot) {
    // 主页那个按钮可能没带着快照对象过来(比如「退出本局」之后重新亮出的入口 ——
    // 那时内存里已经没有引擎了,只有盘上那份)。这时**现场从存储读一遍**:
    // 盘上那份才是真相,而且它可能比内存里记的更新(退出前刚强制保存过)。
    if (!snap) snap = this.gameStore?.load() || null;
    if (!snap) {
      this.home?.hideResume?.();
      this.table?.toast('没找到上一局的存档', 'warn', 3000);
      return false;
    }
    let loaded;
    try {
      loaded = this.loadSnapshotForEngine(snap);
    } catch (err) {
      this.gameStore?.clear();
      this.pendingSnapshot = null;
      this.home?.hideResume?.();
      this.table?.toast(`上一局的存档不可用,已丢弃:${err?.message || err}`, 'err', 6000);
      return false;
    }

    this.pendingSnapshot = null;
    this.home?.hideResume?.();
    this.home?.hide();

    // ★ 从这一刻到 restore() 完成之间不许写盘(理由见 saveGame())。
    //   用 try/finally 保证无论哪一步抛错都会把闸门放开,否则整局都不会再存档。
    this._restoring = true;
    try {
      // 1) 先按存档里的设置**重新开局**(建引擎 + 座位 + agents + 立绘),
      //    再用快照覆盖状态。顺序不能反:buildEngine 会按 gameSettings 重发筹码,
      //    先恢复再 buildEngine 会把恢复出来的筹码全冲掉。
      await this.startGame(
        { game: loaded.gameSettings, ui: this.ui || {} },
        { forceLocal: this.localOnly, silent: true },
      );
      // 恢复是**原位**覆盖,不换引擎实例:3D 场景 / agents 都抓着这个引用。
      // 换实例等于把已经建好的牌桌全部作废(而且旧循环还抓着旧引擎)。
      this.engine.restore(loaded.snap);
    } finally {
      this._restoring = false;
    }

    // 2) 模式与「我坐哪」跟着存档走 —— 玩家模式开局时是 0 号位,但存档里可能是别的
    const human = loaded.snap.progress?.humanSeat;
    if (human !== null && human !== undefined) {
      this.mode = 'player';
      this.playerSeat = human;
    }
    this.engine.state.humanSeat = this.mode === 'player' ? (this.playerSeat ?? 0) : null;

    // 3) 把手牌状态(名字/性格)按**恢复后的 state** 再对一遍:
    //    快照里的座位名是上次那一局的,而模型分配可能已经改过。
    this.refreshSeatNames();
    this.buildPortraits();
    this.table.applyPortraits?.();
    this.table.setMode(this.mode, this.engine.state.humanSeat);

    // 4) 手里那些「属于上一手」的运行时数据一律清空
    this.handThoughts = [];
    this.myTurnSeat = null;
    this.myActionResolve = null;
    this._eqSig = '';
    this.equity = null;
    this.table.clearLog();
    this.table.setReviewEnabled?.(false);

    this.renderIdle();
    this.refreshDealButton();
    this.syncTopbar();
    this.table.toast(
      `已恢复:第 ${this.engine.state.handNo} 手 · ${this.engine.state.players.length} 人`
      + (this.mode === 'player' ? ' · 玩家模式' : ''),
      'ok', 3200,
    );
    // 恢复成功 = 盘上那份就是当前的真相。强制同步写一次:
    //   · 上一份是「一手打到一半」时存的,而恢复后可能立刻又变了;
    //   · 顺手把 _resumeInfo / _savedHandNo 对齐到恢复后的 handNo。
    this.saveGameNow();
    // 5) 存档是「一手打到一半」的话,接着打(引擎里 actor 还在等)
    this.resumeCurrentHand();
    return true;
  }

  /**
   * 把快照的 settings 翻译成 buildEngine 要的 gameSettings,并顺带校验。
   * 抽成一个方法是为了让「校验」只有一份 —— restoreGame 与 checkPendingSnapshot 共用。
   */
  loadSnapshotForEngine(snap) {
    // 静态校验:版本不符 / 结构坏 / 牌不是字符串,都在这里拦掉(见 engine.validateSnapshot)
    PokerEngine.validateSnapshot(snap);
    const s = snap.settings || {};
    const gameSettings = {
      seats: Number(s.seats),
      shortDeck: !!s.shortDeck,
      startingStack: Number(s.startingStack),
      smallBlind: Number(s.smallBlind),
      bigBlind: Number(s.bigBlind),
      ante: Number(s.ante) || 0,
      bigBlindAnte: !!s.bigBlindAnte,
      blindLevelUp: !!s.blindLevelUp,
      blindLevelHands: s.blindLevelHands,
      blindUpEvery: s.blindUpEvery || 0,
    };
    if (!Number.isFinite(gameSettings.seats) || gameSettings.seats < 2 || gameSettings.seats > 9) {
      throw new Error(`存档里的座位数非法(${s.seats})`);
    }
    return { snap, gameSettings };
  }

  /**
   * 接着打**当前这一手**(恢复之后用)。
   *
   * 为什么不直接调 dealNext():那个方法开头会把「已经打完 / 没在打」当发新手的信号,
   * 而恢复出来的局面恰恰是「一手打到一半」—— 走 dealNext 会发一手新的,
   * 把恢复出来的这一手直接丢掉。
   */
  async resumeCurrentHand() {
    const st = this.engine?.state;
    if (!st) return;
    if (st.handOver || st.street === 'idle' || st.actor === null) {
      // 已经结算完 / 还没开局:等用户点「发牌 / 下一手」就行
      this.refreshDealButton();
      return;
    }
    this.busy = true;
    this.table.setDealEnabled(false);
    // ★ 必须 bump generation:恢复前可能还挂着旧的回调(计时器、流式片段),
    //   它们看到 gen 变了就会自己退出,不会把动作打到恢复后的局面上。
    const gen = (this.generation = (this.generation || 0) + 1);
    this.flow.reset();
    try {
      await this._playOutHand(gen);
    } finally {
      this.busy = false;
      this.refreshDealButton();
    }
  }

  /* ------------------------------------------------------------ 开局 */

  async startGame(values, opts = {}) {
    this.localOnly = !!opts.forceLocal;
    this._bustNoticed = false;
    this.mode = this.mode || 'dealer';
    this.applyFlowSettings(values.ui || {});
    this.gameSettings = { ...values.game };
    // ★ 开新局 = 上一次的存档作废(否则「旧存档 + 新引擎」会打架:
    //   下一手写盘之前若页面被杀,回来恢复的是**上一次**那一局,
    //   而牌桌上显示的是新规则的一局)。
    // 恢复流程也走这个方法,但它用 _restoring 把这一步挡住 —— 那份存档正是要用的东西。
    if (!this._restoring) {
      this.gameStore?.clear();
      this._resumeInfo = null;
      this.home?.hideResume?.();
    }
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
    // ★ 把侧栏的「占位」状态同步回来。
    //   为什么需要:那些类名(以及手牌一览的宽度)本来就是**状态推导出来的**,
    //   而退出本局时有好几处会碰它,最典型的是以前 exitToHome 直接
    //   classList.remove('is-sidepanel-open') —— 侧栏的 DOM 还展开着却不再占位,
    //   重新开局后手牌一览就铺满整屏、压在侧栏底下(实测踩到过)。
    //   这里按侧栏**实际**的展开状态重新同步一次,幂等,重复调用无副作用。
    this.table.setSidePanelOpen(this.table.isSidePanelOpen());
    this.updatePlayerBar();
    this.renderIdle();
    this.refreshDealButton();
    // 牌局存在了 —— 手牌一览里的「退出本局」这时候才该出现。
    // ★ 同时给 history 打上牌局标记:返回键从这一刻起要**问一句**再退(见 armBackGuard)。
    this.table.setExitEnabled(true);
    this.armBackGuard();
    // silent:恢复流程借这条路重开局,它自己会弹一句更准确的「已恢复:第 N 手」——
    // 这里再弹一句「6 位 AI 牌手」只会盖在上面,让人以为是新开的一局。
    if (!opts.silent) {
      this.table.toast(this.localOnly
        ? '本地策略'
        : `${values.game.seats} 位 AI 牌手 · ${this.llmSummary()}`, 'ok', 2600);
    }
    this.table.setHint('');
    // 新的一局从第 0 手开始 —— 记住这个数,退出本局后主页那句
    // 「继续上一局(第 N 手)」用它,而不是用内存里可能已经被清掉的引擎状态。
    this._savedHandNo = this.engine.state.handNo | 0;
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
      // ★ 每 N **手**按档位表升一档的周期(设置面板里那一格)。
      //   默认 20 = 引擎里的 BLIND_LEVEL_HANDS,漏传的话引擎自己也会回落成 20,
      //   但这里显式给一份,免得「配置项写了没接到使用处」那种坑又出现。
      blindLevelHands: g.blindLevelHands ?? 20,
      shortDeck: g.shortDeck,
      // 「每 N 手翻倍」:引擎能力保留、界面入口已撤掉;配置里是什么就传什么(默认 0 = 不升盲)。
      // 这里以前写成 `g.blindUpEvery || 0`,把 undefined 也收成 0,是安全的。
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
    this.engine.onLog = (entry) => {
      this.table.pushLog(entry);
      // 升盲是「牌局条件变了」:顶栏的档位会跟着更新,但人正盯着牌桌,
      // 只写进侧栏日志很容易被错过(实测有人打完一局都没发现有升盲)——
      // 所以额外弹一次提示。两个升盲模式都走 kind='level',这里就都能提示到。
      if (entry.kind === 'level') this.table.toast(`📈 ${entry.text}`, 'warn', 2600);
    };
    /**
     * ★ 自动存档的挂点:引擎每次「牌局状态真的变了」都会调一次
     *   (startHand / act / 摊牌结算,见 engine.js 的 _touch)。
     * 为什么挂在这里而不是让界面在发牌、行动、结算三处各调一次 saveGame():
     *   界面层漏掉任何一处,表现就是「某一步之后刷新会退回上一个画面」——
     *   而这种丢失只在特定路径复现,极难查。挂在引擎内部,漏不掉。
     * ⚠️ 频率由 saveGame() 里的节流兜住(2 秒一次),这里只是**通知**,不做判断。
     */
    this.engine.onState = () => this.saveGame();
    this.buildPortraits();
    this.syncTopbar();
    // 「接手一个已有的引擎」也要补一次存档:恢复流程里引擎是先建好再 restore 的,
    // 中间那次 onState(空局面)不能把盘上的存档冲掉 —— restore 之后由 restoreGame 负责。
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
    // 中途改规则也等于「牌局还在跑」:退出入口和返回键标记都得在这里补一次
    // (这条路径绕开了 startGame,漏掉的话返回键在改过规则之后就不拦了)
    this.table.setExitEnabled(true);
    this.armBackGuard();
  }

  /** 应用内的确认框(不用原生 confirm —— 它会阻塞渲染线程) */
  showConfirm(title, sub, onOk, opts = {}) {
    this.hideConfirm();
    const mask = document.createElement('div');
    mask.className = 'confirm';
    mask.innerHTML = `
      <div class="confirm__box">
        <div class="confirm__title"></div>
        <div class="confirm__sub"></div>
        <div class="confirm__btns">
          <button class="btn" data-act="cancel"></button>
          <button class="btn btn--primary" data-act="ok"></button>
        </div>
      </div>`;
    mask.querySelector('.confirm__title').textContent = title;
    mask.querySelector('.confirm__sub').textContent = sub || '';
    // 按钮文案可覆盖(默认是「改规则重开」那套)。返回键退出用的是同一个框,
    // 但写「确定重开」就自相矛盾了 —— 这里只换文案,不另建一套 DOM,
    // 免得两套确认框的样式/交互迟早漂移。
    mask.querySelector('[data-act=cancel]').textContent = opts.cancelLabel || '取消';
    mask.querySelector('[data-act=ok]').textContent = opts.okLabel || '确定重开';
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

  /* ------------------------------------------------------------ 返回键退出 */

  /**
   * 手机上退出牌局的主路径:**返回键 / 侧滑返回**。
   *
   * 为什么不是「再给个按钮」就完事:
   *   手机上最自然的手势就是返回,而且它不依赖任何按钮 ——
   *   原来的问题正是「退出的按钮在被顶栏溢出挤掉的位置,要盲滑才点得到」,
   *   再加按钮只是把这个死结挪个地方。
   *
   * 做法(整条链路只有**一个** history 条目,不叠罗汉):
   *   · 开局时把**当前这条** history 条目 replaceState 成 {pokerGuard:1}。
   *     用 replace 而不是 push:push 会在用户历史里留痕(桌面浏览器返回时
   *     会多退一次才真正离开页面),而 replace 只标记「这一条现在归牌局管」,
   *     不改变历史长度 —— 也就不会出现「退出后按返回又回到牌局」的循环。
   *   · popstate 时看 history.state 里那枚标记:有标记 = 现在还在牌局里 → 弹确认;
   *     没标记 = 已经退过一次(或本来就在主页)→ 什么都不做,让浏览器正常后退。
   *
   * 边界(逐条对着实测):
   *   1. 主页 / 设置页按返回:标记已经清掉,onPopState 直接 return,不弹确认 ——
   *      否则用户退不出网页。
   *   2. 确认框开着时再按返回:hideConfirm() 收掉它。此时标记已经被上一步清空了,
   *      所以走的是「没标记」那条分支,**不会**再压一条 history 进去。
   *   3. 确认退出后:标记在弹框那一刻就清掉了(不叠加),用户停在主页那一条上,
   *      再按返回就是正常的浏览器后退。
   *   4. 取消之后要能**再按一次返回**:popstate 回调里同步改 history 会被浏览器忽略
   *      (导航还在进行中),所以用 setTimeout 把条目重新标记回来(见 _rearmBackGuard)。
   *   5. 玩家模式 / 荷官模式都生效 —— 判断的是「有没有在跑的牌局」,与模式无关。
   */
  armBackGuard() {
    try {
      // 先 disarm 再 arm:同一个会话里重复开局不会留下第二条标记
      this.disarmBackGuard();
      history.replaceState({ ...(history.state || {}), pokerGuard: 1 }, '', location.href);
      this.backGuardArmed = true;
      // 标记一挂上,「待处理的确认框」这一轮就算结束了 —— 下一次返回该重新弹框,
      // 而不是被当成「收框」给吃掉。正常情况下这一拍很快(下一个宏任务),
      // 但**不能依赖它快**:它就是用来兜住「重新挂标记这一步没成功」的
      // (那时 history 标记是空的,如果连这个字段也没有,用户按第二次返回就彻底没反应了)。
      this.backPromptUsed = false;
    } catch (err) {
      // 极少数环境(比如 file:// 下的某些壳)不让改 history:退回「只能点按钮退出」,
      // 但不能因为这一步失败就让开局整个挂掉
      console.warn('[back] 标记 history 失败:', err);
    }
  }

  disarmBackGuard() {
    if (!this.backGuardArmed) return;
    this.backGuardArmed = false;
    try {
      const st = { ...(history.state || {}) };
      delete st.pokerGuard;
      history.replaceState(Object.keys(st).length ? st : null, '', location.href);
    } catch { /* 忽略:清不掉也只是多一条标记,不影响退出流程 */ }
  }

  /**
   * popstate 里不能同步改 history(浏览器会忽略导航过程中的 replaceState),
   * 所以推迟一拍再把标记补回来。
   *
   * ⚠️ 这个「补回来」是必须的:不补的话用户会遇到
   *   「按返回 → 弹框 → 再按返回(框没了) → 再按返回**什么都不发生**」——
   *   想退出就得去点那个按钮,而这次改动的起因正是按钮不可达。
   *   另外补的时候**只 replaceState,不再 push**:多一条 history 就正是
   *   「退出之后按返回又回到牌局」那个循环的来源。
   */
  _rearmBackGuard() {
    setTimeout(() => {
      if (this.engine && this.running) this.armBackGuard();
    }, 0);
  }

  /** 当前这条 history 条目是不是「牌局标记着」的那一条 */
  _guarded() {
    return !!(this.backGuardArmed || history.state?.pokerGuard);
  }

  onPopState() {
    // 没在牌局里(主页 / 设置页):不拦。否则用户按返回退不出网页,
    // 这是比「退不出牌局」更严重的问题。
    if (!this.engine || !this.running) return;

    // ★ 第一优先:确认框正开着 → 这次返回是冲着**它**来的,收掉就完事。
    //   ⚠️ 这一条必须放在最前面。原来写成「有标记就弹框」时踩过:
    //     重新挂标记是**推迟一拍**做的(setTimeout 0,见 _rearmBackGuard),
    //     所以「弹框 → 立刻再按返回」和「弹框 → 隔一会儿再按返回」会走到两个分支,
    //     后者的表现是又换了一个新框出来 —— 用户按两次返回就看到两次弹框,
    //     典型得像「返回键没接好」。判据用「框在不在」而不是「标记在不在」,
    //     就与那一拍的时序无关了。
    if (this.confirmEl) {
      this.backPromptUsed = false;
      this.hideConfirm();
      return;
    }

    // 第二次:标记还在(正常情况;重新挂标记失败时由 backPromptUsed 兜底)→ 弹框问一句
    if (this._guarded() || this.backPromptUsed) {
      // 消费标记 —— 「确认退出」走的就是这一步的结果,不是另压一条 history。
      // 挂标记用 replaceState、清标记也用 replaceState,历史长度始终不变,
      // 所以浏览器历史里**不存在**「牌局」那一条,退出后按返回也就回不去。
      this.disarmBackGuard();
      this.backPromptUsed = true;
      // 但用户也可能只是想「先看看」,所以把标记补回来 ——
      // 不然取消之后他就再也按不出这个框了(只能去点按钮,而按钮正是这次要修的痛点)。
      this._rearmBackGuard();
      this.showConfirm('退出本局,回主页?', '当前这一手会立刻结束,之后可以重新选模式开始新的一局。', () => {
        // 走的是和抽屉按钮 / 手牌一览按钮**完全同一条**退出链路
        this.requestExit();
      }, { okLabel: '退出本局', cancelLabel: '继续打牌' });
      return;
    }

    // 都没有:用户是在**已经退出/已经取消**之后继续按返回 ——
    // 什么都不做,让浏览器正常后退(退到上一页)。
  }

  /**
   * 所有「退出本局」入口的唯一收尾:**先复用抽屉那套流程**(存设置 → 关卡片 → 回主页),
   * 再清掉返回键那些状态。
   *
   * 为什么一定要经过 drawer.requestExit():
   *   那里面除了 onExitHome() 还有「把当前设置存下来」这一步。
   *   如果这里直接调 this.exitToHome(),局中改过的设置就丢了,而且以后
   *   抽屉里的退出流程一改,这条路就悄悄和它不一致了。
   */
  requestExit() {
    const d = this.drawer;
    if (d?.requestExit) {
      d.requestExit();
      return;
    }
    // 兜底:抽屉还没建起来(理论上不会走到)
    this.exitToHome();
  }

  /* ------------------------------------------------------------ 一手的流程 */

  /** 中止当前这一手(改规则 / 重新开局时用) */
  cancelRun() {
    this.generation = (this.generation || 0) + 1;
    this.thinkingSeat = null;
    this.thinkingText = '';
    this.thinkingLive = false;
    // 胜率那一轮也一起扔掉:generation 变了,pumpEquity 的旧时间片会自己退出,
    // 但把引用清掉更彻底(否则它会一直挂在空闲回调队列里)
    this._eqRun = null;
    this._eqSig = '';
    this.equity = null;
    try { this.abort?.abort(); } catch { /* ignore */ }
    this.abort = new AbortController();
    this.flow.abort();
    // 玩家模式正在等我下注:把那个 Promise 解掉(generation 已经变了,
    // handler 会直接 resolve(false) 而不动引擎),否则旧的 playHandLoop 永远挂着
    if (this.myActionResolve) {
      const r = this.myActionResolve;
      this.myActionResolve = null;
      this.myTurnSeat = null;
      try { r({ type: 'fold' }); } catch { /* 忽略 */ }
    }
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
      // 只剩一个人 = 这一局彻底打完了,存档没有续玩的意义 —— 顺手清掉,
      // 免得下次启动主页还挂着「继续上一局」(点进去只会看到「牌局结束」)。
      this.gameStore?.clear();
      this._resumeInfo = null;
      this.home?.hideResume?.();
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
    this.actionSay = '';
    this.actionUntil = 0;

    // ⚠️ 发牌(startHand)只在这一条路径上做。恢复路径**不能**再发一手 ——
    //    引擎 state 里那一手就是存档里那一手,重新 startHand 会把底牌和筹码全部冲掉。
    try {
      this.engine.startHand();
    } catch (err) {
      console.error(err);
      (this.debugErrors ||= []).push('发牌出错: ' + (err?.message || err));
      this.table.toast('发牌出错:' + (err?.message || err), 'err', 6000);
      this.busy = false;
      this.refreshDealButton();
      return;
    }
    await this._playOutHand(gen);
  }

  /**
   * 发一手 + 打完 + 收尾 + 决定要不要自动开下一手。
   * 从 dealNext() 拆出来是为了让「恢复后接着打**当前这一手**」也能复用同一段逻辑
   * (那条路径不能走 dealNext —— 它开头会把「一手打到一半」当成非法状态直接返回)。
   *
   * @param {number} gen 调用时捕获的 generation;中途变了说明牌局已重开,要立刻收手
   */
  async _playOutHand(gen) {
    const run = (async () => {
      try {
        // ⚠️ 恢复路径下这一手**已经发过了**(startHand 的牌就在 state 里),
        //    所以调用方负责区分;这里只按「引擎现在的状态」往下打。
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
    while (guard++ < 400) {
      // 先查 generation 再碰 engine:退回主页时 engine 已经被置空
      if (gen !== this.generation || !this.engine) {
        (this.debugErrors ||= []).push('牌局已重开,中止上一手的行动循环');
        return false;
      }
      if (this.engine.state.handOver) break;
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
      const handler = (action) => {
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
          // 不结束等待:让玩家重新选 —— 必须把 handler 挂回去,
          // 上面已经把 myActionResolve 清空了,不挂回去之后点什么都没反应
          this.myTurnSeat = seat;
          this.myActionResolve = handler;
          this.updatePlayerBar();
          this.render();
          return;
        }
        this.thinkingSeat = null;
        this.updatePlayerBar();
        this.render();
        resolve(true);
      };
      this.myActionResolve = handler;
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
    for (const [seat, agent] of this.agents) {
      // 最多同时 3 个。必须在循环**里面**查:各 AI 写笔记的周期相同,
      // 只在循环前查一次的话 9 人桌每到第 3 手会一口气发出 8 个请求。
      // 这一手没轮上的会在下一手补上(shouldWriteNotes 看的是「距上次写过了几手」)。
      if (this._noteInFlight >= 3) break;
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
    // 每个 await 之后都要确认「还是同一局、同一个引擎」。
    // 只看闭包里的 st 不够:退出回主页 / 中途改规则会换掉 engine,
    // 旧的 st 仍然显示「轮到我」,于是旧决策会被 act 到**新引擎**上
    // (新一手第一个行动的人碰巧是同一个座位号时就直接生效了)。
    const gen = this.generation;
    const engine = this.engine;
    const stale = () => gen !== this.generation || this.engine !== engine
      || st.handOver || st.actor !== seat;

    const persona = this.personaMap.get(seat);
    this.thinkingSeat = seat;
    this.thinkingName = persona?.name || `座位${seat + 1}`;
    this.thinkingText = '';
    this.render();
    await this.flow.pauseBeforeAct();
    if (stale()) return;

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
        // 以前这里有一句 `if (!this.ui.showThinking) return;` ——
        // 那是「气泡只显示正在思考中、不显示文字」的开关。现在恒为显示,
        // 所以直接往下走(别再引入任何条件:文字有没有得看,只由模型的输出决定)。
        // JSON 还没长完时可能抠不出内容,那就先让界面显示「正在思考中…」
        this.thinkingText = tidyThinking(streamed);
        this.renderSeatOnly(seat);
      },
      // 把**真实原因**亮出来。以前只有一句「调用失败」,用户没法判断是 Key 错、
      // 模型名错、还是参数不认 —— 中转站排错全靠猜。完整原因同时写进牌局记录,toast 只放前一截。
      onError: (e = {}) => {
        const msg = String(e.message || '未知错误').replace(/\s+/g, ' ');
        const model = agent.cfg?.model ? `(${agent.cfg.model})` : '';
        if (e.level === 'info') {
          this.table.toast(`${agent.name}${model}:${msg}`, 'info', 3200);
          /**
           * 重试这类「还没失败、只是慢」的消息也要进牌局记录。
           *
           * 为什么:重试期间界面上只有一个「思考中」,用户看不到任何进展时
           * 会以为桌子卡住了(他对「等了很久没反应」非常敏感)。toast 3.2 秒就消失,
           * 记录里留一行才能事后确认「刚才那手是在重试第 2 次,不是死机」。
           * 只对带 retry 标记的消息记(参数降级成功那句不记,免得记录被刷屏)。
           */
          if (e.retry) this.table.pushLog({ kind: 'info', text: `↻ ${agent.name}${model}:${msg}` });
          return;
        }
        this.table.toast(`${agent.name}${model} 调用失败,本手先用本地策略:${msg.slice(0, 90)}`, 'warn', 5200);
        this.table.pushLog({ kind: 'info', text: `⚠ ${agent.name}${model} 调用失败:${msg.slice(0, 300)}` });
      },
      /**
       * 调试痕迹(onDebug)。
       *
       * 它记的是那些「用户看不出来、事后却需要解释」的降级 —— 目前主要是
       * **发言被拦掉**:模型的 say 报了自己的底牌/牌型,agent 把整句丢掉了
       * (见 agent.js 的 detectSayLeak)。
       * 刻意不弹 toast、也不进牌局记录:那不是错误,气泡安静一下本来就允许
       * (提示词明确写了「不想说话就留空」)。只有排查「为什么这手它没说话」
       * 时才需要它,所以和「动作被拒」那些诊断信息收在一起。
       */
      onDebug: (m) => { (this.debugErrors ||= []).push(String(m)); },
    };

    const t0 = Date.now();
    const decision = await agent.decide(view, history, { signal: this.abort?.signal });
    const elapsed = Date.now() - t0;
    if (stale()) return;

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
    // 恒为显示:这个字段原来叫 showThinking,是「气泡里给不给文字」的开关,
    // 现在没有开关了,直接赋值 —— 行为与「开关处于开」时逐字一致
    // (关掉时这里会被写成空串,气泡退回「正在思考中…」;那条分支已随开关一起删掉)。
    this.thinkingText = finalThink;
    this.thinkingSeat = seat;
    this.thinkingLive = true;
    this.render();
    if (!stale()) {
      this.table.setNextEnabled(true);
      this.updateHint();
      await this.flow.waitAfterThink(elapsed);
    }

    if (stale()) { this.thinkingLive = false; return; }

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

    // 动作气泡:思考气泡收掉之后,原地再显示一小会儿「他做了什么 + 他说了什么」。
    //
    // 为什么要这个:玩家模式下看不到别人的思考内容,如果气泡直接消失,
    // 就只剩「刚才有人动了但不知道动了什么」—— 得去翻日志才知道。
    // 现在气泡会接着显示「跟注 20」这样的结果,看完自然消失。
    //
    // say 是模型**主动说出口**的那句话(可以是真话,也可以是心理战)——
    // 和 thinking 是两回事:thinking 私密、玩家看不到,say 就是要给玩家看的。
    // 本地策略没有 LLM 说话,agent 会给一句跟动作对得上的中性短句。
    const label = applied?.label || GameApp.actionLabel(decision.action, decision.amount);
    if (this.mode === 'player' && (label || decision.say)) {
      this.actionSeat = seat;
      this.actionText = label;
      this.actionSay = decision.say || '';
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
    // 等动画期间可能已经退回主页
    if (!this.engine) return;

    // 牌局结束 / 我被淘汰:给一个明确的结束状态和出口。
    // 以前只有一条 toast,玩家模式下「发牌」按钮还会被藏掉 —— 画面停在那里不知道该干嘛。
    const players = this.engine.state.players;
    const alive = players.filter((p) => p.stack > 0);
    if (alive.length < 2) {
      const champ = alive[0];
      this.table.showBanner('牌局结束', `${champ ? this.engine.seatName(champ.seat) : '?'} 赢下全场`, 6000);
      this.table.toast('点右上角 ⚙ 设置 →「退出本局」可以回主页再来一局', 'ok', 9000);
    } else if (this.mode === 'player' && !this._bustNoticed) {
      const me = players[this.engine.state.humanSeat];
      if (me && me.stack <= 0) {
        this._bustNoticed = true;
        this.table.toast('你已出局 —— 可以继续点「发牌 / 下一手」观战,或在 ⚙ 设置 里退出回主页', 'warn', 9000);
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
    // 文字部分包在 .btn__label 里(手机上只显示图标,见 sceneFull.js 顶栏模板)
    btn.innerHTML = `${VIEW_ICON[this.deckView] || '🂠'}<span class="btn__label"> 底牌 <b>${VIEW_LABEL[this.deckView] || '盖着'}</b></span>`;
    btn.classList.toggle('is-active', this.deckView === 'up');

    // ⚠️ 气泡开关按钮(#btnThink)已删:顶栏这里原来负责刷新它的「开/关」文字与高亮。
    //    不用补占位语句 —— 它没有替代物,思考文字恒为显示。
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
    // 胜率是「状态变了才重算」的,而 ctx() 是所有渲染路径（render / renderIdle /
    // renderSeatOnly）的必经之路 —— 把「要不要重算」挂在这里,就不会漏掉哪条路径。
    this.ensureEquity();
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
        ? { seat: this.actionSeat, text: this.actionText || '', say: this.actionSay || '' }
        : null,
      personaMap: this.personaMap,
      deltas: st.lastResult?.deltas,
      winnerSeats: st.lastResult && handOver
        ? st.lastResult.winners?.map((w) => w.seat) : null,
      showdownReveal: !isPlayer && showdown && this.deckView !== 'board',
      humanSeat: st.humanSeat,
      // 摊牌胜率:**只有荷官模式有值**(玩家模式恒为 null,ensureEquity 里就没算)。
      // 它是纯显示层数据,不进 AI 的提示词、不影响任何决策。
      equity: this.equity,
      // 「正在算」也告诉界面 —— 否则刚发完牌那零点几秒里什么数字都没有,
      // 看着像功能没生效。
      equityPending: !!this._eqRun,
      ...extra,
    };
  }

  /* ------------------------------------------------------------ 摊牌胜率 */

  /**
   * 每个人的「此刻全部亮牌」赢牌概率(只给荷官看)。
   *
   * 为什么放在这里、而不是每帧算:
   *   · 一次模拟要评估「样本数 × 人数」手 7 张牌(≈40µs/次),
   *     9 人桌 1500 样本差不多 0.55s —— 每帧算等于把牌桌卡死;
   *   · 所以先用**状态签名**判断「该不该重算」:只有发牌 / 翻牌 / 转牌 / 河牌 /
   *     有人弃牌这些真正影响胜率的事才会换签名。下注、跟注、思考吐字都不换。
   *   · 换了签名也不一次算完:pumpEquity() 把它拆成若干时间片,在空闲回调里跑。
   *
   * ⚠️ 玩家模式绝不显示:玩家能看到所有人的胜率,这局就没意义了。
   *    判断顺序是有意的 —— **先判模式,再读底牌**。玩家模式下下面那段读 p.hole
   *    的代码根本不会执行(引擎 state 就在同一个进程里,读不读是我们的选择)。
   *    两道判断缺一不可:this.mode 是界面模式,st.humanSeat 是引擎口径,
   *    而 viewForDealer() 正是在 humanSeat 不为 null 时把别人的底牌抹成 [null,null]。
   */
  ensureEquity() {
    const st = this.engine?.state;
    if (!st) return;
    const dealer = this.mode === 'dealer'
      && (st.humanSeat === null || st.humanSeat === undefined)
      && !st.handOver && st.street !== 'idle';

    // 参与者:还在牌局里、没弃牌、两张底牌都拿到了
    let contenders = [];
    // 死牌 = 烧牌 + 「已知但不参与摊牌」的底牌(也就是弃牌者的牌)
    let dead = [];
    if (dealer) {
      contenders = st.players.filter((p) => p.inHand && !p.folded && p.hole.every((c) => c !== null));
      dead = (st.burned || []).slice();
      for (const p of st.players) {
        // ⚠️ 只算「这一手发了牌」的人。已被淘汰(!inHand)的人手里留的是**上一手的旧牌**,
        //    牌堆每手都重洗,把旧牌当死牌排除会把这一手真正在用的牌剔掉。
        if (!p.inHand) continue;
        const [c1, c2] = p.hole || [];
        const isContender = !p.folded && c1 !== null && c1 !== undefined && c2 !== null && c2 !== undefined;
        if (isContender) continue;
        // 弃牌者的牌荷官看得到,而且它们物理上**不可能**再出现在公共牌上。
        // 不排除就等于把两张已经发出去的牌又放回牌堆 —— 那会算得比常规胜率还差,
        // 而需求要的正是「比常规胜率更准」。
        if (c1 !== null && c1 !== undefined) dead.push(c1);
        if (c2 !== null && c2 !== undefined) dead.push(c2);
      }
    }

    // 只剩一个人(别人都弃了)时没有「胜率」可言,直接不显示
    const sig = contenders.length >= 2 ? this.equitySignature(st, contenders, dead) : '';
    if (sig === this._eqSig) return;      // ← 性能的关键:状态没变就一次都不重算
    this._eqSig = sig;
    this._eqRun = null;                   // 上一轮作废(它算的是旧状态)
    this.equity = null;
    if (!sig) return;

    try {
      this._eqRun = createEquityRun({
        contenders: contenders.map((p) => ({ seat: p.seat, hole: p.hole.slice() })),
        board: st.board.slice(),
        dead,
        shortDeck: !!st.shortDeck,
        samples: Math.max(EQUITY_MIN_SAMPLES,
          Math.min(DEFAULT_SAMPLES, Math.round(EQUITY_EVAL_BUDGET / contenders.length))),
      });
    } catch (err) {
      // 上游数据有问题(比如同一张牌出现两次)时**只记不改流程**:
      // 胜率是附加信息,绝不能因为它让牌局卡住。
      this._eqRun = null;
      (this.debugErrors ||= []).push('胜率计算失败: ' + (err?.message || err));
      return;
    }
    this.pumpEquity();
  }

  /**
   * 状态签名:只有它变了才重算。
   * 只把「真正影响胜率的东西」拼进去 —— 手数、模式、公共牌、每个参与者与死牌
   * (烧牌 + 弃牌者的牌)。底池、谁在思考、谁下了多少注都不影响
   * 「此刻全部摊牌谁赢」,所以不进签名 —— 下注/跟注因此一次都不会触发重算。
   */
  equitySignature(st, contenders, dead = []) {
    const parts = [st.handNo, st.shortDeck ? 'S' : 'N', st.board.join('.'), dead.join('.')];
    for (const p of contenders) parts.push(`${p.seat}:${p.hole.join('.')}`);
    return parts.join('|');
  }

  /**
   * 按时间片推进模拟。
   *
   * 为什么不用「算完再画」的一次性算法:一次 9 人桌翻牌前的模拟要几百毫秒,
   * 主线程被占着 → 牌桌上的动画、按钮、思考气泡全卡住。
   * 这里每次只给它几毫秒(空闲回调里有多少空闲时间就给多少),算完再重画一次。
   *
   * 期间状态一变(下一张牌、有人弃牌、退回主页),这一轮就直接扔掉:
   * 用 _eqRun 的身份 + generation 双重判定(和 AI 循环那套一致)。
   */
  pumpEquity() {
    const run = this._eqRun;
    if (!run) return;
    const gen = this.generation;
    const idle = typeof globalThis.requestIdleCallback === 'function';
    const pump = (deadline) => {
      if (this._eqRun !== run || gen !== this.generation || !this.engine) return;
      const left = deadline && typeof deadline.timeRemaining === 'function' ? deadline.timeRemaining() : 6;
      const done = run.step(Math.max(2, Math.min(12, left)));
      if (this._eqRun !== run) return;
      if (!done) {
        // timeout 兜底:页面一直很忙(idle 不触发)时也保证能往前推
        if (idle) globalThis.requestIdleCallback(pump, { timeout: 250 });
        else setTimeout(pump, 16);
        return;
      }
      this._eqRun = null;
      const res = run.result();
      const pct = new Map();
      res.seats.forEach((seat, i) => pct.set(seat, res.shares[i]));
      this.equity = { pct, exact: res.exact, samples: res.samples, ties: res.ties };
      // 签名没变,这次 render 不会再触发一轮计算
      this.render();
    };
    if (idle) globalThis.requestIdleCallback(pump, { timeout: 250 });
    else setTimeout(() => pump(), 0);
  }

  render(extra = {}) {
    // 退回主页后 engine 是 null;迟到的回调(节奏控制器、流式片段、快捷键)都会走到这里
    if (!this.engine) return;
    const view = this.engine.viewForDealer();
    const ctx = this.ctx(extra);
    this.table.updateTopbar(view, this.statLine(), STREET_TEXT[view.street]);
    this.table.updatePot(view.pot, true);
    this.table.updateSeats(view, ctx);
    if (!this.busy) this.table.setDealEnabled(this.canDeal());
    this.updatePlayerBar();
  }

  renderSeatOnly(seat) {
    if (!this.engine) return;
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

    d.btnModels.addEventListener('click', () => this.openModelsPanel());

    // ⚠️ 「💭 气泡 开/关」按钮的监听已删(按钮本身也删了,见 sceneFull.js 顶栏模板)。
    //    它原来做的是 `this.ui.showThinking = !showThinking` + saveConfig。
    //    现在思考文字恒为显示,没有任何东西可切 —— 别在这里补一个空监听,
    //    那只会让人以为按钮还在。
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
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement
        || t instanceof HTMLTextAreaElement || t?.isContentEditable) return;
      if (e.key === 'Escape') { this.drawer.hide(); this.modelsPanel.hide(); return; }
      // 主页 / 设置 / 确认框开着时不响应牌桌快捷键:
      // 否则主页上按空格会去发牌(engine 还是 null,直接抛错),
      // 设置页里聚焦按钮按空格也会被 preventDefault 吃掉
      if (!this.engine || document.querySelector('.setup.is-open') || this.confirmEl) return;
      // 焦点在按钮上时空格 / 回车交给按钮自己(原生就是「点它」)
      const onButton = t instanceof HTMLButtonElement;
      // 空格 / 回车 = 下一位;没有在等待时就发牌
      if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat && !onButton) {
        e.preventDefault();
        if (this.flow.waiting) this.flow.advance();
        else if (this.canDeal()) this.dealNext();
      }
      if (e.key === 'm' || e.key === 'M') d.btnModels.click();
      // 下面这几个是荷官专属:玩家模式下按钮只是被隐藏了,对隐藏按钮 .click() 照样会触发 ——
      // 按 T 就能在下注前看到所有 AI 这一手的思考(「我有 AA,慢打」),破坏信息隔离
      if (this.mode === 'player') return;
      if (e.key === 'p' || e.key === 'P') d.btnPeek.click();
      if (e.key === 't' || e.key === 'T') d.btnThinkLog.click();
      if (e.key === 'a' || e.key === 'A') d.btnMode.click();
    });
  }
}

export { PERSONAS };
// 思考文本的整理逻辑单独导出,便于测试直接覆盖各种「半个 JSON / 英文推理」的情况
// (这段逻辑以前出过问题:模型的英文推理混着中文名字,老判据挡不住,整段糊到气泡上)
export { tidyThinking, hasThinking };
