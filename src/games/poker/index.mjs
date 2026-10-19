/**
 * 德州扑克 —— 当前**唯一**能玩的游戏,也是 GameModule 契约的参考实现。
 *
 * 2b 之后这个文件就是「扑克对平台说的全部话」:
 *   · 目录信息(id / 标题 / 图标 / 描述 / 能否玩 / 玩法);
 *   · createEngine  —— 按游戏设置建引擎(字段映射**只在这里有一份**);
 *   · createAgent   —— 按座位建 AI 代理;
 *   · mount/unmount —— 把牌桌画面挂上/拆掉(画面本体在 ui/screen.js);
 *   · settingsSchema —— 设置项清单;
 *   · validateSnapshot —— 存档能不能用(壳读档时问它,不认识引擎类)。
 * 引擎在 engine/,AI 提示词与决策在 agent.js,界面在 ui/ —— 都只有扑克用。
 *
 * ⚠️ 本文件必须在纯 Node 里也能 import(tools/registrytest.mjs 就是干这个的):
 *    顶层 import 的全是纯逻辑模块(engine / agent / gameDefaults,不碰 DOM)。
 *    **别在这里顶层 import ui/** —— 那会把 three.js 和 DOM 一起拖进 Node。
 *    3D 模块是在 mount() 里**动态 import** 的,那才是它该被加载的时机。
 */

import { PokerEngine } from './engine/engine.js';
import { PokerAgent } from './agent.js';
import { gameDefaultsOf } from '../../shared/gameDefaults.mjs';
import { score as scoreRound, matchSummary as pokerMatchSummary } from './scoring.js';

/**
 * 当前挂着的牌桌(同一时刻只有一个)。
 * mount 建它、unmount 拆它 —— 契约就是这么用的:一个窗口挂一个游戏。
 */
let mounted = null;

