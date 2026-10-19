/**
 * 「阿瓦隆」—— 游戏注册表里的那个模块(`GameModule` 契约的实现)。
 *
 * 这个文件是「阿瓦隆对平台说的全部话」:
 *   · 目录信息(id / 标题 / 图标 / 描述 / 能否玩 / 玩法 / 模式卡文案);
 *   · createEngine  —— 按游戏设置建规则内核;
 *   · createAgent   —— 按座位建 AI;
 *   · mount/unmount —— 把游戏画面挂上/拆掉(画面本体在 ui/screen.js);
 *   · settingsSchema —— 设置项清单;
 *   · validateSnapshot / ownsSnapshot —— 存档能不能用、是不是我的;
 *   · score()       —— **这一场游戏内**的积分(见 scoring.js 的长注释)。
 *
 * ⚠️ 本文件必须在纯 Node 里也能 import(tools/registrytest.mjs、tools/avalonest.mjs
 *    都是干这个的):顶层只 import 纯逻辑(kernel / agent / scoring / gameDefaults),
 *    **别在这里顶层 import ui/** —— 3D 与 DOM 要留给 mount() 里的动态 import。
 *
 * 目录结构(与扑克、卧底、狼人杀对称):
 *   engine/kernel.js  纯规则:任务表 / 发身份 / 组队 / 投票 / 投卡 / 刺杀 / 胜负
 *   view.js           唯一的信息出口(三段式私有信息 + 上帝视角)
 *   prompts.js        提示词(纯函数,可被测试逐条断言)
 *   agent.js          解析 + 过滤 + 降级
 *   filter.js         代码级发言过滤
 *   runner.js         一局的流程驱动(组队 → 投票 → 投卡 → 刺杀)
 *   scoring.js        本场积分 + 累计榜
 *   personas.js       座位性格(推理方式 / 常见误判)
 *   store.js          存档槽(独立的 localStorage 键)
 *   ui/screen.js      画面(3D 场景 + 身份卡 + 票型 + 任务进度)
 */

import { createKernel, AvalonKernel } from './engine/kernel.js';
import { AvalonAgent } from './agent.js';
import { score as scoreRound } from './scoring.js';
import { gameDefaultsOf } from '../../shared/gameDefaults.mjs';

/**
 * 当前挂着的屏幕(同一时刻只有一个 —— 契约就是这么用的:一个窗口挂一个游戏)。
 * mount 建它、unmount 拆它。
 */
let mounted = null;

export const avalon = {
  id: 'avalon',
  title: '阿瓦隆',
  icon: '⚔️',
  // 卡片正文:一句「你是谁」+ 一句「好玩在哪」。与其它三张卡同一个口吻。
  desc: '你是圆桌旁的一员:有人知道谁是坏人,有人只能靠票型猜。'
    + '队伍一遍遍被否、任务一次次被破坏,而最危险的那个人,恰好什么都知道。',
  available: true,
  // 'watch' = 上帝视角(看所有人的身份与每一张任务卡)/ 'join' = 自己加入
  modes: ['watch', 'join'],

  /**
   * 主页第二层那两张模式卡的**本游戏文案**。
   * 键与 modes 一一对应;home.js 用这里的覆盖默认值(与狼人杀/卧底同一套机制)。
   */
  modeCards: {
    watch: {
      icon: '<span class="ic">⚔️</span>',
      title: '上帝视角',
      desc: '谁是谁、哪一队是谁否掉的、每一轮是谁投了失败卡,你都看得到 —— 看他们怎么演。',
      cta: '看着 AI 玩',
    },
    join: {
      icon: '<span class="ic ic--player"><i></i></span>',
      title: '自己加入',
      desc: '你也坐在圆桌旁:只知道自己的身份,选人、投票、上车,最后还有人要刺杀梅林。',
      cta: '加入这一局',
    },
  },

  /**
   * 按阿瓦隆的设置建内核。
   *
   * 字段映射**只有这一份**(与其它游戏 createEngine 的约定一致):
   * 设置面板里那一格 → 内核参数的哪一项。host 只补 humanSeat(玩家坐几号位)。
   * @param {object} cfg games.avalon + 宿主补的 humanSeat
   */
  createEngine(cfg = {}) {
    const g = cfg || {};
    return createKernel({
      seats: g.seats,
      variant: g.variant,
      speakDelayMs: g.speakDelayMs,
      // 玩家模式:人坐 0 号位(与其它游戏一致);观看模式为 null
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
    return new AvalonAgent(seat, persona, agentCfg, hooks);
  },

  /**
   * 挂上游戏画面。
   *
   * 为什么是 async:画面要用 3D(sceneCore + vendor/three.js)。顶层 import 会把
   * 整个 three.js 拖进纯 Node 的注册表测试;所以屏幕模块在这里动态 import。
   *
   * @param {HTMLElement} root
   * @param {object} ctx 宿主回调(见 ui/screen.js 的文件头)
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
      onExitGame: ctx.onExitGame,
      onExitHome: ctx.onExitHome,
      onGameStarted: ctx.onGameStarted,
      onGameEnded: ctx.onGameEnded,
      // 游戏模块自己的工厂:屏幕建内核 / agent 时走同一条路(不在屏幕里再 new 一个类,
      // 否则「宿主用的实现」与「屏幕用的实现」迟早变成两种东西)
      createEngine: (cfg) => avalon.createEngine(cfg),
      createAgent: (seat, persona, agentCfg, hooks) => avalon.createAgent(seat, persona, agentCfg, hooks),
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
   * 不合格**抛错**,合格返回 true —— 与其它游戏的约定一致。
   */
  validateSnapshot(snap) {
    AvalonKernel.validateSnapshot(snap);
    return true;
  },

  /**
   * 这份存档是不是我这个游戏的?
   * (主机的「继续上一局」槽里可能是别的游戏的快照 —— 那时不能拿阿瓦隆的
   *  校验器去判它、更不能顺手删掉,那会把别人的存档清掉。)
   */
  ownsSnapshot(snap) {
    return !!snap && snap.game === 'avalon';
  },

  /**
   * 这个游戏的设置项(给「游戏设置」用)。
   * 默认值现取自 gameDefaults 真源(不在这里写死第二份数字)。
   */
  settingsSchema() {
    const d = gameDefaultsOf('avalon');
    return { fields: Object.keys(d).map((key) => ({ key, default: d[key] })) };
  },

  /**
   * **本场积分**(用户口径:积分只属于这一场游戏,不是跨游戏累计)。
   * 签名与平台约定一致:`score(result, cfg) → [{ seat, delta, label }]`。
   */
  score(result, cfg) {
    return scoreRound(result, cfg);
  },
};
