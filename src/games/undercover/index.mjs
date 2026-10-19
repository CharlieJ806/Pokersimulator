/**
 * 谁是卧底 —— 游戏注册表里的那个模块(`GameModule` 契约的实现)。
 *
 * 这个文件是「卧底对平台说的全部话」:
 *   · 目录信息(id / 标题 / 图标 / 描述 / 能否玩 / 玩法 / 模式卡文案);
 *   · createEngine  —— 按游戏设置建规则内核;
 *   · createAgent   —— 按座位建 AI;
 *   · mount/unmount —— 把游戏画面挂上/拆掉(画面本体在 ui/screen.js);
 *   · settingsSchema —— 设置项清单;
 *   · validateSnapshot —— 存档能不能用;
 *   · score(result, cfg) —— **本游戏自己的**算分声明(实现在 scoring.js,不跨游戏)。
 *
 * ⚠️ 本文件必须在纯 Node 里也能 import(tools/registrytest.mjs、tools/undercovertest.mjs
 *    都是干这个的):顶层只 import 纯逻辑(kernel / agent / words / gameDefaults),
 *    **别在这里顶层 import ui/** —— 3D 与 DOM 要留给 mount() 里的动态 import。
 *
 * 目录结构(与扑克对称):
 *   engine/kernel.js  纯规则:发词 / 顺序 / 计票 / 胜负 / 白板 / 猜词
 *   view.js           唯一的信息出口(每个人只拿到自己的词;猜的词按规则截断)
 *   agent.js          提示词 + 解析 + 过滤 + 降级(含「想猜词」的闸门)
 *   runner.js         一局的流程驱动(描述 → 投票 → 淘汰 → 判负)
 *   words.js          词库(96 对,人工筛)
 *   filter.js         代码级发言过滤
 *   scoring.js        **本场**积分与排名(这个游戏自己的算分,不跨游戏)
 *   store.js          存档槽(独立的 localStorage 键)
 *   ui/screen.js      画面(3D 场景 + 大厅 + 描述矩阵 + 投票面板 + 排名)
 */

import { createKernel, UndercoverKernel } from './engine/kernel.js';
import { UndercoverAgent } from './agent.js';
import { score, matchSummary as undercoverMatchSummary } from './scoring.js';
import { gameDefaultsOf } from '../../shared/gameDefaults.mjs';

/**
 * 当前挂着的屏幕(同一时刻只有一个 —— 契约就是这么用的:一个窗口挂一个游戏)。
 * mount 建它、unmount 拆它。
 */
let mounted = null;