export const poker = {
  id: 'poker',
  title: '德州扑克',
  icon: '♠',
  // 卡片正文:一句「你是谁」+ 一句「有什么好看的」。原来的主页第一张卡
  // (荷官模式)写的就是这么一句,这里沿用同一套口吻 —— 玩家在主页看到的
  // 应该是同一句话,而不是换了入口就换了说法。
  desc: '你是荷官:发牌、控节奏、看别人打。桌上全是独立的大模型牌手,'
    + '每个人有自己的性格和思路。',
  available: true,
  // 'watch' = 荷官模式(看 AI 打) / 'join' = 玩家模式(自己上桌)
  // ⚠️ 这两个 key 与主页模式卡上的 data-mode('dealer'/'player')**不是一回事**:
  //    modes 是「游戏提供什么玩法」,data-mode 是**界面自己的历史叫法**(测试和
  //    app.js 都在用)。两者的对照表只有一份,在 src/ui/home.js 的 MODE_CARDS 里。
  modes: ['watch', 'join'],

  /**
   * 按扑克的设置建引擎 —— **字段映射的唯一一份**。
   *
   * 2a 时这段映射在 app.js 的 buildEngine 里,这里只是「给契约用」的副本(那时
   * blindtest / blindorbittest 会扫 app.js 的源码,把那一个构造表达式抠出来跑,
   * 保证「设置面板 → 字段映射 → 引擎」这条链没断)。2b 把那两条扫描的目标改到
   * 了**本文件**,两份映射因此合并成一处 —— 扫描强度没降,反而多了一条
   * 「app.js 里不许出现 PokerEngine」。
   *
   * @param {object} cfg 扑克的设置(games.poker),外加宿主补的 humanSeat。
   */
  createEngine(cfg) {
    const g = cfg || {};
    return new PokerEngine({
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
      // 玩家模式:人坐 0 号位(座位名后面会被 persona 覆盖)。荷官模式为 null。
      // ⚠️ 这个值**不是**游戏设置,由界面决定(玩家模式坐几号位),所以由宿主算好传进来。
      humanSeat: g.humanSeat ?? null,
    });
  },

  /**
   * 每个座位一个独立 AI 实例(座位之间不共享任何东西,见 agent.js 的文件头)。
   * @param {number} seat
   * @param {object} persona  性格与打法参数(名字在这之前已经被换成模型名)
   * @param {object} agentCfg 这个座位用哪家模型/Key(由 app.agentCfg 组装)
   * @param {object} hooks    宿主回调(扑克现在只用它做调试痕迹)
   */
  createAgent(seat, persona, agentCfg, hooks = {}) {
    return new PokerAgent(seat, persona, agentCfg, hooks);
  },

  /**
   * 挂上牌桌画面。
   *
   * 为什么这里是 **async**(契约允许 mount 返回 Promise):
   *   画面要用 three.js(1.3MB 的 vendor 模块)。如果顶层 import,纯 Node 的
   *   registrytest 光为了读一眼注册表就得把整个 three.js 拖进来 —— 那既慢,
   *   也把「注册表不碰 DOM」这条底线变成了「碰了但没报错」。所以 3D 模块在这里
   *   动态 import,宿主 `await` 一下即可。
   *
   * @param {HTMLElement} root 宿主给的容器(游戏不许自己去 document 里找)
   * @param {object} ctx 宿主回调 { getPersona, getPortrait, onExitGame }
   * @returns {Promise<object>} 屏幕对象(壳当通用的界面句柄用:setHint / toast / updateSeats …)
   */
  async mount(root, ctx = {}) {
    // 先拆掉上一块(重复 mount 不该叠两层 canvas)
    this.unmount();
    const { createScreen } = await import('./ui/screen.js');
    mounted = createScreen(root, {
      getPersona: ctx.getPersona,
      getPortrait: ctx.getPortrait,
      onExitGame: ctx.onExitGame,
    });
    return mounted;
  },

  /**
   * 拆掉 mount 建的东西(渲染循环、DOM)。
   * 必须可重复调用、且未 mount 时也安全 —— 宿主在「换游戏 / 退出」两条路上都会调。
   */
  unmount() {
    if (!mounted) return;
    try { mounted.destroy?.(); } catch { /* 拆的时候出错不该影响宿主继续走 */ }
    mounted = null;
  },

  /**
   * 这份存档能不能用(壳在启动读档、以及「继续上一局」时各问一次)。
   *
   * 为什么校验放在游戏这边:只有游戏自己知道快照该长什么样(版本号、settings 的
   * 取值范围、「牌 id 必须是数字」这类)。壳只负责「不能用就当场丢掉」,
   * 不该认识 PokerEngine.validateSnapshot 这个静态方法 —— 那正是 2b 要拆掉的耦合。
   * @param {object} snap
   * @returns {boolean} 通过(true);不合格时**抛错**(带一句能看懂的说明)
   */
  validateSnapshot(snap) {
    PokerEngine.validateSnapshot(snap);
    return true;
  },

  /**
   * 这个游戏的设置项(给「游戏设置」用)。
   *
   * ⚠️ 只交字段清单,不交 label/min/max:真正那份表单(每个 input 的 id、
   *    夹取规则、以及「blindUpEvery 不读取也不覆盖」那条约定)在 ui/setup.js 里。
   *    在这里抄一份 label/range 必然与表单走样 —— 两份规则打架比没有规则更难查。
   * 默认值一律现取自 gameDefaults 真源(不在这里写死数字,否则加字段时又多个来源)。
   * @returns {{fields: Array<{key: string, default: any}>}}
   */
  settingsSchema() {
    const d = gameDefaultsOf('poker');
    return { fields: Object.keys(d).map((key) => ({ key, default: d[key] })) };
  },

  /**
   * **局内积分**(平台统一接口):一手的净筹码输赢。
   * 签名与卧底 / 狼人杀一致:`score(result, cfg) → [{ seat, delta, label }]`。
   * 扑克的「分」就是筹码 —— 不发明第二套分,理由见 scoring.js 的文件头。
   */
  score(result, cfg) {
    return scoreRound(result, cfg);
  },

  /**
   * **一场的最终排名**(平台据此算全局分)。
   * `matchSummary(state, ctx) → { gameId, rounds, seats, ranking }`,
   * 与另外两个游戏同一个形状;实现在 scoring.js。
   */
  matchSummary(source, ctx) {
    return pokerMatchSummary(source, ctx);
  },
};
