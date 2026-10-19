/**
 * 游戏注册表 + `GameModule` 契约 —— 多游戏平台**唯一**的游戏目录。
 *
 * 为什么要有这一层:
 *   · 这个项目正从「单一德州扑克」扩成小游戏平台。只要界面上出现第二个游戏,
 *     「有哪些游戏 / 每个游戏能玩什么 / 怎么把它跑起来」就必须有一个**集中的答案**,
 *     否则每加一个游戏 = 在 app.js 里加一堆 if,加三个之后没人敢动;
 *   · 配置那一侧已经收口了(src/shared/gameDefaults.mjs 的 DEFAULT_GAME_ID /
 *     GAME_DEFAULTS / gameCfg),这一层是它的对称物:**配置在哪儿、代码在哪儿**。
 *   · 2a 阶段只落地契约与目录,**不搬目录、不拆 3D、不动游戏内核**:
 *     扑克的引擎/代理还是原来那两个类,只是从这里「按游戏」取。
 *
 * ⚠️ 这个文件必须能被**纯 Node**直接 import(tools/registrytest.mjs 就是干这个的),
 *    所以模块顶层不许碰 window / document / localStorage。游戏模块只导出描述对象与
 *    工厂函数,真正的 DOM 操作留在 mount 里(调用时才执行)。
 *
 * ⚠️ DEFAULT_GAME_ID **不在这里定义**,而是从 gameDefaults.mjs 转发出去。
 *    一期踩过的坑:配置默认值和「默认玩哪个游戏」这两个值一旦各存一份,
 *    迁移脚本与界面就会各用各的,表现是「配置里写着 poker,界面判断却认为没游戏」。
 *    tools/registrytest.mjs 有一条断言专门盯着「同一份真源」。
 */

import { DEFAULT_GAME_ID } from '../shared/gameDefaults.mjs';
import { poker } from './poker/index.mjs';
// ★ 狼人杀 3c 起也是**真的能玩**的游戏(2a 时它只是一张灰卡)。
//   入口从 `./werewolf.mjs`(占位文件)改成了 `./werewolf/index.mjs`,
//   与扑克 / 卧底同一个形状:入口 index.mjs + engine/ + ui/ + props/。
//   ⚠️ 只改这一行 import(MVP 时占位文件里字段全是显式 null,现在整份实现都在目录里)。
import { werewolf } from './werewolf/index.mjs';
// ★ 谁是卧底 2b 起是**真的能玩**的游戏(2a 时它只是预留入口,available:false)。
//   目录结构照抄扑克:入口 index.mjs + engine/ + ui/ + props/,注册表只认入口。
import { undercover } from './undercover/index.mjs';
// ★ 阿瓦隆:与狼人杀同一个形状(入口 index.mjs + engine/ + view/prompts/agent/
//   filter/runner/scoring/store + ui/ + props/)。它是这个平台的**第四种流程**:
//   没有「夜/天」、没有出局,而是「队长选人 → 投票 → 上车 → 下一轮」的轮次制。
import { avalon } from './avalon/index.mjs';