export const undercover = {
  id: 'undercover',
  title: '谁是卧底',
  icon: '🕵️',
  // 卡片正文:一句「你是谁」+ 一句「好玩在哪」。与扑克那张卡的写法保持一致 ——
  // 主页上三张卡应该是同一种口吻,而不是换了游戏就换一种说法。
  desc: '大多数人拿同一个词,只有卧底拿相近的另一个 —— 但连他自己都不知道。'
    + '听每个人描述,靠「说得对不对得上」把他揪出来。',
  available: true,
  // 'watch' = 观看 AI(上帝视角,能看到每个人的词与自省)/ 'join' = 自己加入(6 人之一)
  modes: ['watch', 'join'],

  /**
   * 主页第二层那两张模式卡的**本游戏文案**。
   *
   * 为什么由游戏自己给(home.js 只留一份扑克兜底):标题/描述是游戏自己的话 ——
   * 「荷官模式 / 发牌」对卧底毫无意义。让文案跟着游戏走,加第三个游戏时
   * 主页不用再长一条 if。键与 modes 一一对应;home.js 用这里的覆盖默认值。
   */
  modeCards: {
    watch: {
      icon: '<span class="ic">🕵️</span>',
      title: '上帝视角',
      desc: '你看得到每个人的词、真实阵营,还有它自己猜自己是谁 —— 它猜错的时候最好看。',
      cta: '看着 AI 玩',
    },
    join: {
      icon: '<span class="ic ic--player"><i></i></span>',
      title: '自己加入',
      desc: '你也是桌上的一员:只知道自己的词,连自己是不是卧底都要靠推理。'
        + '轮到你时还能赌一把 —— 直接报出平民的词。',
      cta: '加入这一局',
    },
  },

  /**
   * 按卧底的设置建内核。
   *
   * 字段映射**只有这一份**(与扑克 createEngine 的约定一致):
   * 设置面板里那一格 → 内核参数的哪一项。host 只补 humanSeat(玩家坐几号位)。
   * @param {object} cfg games.undercover + 宿主补的 humanSeat
   */
  createEngine(cfg = {}) {
    const g = cfg || {};
    return createKernel({
      seats: g.seats,
      undercoverCount: g.undercoverCount,
      // 白板人数(0/1)。门槛(≥7 人)与夹取都在 kernel.normalizeConfig 里,
      // 这里只负责透传 —— 别在两处各判一次,那必然出现「界面禁了、内核还开着」。
      blankCount: g.blankCount,
      rounds: g.rounds,
      difficulty: g.difficulty,
      // 玩家模式:人坐 0 号位(与扑克一致);观看模式为 null
      humanSeat: g.humanSeat ?? null,
    });
  },

  /**
   * 每个座位一个独立 AI 实例(座位之间不共享任何东西)。
   * @param {number} seat
   * @param {object} persona 性格(名字在这之前已经被换成模型名)
   * @param {object} agentCfg 这个座位用哪家模型/Key(由宿主的 agentCfg 组装)
   * @param {object} hooks 宿主回调
   */
  createAgent(seat, persona, agentCfg, hooks = {}) {
    return new UndercoverAgent(seat, persona, agentCfg, hooks);
  },

  /**
   * 挂上游戏画面。
   *
   * 为什么是 async:画面要用 3D(sceneCore + vendor/three.js)。顶层 import 会把
   * 整个 three.js 拖进纯 Node 的注册表测试;所以屏幕模块在这里动态 import。
   *
   * @param {HTMLElement} root
   * @param {object} ctx 宿主回调 —— 见 ui/screen.js 的文件头(模型配置 / 保存设置 /
   *   打开模型面板 / 退出本局 / 立绘 / 性格)
   * @returns {Promise<object>} 屏幕对象(壳当通用界面句柄用)
   */
  async mount(root, ctx = {}) {
    this.unmount();
    const { createScreen } = await import('./ui/screen.js');
    mounted = createScreen(root, {
      getPersona: ctx.getPersona,
      getPortrait: ctx.getPortrait,
      getAgentCfg: ctx.getAgentCfg,
      getConfig: ctx.getConfig,
      onSaveConfig: ctx.onSaveConfig,
      onModels: ctx.onModels,
      // 退出有两条路:屏幕自己的「退出本局」直接回主页(onExitHome);
      // 宿主的返回键/确认框走 requestExit → 屏幕的 handleExit(见 app.js)。
      onExitGame: ctx.onExitGame,
      onExitHome: ctx.onExitHome,
      onGameStarted: ctx.onGameStarted,
      onGameEnded: ctx.onGameEnded,
      // ★ 一场结束 → 把 matchSummary 交给平台壳折成全局分(写持久化排行榜)。
      //   屏幕只负责「这一场的最终排名」,权重与存储都在平台那一层 ——
      //   换游戏/加游戏时,这条回调完全一样。
      onMatchEnded: ctx.onMatchEnded,
      // 游戏模块自己的工厂:屏幕建内核 / agent 时走同一条路(不在屏幕里再 new 一个类,
      // 否则「宿主用的实现」与「屏幕用的实现」迟早变成两种东西)
      createEngine: (cfg) => undercover.createEngine(cfg),
      createAgent: (seat, persona, agentCfg, hooks) => undercover.createAgent(seat, persona, agentCfg, hooks),
    });
    return mounted;
  },

  unmount() {
    if (!mounted) return;
    try { mounted.destroy?.(); } catch { /* 拆的时候出错不该影响宿主继续走 */ }
    mounted = null;
  },

  /**
   * 这份存档能不能用(壳在启动读档、以及「继续上一局」时各问一次)。
   * 不合格**抛错**,合格返回 true —— 与扑克的约定一致。
   */
  validateSnapshot(snap) {
    UndercoverKernel.validateSnapshot(snap);
    return true;
  },

  /**
   * 额外的一个小钩子(不在 GameModule 六项里,宿主可以不认):
   * 「这份存档是不是我这个游戏的?」
   *
   * 为什么需要:主机的「继续上一局」槽里可能是**别的游戏**的快照
   * (用户在两个游戏之间换着玩)。这时不能拿卧底的校验器去判它、更不能顺手删掉 ——
   * 那会把扑克的存档清掉。宿主问这一句,答 false 就当作没有存档。
   */
  ownsSnapshot(snap) {
    return !!snap && snap.game === 'undercover';
  },

  /**
   * 一局结算的**算分声明**:`score(result, cfg) → [{ seat, delta, label }]`。
   *
   * ⚠️ 这是**这个游戏自己的**算分,不是平台框架(用户明确要求:积分只在
   *    「本局游戏内」有意义)。平台/界面只做两件事:把结算结果原样交进来、
   *    把返回的数组累加起来展示 —— 它们不解释 result 里的任何字段,也不该有
   *    一张「跨游戏积分表」(狼人杀以后要算分就自己写一份,分值口径不同)。
   *
   * 实现与分值理由全在 ./scoring.js 的文件头(scoring.js 是唯一真源,
   * 这里只是把它挂到 GameModule 上,方便调用方按游戏取)。
   */
  score,

  /**
   * **一场的最终排名**(平台据此算全局分)。
   * `matchSummary(scoreboard, ctx) → { gameId, rounds, seats, ranking }`,
   * 与扑克 / 狼人杀同一个形状;实现在 scoring.js。
   */
  matchSummary(source, ctx) {
    return undercoverMatchSummary(source, ctx);
  },

  /**
   * 这个游戏的设置项(给「游戏设置」用)。
   * 默认值现取自 gameDefaults 真源(不在这里写死第二份数字)。
   */
  settingsSchema() {
    const d = gameDefaultsOf('undercover');
    return { fields: Object.keys(d).map((key) => ({ key, default: d[key] })) };
  },
};