/**
 * 一个游戏要交给平台的东西(下面这段 JSDoc 就是**契约本身**,编辑器里能当类型用)。
 * **这就是新游戏的实现清单** —— 照下面把字段填满,再在 GAMES 里注册一行,
 * 主页就会多一张卡、配置会多一个 games[<id>] 分组,其余地方一行都不用改。
 *
 * @typedef {object} GameModule
 *
 * 必需字段(每个游戏**都必须**有,包括还没开放的):
 * @property {string}   id       唯一标识。⚠️ 必须与 gameDefaults.mjs 的 GAME_DEFAULTS 用同一个 key:
 *                               配置是 `games[<id>]`,对不上就会读出一份空设置(牌桌静默变默认值,
 *                               最难查的那种)。小写、无空格,例如 'poker'。
 * @property {string}   title    主页卡片上的名字,例如 '德州扑克'。
 * @property {string}   icon     卡片左上角那一个字符/emoji(['♠','🐺','🕵️'])。故意只收一个字符:
 *                               卡片是复用现有 .modecard 样式的,`.ic` 那个 40×40 的方框只放得下一个。
 * @property {string}   desc     卡片正文。⚠️ 写「玩家是谁 + 这个游戏好玩在哪」,
 *                               不要写操作说明(操作说明属于模式卡/设置页)。
 * @property {boolean}  available true = 能进;false = 主页上是一张灰卡(写了「敬请期待」,
 *                               按钮 disabled,点了不进入)。判「能不能进」**只认这一个字段**,
 *                               别再各自去猜实现有没有填(猜法必然分叉)。
 * @property {string[]} modes     这个游戏有哪几种玩法。当前只有两种约定好的 key:
 *                                 'watch' = 观看 AI(扑克的荷官模式)
 *                                 'join'  = 自己加入(扑克的玩家模式)
 *                               主页用 MODE_CARDS 把 key 翻成卡片上的字(见 src/ui/home.js)。
 *                               未开放的游戏给空数组:它没有可玩的玩法,但也别给 null ——
 *                               调用方可以放心 .map / .length。
 *
 * 实现字段(available: true 的游戏**必须全部**实现;available: false 的**显式写 null**):
 * @property {(cfg:object)=>object} createEngine         按本游戏的设置建一个引擎实例。
 *                                                       cfg = games[<id>] 那份设置(会再补上
 *                                                       宿主才知道的东西,例如扑克的 humanSeat
 *                                                       「玩家坐哪一席」)。返回值的形状由游戏自己定,
 *                                                       平台只负责「把它存到 app.engine 上并驱动它」。
 * @property {(seat:number, persona:object, agentCfg:object, hooks:object)=>object} createAgent
 *                                                       按座位建一个 AI 代理。四件事分开传:
 *                                                       seat = 座位号,persona = 性格/打法,
 *                                                       agentCfg = 「这个座位用哪家模型/Key」,
 *                                                       hooks = 宿主提供的回调(2a 为空对象)。
 * @property {(root:HTMLElement, ctx:object)=>object|Promise<object>} mount
 *                                                      把本游戏的画面挂到 root 上。
 *                                                       ctx 由宿主组装(回调),游戏不许自己去
 *                                                       document 里找容器 —— 那样测试和浏览器版
 *                                                       各挂到不同地方。
 *                                                       返回值 = 「这个游戏的屏幕对象」,宿主拿它当
 *                                                       **通用界面句柄**(toast / setHint / updateSeats /
 *                                                       pushLog / showBanner / seatAnchors …)。
 *                                                       允许返回 Promise:扑克的 3D 模块是动态 import
 *                                                       的,否则纯 Node 的测试光读一眼注册表就要把
 *                                                       1.3MB 的 three.js 拖进来。
 * @property {()=>void} unmount                           拆掉 mount 建的东西(定时器、渲染循环、
 *                                                       事件监听)。必须可重复调用、且未 mount 时也安全。
 * @property {(snap:object)=>boolean} validateSnapshot    这份存档能不能用(不合格时**抛错**,并带一句
 *                                                       能看懂的说明)。校验规则只有游戏自己知道
 *                                                       (版本号 / settings 的取值范围 / 牌 id 的类型),
 *                                                       宿主只负责「不能用就当场丢掉」。
 *                                                       它同时是「壳不认识具体引擎类」的落实点:2b 之前
 *                                                       app.js 直接调 PokerEngine.validateSnapshot。
 * @property {()=>({fields:Array<{key:string,default:any}>})} settingsSchema
 *                                                       这个游戏的设置项(给「游戏设置」用)。
 *                                                       只交描述,不碰 DOM —— 渲染由设置面板负责。
 *
 * ⚠️ available:false 的游戏为什么要把实现字段写成 null、而不是直接省略:
 *    省略的话「没写」和「写错了字段名」长得一模一样;显式 null 是在契约里明确说
 *    「这个游戏还没有实现」。哪个游戏还差哪几项,由 pendingImplements() 报出来
 *    (它同时也是 2b 的待办清单),而 2b 接实现时也不会漏掉某个字段。
 */

/**
 * 注册顺序 = 主页上的卡片顺序。
 * 第一个是默认游戏(poker),所以它必须与 DEFAULT_GAME_ID 一致 —— 有断言盯着。
 */
const GAMES = [poker, werewolf, undercover, avalon];

/**
 * id → 模块。用 Map 而不是 `GAMES.find(...)`:
 * 主页每次渲染都会查一遍,而且以后注册表里可能挂十几个游戏 —— find 是 O(n),
 * 顺手做成 O(1),以后不用回来改。
 */
const BY_ID = new Map();
for (const game of GAMES) {
  // 重复 id 是**注册表自己**的错,必须在加载时就炸掉:
  // 静默「后一个覆盖前一个」的表现是「主页上狼人杀点进去却是扑克」,
  // 而这种错只在有人真的点了那张卡时才暴露。
  if (BY_ID.has(game.id)) {
    throw new Error(`游戏注册表里有重复的 id: ${game.id}(每个游戏只能注册一次)`);
  }
  BY_ID.set(game.id, game);
}

/** available: true 时必须存在的实现字段(见上面的 GameModule 说明) */
const IMPL_FIELDS = ['createEngine', 'createAgent', 'mount', 'unmount', 'validateSnapshot', 'settingsSchema'];
/** 所有游戏(含未开放的)都必须有的字段 */
const BASE_FIELDS = ['id', 'title', 'icon', 'desc', 'available', 'modes'];

/**
 * 检查一个游戏模块是否满足契约,返回**问题清单**(空数组 = 合格)。
 *
 * 为什么要有它:契约写在注释里只是愿望,靠人记必然漏。这个函数让
 * tools/registrytest.mjs、以及以后每次加新游戏时都有一个机械的判据;
 * 它**不在运行时抛错** —— 线上因为一个游戏少了个方法就整页白屏,代价远大于收益。
 * @param {object} game
 * @returns {string[]}
 */
export function contractProblems(game) {
  const out = [];
  if (!game || typeof game !== 'object') return ['不是一个对象'];
  for (const k of BASE_FIELDS) {
    if (game[k] === undefined) out.push(`缺少必需字段 ${k}`);
  }
  if (game.id !== undefined && (typeof game.id !== 'string' || !/^[a-z][a-z0-9]*$/.test(game.id))) {
    out.push(`id 必须是小写字母开头的字符串(收到 ${JSON.stringify(game.id)})`);
  }
  if (game.modes !== undefined && !Array.isArray(game.modes)) {
    out.push('modes 必须是数组(没有玩法就给 [])');
  }
  if (game.available) {
    for (const k of IMPL_FIELDS) {
      if (typeof game[k] !== 'function') out.push(`available 的游戏必须实现 ${k}()`);
    }
  } else {
    // 未开放的游戏:实现字段允许是 null,但不许**悄悄**填一半 ——
    // 那样最容易出现「界面按 available:false 灰着,实现其实已经能跑」的分裂状态。
    for (const k of IMPL_FIELDS) {
      if (game[k] != null && typeof game[k] !== 'function') {
        out.push(`${k} 要么是函数、要么是 null(收到 ${typeof game[k]})`);
      }
    }
  }
  return out;
}

/**
 * 按 id 取游戏模块。
 *
 * ⚠️ 认不出的 id **返回 null,不抛错**:
 *    调用方大多是界面代码(主页、设置页、以后的任务分发),一个手改过的配置
 *    (`ui.lastGame: "texas-holdem"` 这种拼写)不该让整个应用起不来。
 *    需要「一定拿到一个能用的游戏」的地方,用 resolveGameId()。
 * @param {string} id
 * @returns {object|null}
 */
export function getGame(id) {
  if (typeof id !== 'string' || !id) return null;
  return BY_ID.get(id) || null;
}

/**
 * 这个游戏还差哪些实现(空数组 = 实现齐了)。
 *
 * 与 contractProblems 的分工:
 *   · pendingImplements = 「**还没轮到**」(预留游戏本来就该差这几项,不算错);
 *   · contractProblems  = 「**写错了**」(类型不对、id 不合法、available:true 却没实现)。
 * 混成一个函数的话,预留游戏永远有一堆「错误」,红线会变成噪音,没人再看。
 * @param {object} game
 * @returns {string[]} 例如 ['createEngine', 'mount']
 */
export function pendingImplements(game) {
  if (!game || typeof game !== 'object') return IMPL_FIELDS.slice();
  return IMPL_FIELDS.filter((k) => typeof game[k] !== 'function');
}

/**
 * 所有游戏(按注册顺序 = 主页的卡片顺序)。
 *
 * 返回的是**数组的拷贝**:调用方 sort / splice 一下不该把注册表本身搅乱
 * (主页以外的地方也会调它,谁在什么时候改一下都很难查)。
 */
export function listGames() {
  return GAMES.slice();
}

/**
 * 把「可能是任意值的游戏 id」收敛成一个**一定能用**的 id。
 *
 * 规则:认识的、并且 available 的 → 原样返回;其余一律回落 DEFAULT_GAME_ID。
 *   · 认识的但没开放(比如配置里留着 werewolf,而它还是敬请期待)→ 回落:
 *     否则 app 会拿着一个没有引擎的游戏去开局,表现是开局按钮点了没反应;
 *   · 不认识 → 同样回落,理由见 getGame 的注释。
 * ⚠️ 回落到 DEFAULT_GAME_ID 的前提是**默认游戏一定可用**(poker 恒可玩);
 *    以后要是连默认游戏都可能被关掉,这里必须改成抛错或给一个空的「占位游戏」。
 * @param {unknown} id
 * @returns {string}
 */
export function resolveGameId(id) {
  const game = getGame(typeof id === 'string' ? id : '');
  return (game && game.available) ? game.id : DEFAULT_GAME_ID;
}

/**
 * 一期就定下来的默认游戏 —— **转发**,不是第二份定义。
 * 配置默认值的真源在 src/shared/gameDefaults.mjs(桌面版 config.cjs 与网页版
 * pokerApi.js 都同步求值它),这里 re-export 让「游戏」相关的代码只 import 一处。
 */
export { DEFAULT_GAME_ID };
