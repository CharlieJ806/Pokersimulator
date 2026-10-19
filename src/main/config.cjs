'use strict';
/**
 * 配置读写 + IPC 注册。
 * 单独抽出来是为了让主进程(main.js)和端到端测试(tools/smoke.mjs)共用同一套逻辑,
 * 测试里跑的就是真实代码,而不是复制品。
 */

const { ipcMain, shell, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const { providerList, getProvider } = require('../shared/providers.cjs');
const { buildRequest, consumeSseBuffer } = require('../shared/llmStream.cjs');
// 游戏默认值的**唯一真源**是 src/shared/gameDefaults.mjs(网页版也 import 它)。
// 这里走同步桥接(理由见 gameDefaults.cjs 的头注释:read() 是同步的)。
const {
  DEFAULT_GAME_ID, gameDefaultsAll,
} = require('../shared/gameDefaults.cjs');
const { makeGameStore } = require('./gameStore.cjs');
// 全局排行榜的持久化(独立文件 leaderboard.json)—— 与 config / 对局快照都分开,
// 理由见 leaderboardStore.cjs 的文件头:配置是「用户怎么设置」,排行榜是「玩出了什么」。
const { makeLeaderboardStore } = require('./leaderboardStore.cjs');

const DEFAULT_CONFIG = {
  /**
   * ── 全局设置:API / 模型 / 代理行为,对所有游戏生效 ─────────────────
   *
   * 为什么要把这一层单独拎出来:项目要从「德州扑克」扩成多游戏平台(之后接
   * 狼人杀、谁是卧底)。Key、厂商、逐座位的模型分配是**跨游戏复用**的 ——
   * 换个游戏不该让用户把 Key 再填一遍。二期接游戏注册表时,这一层原样交给
   * 每个 GameModule 用,不需要再挪。
   *
   * ⚠️ 这一层以前是**平铺在配置顶层**的(keys / defaultProvider / model /
   *    seatModels …)。老配置靠 makeStore().read() 里的 migrateLegacyConfig()
   *    搬进来 —— 所以谁要读配置都必须走 store.read(),自己 JSON.parse
   *    settings.json 拿到的还是旧形状(而且看不到默认值)。
   */
  global: {
    // 默认厂商(新版:多厂商 + 按座位分配;旧的 endpoint/apiKey 字段仍然兼容)
    defaultProvider: 'deepseek',
    keys: {},                 // { deepseek: 'sk-...', openrouter: 'sk-or-...' }
    seatProviders: {},        // { '0': 'deepseek', '1': 'groq' } 不填则跟随默认
    seatModels: {},           // { '0': 'deepseek-chat', '2': 'llama-3.1-8b-instant' }
    // 逐座位的性格(决定打法)。留空 = 随机分配。
    // 与座位显示名无关 —— 名字跟着模型走(相同模型自动加序号)。
    seatPersonas: {},         // { '0': 'nit', '1': 'maniac' }
    // ── 自定义中转站(OpenAI 兼容)─────────────────────────────
    // 中转站的特点:**一个地址 + 多个 Key**,每个 Key 能调的模型不一定相同。
    customEndpoint: '',       // 地址,填到 /v1 为止或完整路径都行(按协议自动补尾巴)
    // protocol:'openai' | 'anthropic' | 'responses' | 'gemini' —— **协议跟着令牌分组走**,
    // 所以必须逐 Key 配置,不能全局一个。PackyAPI 的模型卡片上有协议标签:
    // ANTHROPIC / OPENAI-RESPONSE / OPENAI / GOOGLE(Gemini 原生格式),
    // 见 shared/llmStream.mjs 的 RELAY_PROTOCOLS。
    // gemini 那条地址填到域名或 /v1 都行,路径由 geminiUrl() 自己拼。
    customKeys: [],           // [{ id: 'k1', label: 'Key 1', key: 'sk-...', protocol: 'openai' }]
    seatCustomKeys: {},       // { '0': 'k1' } 座位用哪个 Key;不填 = 第一个
    /**
     * 下面三格是「单厂商」时代留下的兼容字段,**仍然有读者**(hasAnyKey /
     * app.js 的 agentCfg / 模型面板的 apiKey→keys 迁移),所以迁移时必须
     * 一起从顶层搬进来:只搬 keys / defaultProvider 而漏掉 apiKey,等于把老用户
     * 唯一的 Key 抹掉(老配置里 Key 常常只存在 apiKey 这一格,keys 是空的)。
     */
    endpoint: 'https://api.deepseek.com/chat/completions',
    apiKey: '',
    model: 'deepseek-flash',     // 与 providers.mjs 里 deepseek 的 defaultModel 一致
    temperature: 1.1,
    // 推理型模型(deepseek-flash / deepseek-v4-pro / qwen3-thinking 等)会先输出
    // 一大段 reasoning_content 再给正式回答,两者共用同一个 max_tokens 预算。
    // 实测 deepseek-flash:max_tokens=300 时推理就吃了 940 字,正式回答被挤掉
    // (finish_reason=length),决策只能从残缺文本硬猜;600 以上才够。
    // 所以默认给足,不然「思考」会挤掉「决策」。
    // 提到 2000:推理已压到最低档(reasoningLevel:'low' —— openai 协议发
    // reasoning_effort:'low'、Gemini 发 thinkingBudget:512),额度基本都留给正文,
    // 再留足冗余,避免「没有可识别的动作」那种截断。
    maxTokens: 2000,
    // 推理档位(四家协议统一,字段映射见 shared/llmStream.mjs 的 REASONING_LEVELS):
    //   'off'     完全关闭(Gemini thinkingBudget:0 / 不给 Anthropic thinking / 发 thinking:disabled)
    //   'low'     **默认**:保留推理但压到各家允许的最低档
    //   'default' 什么都不发,走厂商默认
    //
    // ⚠️ 默认**不能**改成 'default'(什么都不发) —— 这是实测结论,曾经改过又回滚:
    //    在**游戏实际使用的 deepseek-flash** 上,同一个牌局问题:
    //      · 'low'                     → reasoning  686 字 / 211 token / 2.0s
    //      · 'default'(什么都不发)      → reasoning 3769 字 / 1156 token / 8.0s  ← 最差
    //      · 'off'(thinking:disabled)  → reasoning    0 字 /   69 token / 1.0s  ← 最快
    //    flash 这类模型**默认是重度思考的**,不传参数等于放任它长考(8 秒 + 5.5 倍 token),
    //    而 'low' 是真的把它压下来了。那 3769 字草稿还和正式回答共用 max_tokens,
    //    正是「模型没有给出可识别的动作」那类截断的来源之一。
    //    想要极致速度可以选 'off',但它会把真的需要推理的模型也按死,所以不做默认。
    //    (别拿 deepseek-chat 的测量来推断 flash:chat 默认不思考,二者默认行为正交。)
    reasoningLevel: 'low',
    // 单次模型调用的超时。45s:一张桌子是**轮流**调用模型的,一个人卡 90 秒,
    // 整桌就停等一分半 —— 实测那比「偶尔退回本地策略」难忍得多。
    // 推理已经压到最低档之后,45s 足够推理型模型想完(实测 low 档推理均长几百字)。
    // ⚠️ 这个值以前是**死字段**:app.js 的 agentCfg 从来没把它传给 agent,
    //    调用层一直只用它自己的 45s 缺省。现已接通。
    timeoutMs: 45000,
    /**
     * 模型调用的重试(临时性失败:超时 / 网络 / 5xx / 无可用渠道 / 过载 / 限流)。
     *
     * 为什么要:上游抖动是**一过性**的 —— 报一次「无可用渠道」「overloaded」,
     * 隔几秒同一条请求就能成。以前一失败就立刻退回本地策略,用户看到的是
     * 「某个模型偶发超时 → 那一手突然变成本地策略在打」,而它下一手又好了。
     *
     * ⚠️ budgetMs 是**一次决策的累计上限**,不是单次调用的超时:
     *    没有它的话「timeoutMs(45s)× 3 次重试 = 135s」,一张桌子是轮流调模型的,
     *    一个人卡 135 秒全桌一起等 —— 那比偶尔退回本地策略难忍得多。
     *    90s = 首次跑满 45s + 一次重试;快速失败(503 通常 1s 内返回)时四次都能试上。
     *    到点立刻兜底,绝不会让一张桌子停等两分钟。
     *
     * ⚠️ 想「任何失败都重试 3 次」(不区分错误类型)就把 classifyErrors 改成 false。
     *    默认 true 时,401/403、协议不对、模型名错、余额不足直接兜底 ——
     *    那几种重试必然同样失败,只会白等 5 秒退避再兜底。
     *
     * 改这里就够:agent.js 的 resolveRetryPolicy 会把它并到默认策略上
     * (单个字段缺省/非法都退回内置默认,不会因为一次手误把重试关掉或开成无限)。
     */
    llmRetry: {
      times: 3,                      // 失败后再试几次(一共最多 1 + 3 次请求)
      backoffMs: [600, 1500, 3000],  // 每次重试前的等待;短退避,不重头等满一个超时
      budgetMs: 90000,               // 一次决策的累计耗时上限
      classifyErrors: true,          // false = 不看错误类型,失败就重试
    },
    /**
     * ── 全局排行榜的权重(平台级,跨游戏)──────────────────────────
     *
     * 一场游戏结束 → 按本场最终排名折算成全局分 → 写进持久化排行榜。
     * 公式(实现与逐项理由在 src/shared/leaderboard.mjs 的文件头):
     *
     *   名次分 = 参战人数 - 名次          (第 1 名 = N-1,末名 = 0)
     *   权重 W = 游戏系数 × 回合系数 × 人数系数
     *   全局分 = round(名次分 × W)
     *
     *   · 游戏系数:狼人杀/阿瓦隆 1.2(推理+欺骗,决策链最长),
     *     卧底 1.0(轮次短、随机词对影响大),扑克 1.0(牌技硬,但发牌运气占比高)。
     *   · 回合系数 = 1 + 0.05×(回合数-1),上限 1.5 —— 连打多局更能证明「稳定靠前」,
     *     但设上限防「开一局 99 回合刷分」。
     *   · 人数系数 = 1 + 0.05×(人数-4),上限 1.5 —— 人越多冠军含金量越高;
     *     4 人是基准,2 人局冠军只值 0.9 倍(这是有意的,不是漏了夹下限)。
     *
     * ⚠️ 为什么放在 global(而不是 games.<id> 或配置顶层):
     *    · 系数要**横向比较**(狼人杀 vs 扑克),必须能在一个地方一起读写;
     *      放进每个游戏自己的设置,调一次权重就要改三处、还容易只改一端。
     *    · 它是**用户设置**(可保存、可手改),所以可以进配置;
     *      而**排行榜数据本身绝不进配置** —— 那份是运行数据,写 leaderboard.json。
     *
     * ⚠️ 这里的数值必须与 src/shared/leaderboard.mjs 的 LEADERBOARD_DEFAULTS
     *    以及 web/pokerApi.js 的同名块**逐字段一致**(configmigrate 盯着两端 deepEqual,
     *    不一致会让「网页版夺冠 +3、桌面版 +4」这种差异没人查得出来)。
     */
    leaderboard: {
      enabled: true,
      // gameId → 游戏系数。认不出的游戏用 defaultGameWeight。
      gameWeights: { poker: 1.0, undercover: 1.0, werewolf: 1.2, avalon: 1.2 },
      defaultGameWeight: 1.0,
      // 回合系数:1 + step×(回合数-1),上限 max。(回合数 = 扑克的手数 / 其它游戏的局数)
      rounds: { step: 0.05, max: 1.5 },
      // 人数系数:1 + step×(人数-base),上限 max。
      seats: { step: 0.05, base: 4, max: 1.5 },
      // 榜上最多保留多少行(按总分截断尾部;不会删正在榜上的人)。
      maxRows: 200,
    },
  },
  /**
   * ── 游戏设置:只对某一个游戏生效 ─────────────────────────────────
   * `games` 是**按 gameId 索引的字典**(不是 games.poker 这种写死的字段)。
   * 加一个游戏 = 在 src/shared/gameDefaults.mjs 的 GAME_DEFAULTS 里加一个 key,
   * 别的地方一行都不用动 —— 默认值由那一份声明提供,这里只负责合进来。
   *
   * ⚠️ 这里以前叫 `game`(单数、在顶层)。所有读者(cfg.game.xxx)都改成了
   *    `gameCfg(cfg)`(默认取 DEFAULT_GAME_ID,一期就是 poker)。
   *    迁移规则见 migrateLegacyConfig():game.* 整组搬进 games[当前游戏].*,
   *    搬完把顶层 game 删掉(否则它会作为一个旧键永远留在配置文件里,
   *    而两个位置各有一份值时,谁也不知道该信哪一个)。
   */
  games: gameDefaultsAll(),
  /**
   * ── 界面 / 节奏 ───────────────────────────────────────────────
   * ⚠️ 这一层**这次刻意不动**:flowMode / thinkDelayMs / notesEvery /
   *    rememberPlayers 既像全局偏好又像某个游戏的设置(狼人杀要不要「行动前停顿」?
   *    谁是卧底的「AI 记性」周期和扑克一样吗?),归属要单独判断。
   *    混在「配置分层」这一期里改会放大风险,所以先保持 ui 独立,二期再议。
   */
  ui: {
    thinkDelayMs: 900,
    autoNextHand: false,
    // ⚠️ 这里原来有 showThinking: true(顶栏「💭 气泡」按钮 + 设置里「显示思考气泡」)。
    //    两个入口都删了:它控制的只是「气泡里显不显示思考文字」,而那个行为现在固定为开
    //    (见 src/ui/app.js 的 takeTurn)。留着这个键会变成死字段 ——
    //    键在配置里、没人读,排查时以为它还在起作用。
    deckView: 'down',        // down = 全部盖着(默认) | board = 只看公共牌 | up = 全翻开(荷官特权)
  },
};

/**
 * 旧配置里**曾经平铺在顶层**的全局字段 —— 迁移白名单。
 *
 * 只搬这些,不是「把顶层所有键都塞进 global」:顶层还有 ui(这一期不动)、
 * 还有网页版独有的 workerUrl,以及调用方注入的运行时字段(configPath /
 * hasKey / providerList)。一把抓会把它们一起搬进 global,越搬越乱。
 *
 * 名单要和 web/pokerApi.js 的 LEGACY_GLOBAL_FIELDS **逐字一致** ——
 * 两端迁移规则不一致的话,同一份配置在桌面版和网页版搬出来就是两套值。
 */
const LEGACY_GLOBAL_FIELDS = [
  'defaultProvider', 'keys', 'seatProviders', 'seatModels', 'seatPersonas',
  'customEndpoint', 'customKeys', 'seatCustomKeys',
  // 单厂商时代的兼容字段(仍有读者,见 DEFAULT_CONFIG.global 里的说明)
  'endpoint', 'apiKey', 'model', 'temperature', 'maxTokens',
  'reasoningLevel', 'timeoutMs', 'llmRetry',
];

/** 只认真正的「纯对象」,数组和 null 都不算 */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 旧扁平配置 → 新分层配置(global / games[gameId])。
 *
 * 为什么要单独一个函数而不是在 stripLegacyKeys 里顺手做:
 *   · 这是**值搬家**,删键只是搬家的结果;两者混在一起,以后想加一个「只删不值」
 *     的清理键会没地方放(stripLegacyKeys 的语义是「只删键、不迁移数值」)。
 *
 * ⚠️⚠️ 调用顺序:**必须在 deepMerge(DEFAULT_CONFIG, raw) 之前**跑。
 *    合并之后 global / games 已经被默认值填满,「新位置没有这个键才搬」
 *    的判据会永远为假 —— 旧值一个都搬不过去,而且**不会报错**,只会静默丢配置:
 *    用户打开设置,Key 和牌局规则全是「默认值」,看起来像是配置被重置了。
 *
 * 幂等:已经在新位置的值**优先**(旧键只补空缺),所以连读两次结果相同 ——
 * 不能每次读都拿旧值把用户在新面板里改过的值盖回去。
 *
 * @param {object} cfg 从磁盘(或 localStorage)读出来的原始对象
 * @param {string} [gameId] 旧的 game.* 搬到 games 的哪个游戏下。
 *   默认 DEFAULT_GAME_ID(一期 = poker;二期主页有游戏选择后,这里会传
 *   「用户上次玩的游戏」)。**不在这里写死 'poker'**,就是为了那一步不用改迁移。
 * @returns {object} 新形状的对象(不改入参)
 */
function migrateLegacyConfig(cfg, gameId = DEFAULT_GAME_ID) {
  if (!isPlainObject(cfg)) return cfg;

  const legacyGlobal = LEGACY_GLOBAL_FIELDS.filter((k) => cfg[k] !== undefined);
  // 顶层只要有 `game` 这个键就当旧形状处理,不管它是不是对象 ——
  // 新结构里没有 game 这个位置,junk 也一并清掉(留着会让下次迁移再判一次)
  const hasLegacyGame = Object.prototype.hasOwnProperty.call(cfg, 'game');
  if (!legacyGlobal.length && !hasLegacyGame) return cfg;

  const out = { ...cfg };

  if (legacyGlobal.length) {
    const g = { ...(isPlainObject(cfg.global) ? cfg.global : {}) };
    for (const k of legacyGlobal) {
      // 新位置已经有值 → 保留新的(这就是「幂等 + 新格式优先」的那条规矩)
      if (g[k] === undefined) g[k] = cfg[k];
      delete out[k];
    }
    out.global = g;
  }

  if (hasLegacyGame) {
    const games = { ...(isPlainObject(out.games) ? out.games : {}) };
    const cur = { ...(isPlainObject(games[gameId]) ? games[gameId] : {}) };
    if (isPlainObject(cfg.game)) {
      for (const [k, v] of Object.entries(cfg.game)) {
        // ★ blindLevelOrbits 是**已废弃**的旧键(单位错的那版「每 N 个人回合升一档」)。
        //   这里只删不迁:旧值是在「回合」这个错单位下填的,乘人数会造出一个用户
        //   从没打算要的数字(他填 3 想的是 3 手,×6 变 18 手,还是「设了没反应」)。
        //   完整理由见 stripLegacyKeys 的头注释。
        if (k === 'blindLevelOrbits') continue;
        // 同理:新位置(已经存在的 games[gameId])优先,旧键只补空缺
        if (cur[k] === undefined) cur[k] = v;
      }
    }
    games[gameId] = cur;
    out.games = games;
    delete out.game;
  }

  return out;
}

/** 至少配了一个可用的 Key(含自定义中转站的 customKeys) */
function hasAnyKey(cfg) {
  // 容错:允许被「旧形状」调用(cfg 本身就是 global 那一层)。日志/排查脚本里
  // 常有人把 store.read().global 直接传进来,判断不该因此变成 false。
  const g = isPlainObject(cfg?.global) ? cfg.global : (cfg || {});
  if (g.apiKey) return true;
  if (Object.values(g.keys || {}).some((k) => k && String(k).trim())) return true;
  return !!g.customEndpoint && (g.customKeys || []).some((k) => k?.key && String(k.key).trim());
}

/**
 * 深合并配置补丁。
 *
 * `null` 表示**删除这个键** —— 这是必要的:像 seatPersonas 这种「按座位覆盖」
 * 的字典,用户把某个座位改回「随机」时得能把那一条删掉。如果只是合并,
 * 空对象不会删任何东西,那一条会一直留着,用户就再也回不到随机了。
 */
function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) { delete out[k]; continue; }          // null = 显式删除
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** 正在进行的 LLM 请求(用于取消) */
const llmAborts = new Map();

/**
 * 清掉已废弃的配置键 —— 现在只剩 ui.showThinking。
 *
 * 历史上有两个,处理方式不同,别混淆:
 *
 * · game.blindLevelOrbits(已废弃的「每 N 个人回合升一档」)。
 *   旧值是在「回合」这个错单位下填的,乘人数看似"保留原手感",实际会造出一个
 *   用户从没打算要的数字(他填 3 想的是 3 手,×6 变 18 手,对他来说还是
 *   「设了没反应」,只是换了个样子),所以**只删键、不迁移数值**。
 *   现在这件事由 migrateLegacyConfig() 做:它把整个旧 `game` 组搬进
 *   games[当前游戏] 时跳过这个键,并把旧的 `game` 键本身删掉 —— 旧位置没了,
 *   旧键自然也不会留下。这里再兜一道(防手改过的配置文件把旧键写进
 *   games[*]),删法一样。
 *
 * · ui.showThinking(气泡里显不显示思考文字)。顶栏的「💭 气泡」按钮和设置里的
 *   「显示思考气泡」都删了,行为固定为显示,所以配置里这份值已经没有任何读者。
 *   删掉它,老配置里存着的 false 也一并消失 —— 否则「配置里明明写着 false、
 *   气泡却照样显示文字」会被当成 bug 查半天。
 *
 * (顺带一提:留着一个没人读的键就是这个仓库反复踩的「死字段」坑 ——
 *  键在配置里、没人读,排查时以为它还在起作用。)
 */
function stripLegacyKeys(cfg) {
  if (!cfg) return cfg;
  const games = cfg?.games;
  // 每个游戏都扫一遍(不写死 games.poker):blindLevelOrbits 是扑克的旧键,
  // 但清理逻辑没必要知道这件事,以后加的游戏也不会被这道清理误伤别的键。
  const gamesWithOrbits = isPlainObject(games)
    ? Object.keys(games).filter((id) => games[id]?.blindLevelOrbits !== undefined)
    : [];
  const hasThinking = cfg?.ui?.showThinking !== undefined;
  if (!gamesWithOrbits.length && !hasThinking) return cfg;
  // 复制一层再删:deepMerge 在「补丁里没有 games / ui 这一支」时会直接把 DEFAULT_CONFIG
  // 里那一支的引用交出来,原地 delete 会动到默认配置(下次读就少一个键)。
  const out = { ...cfg };
  if (gamesWithOrbits.length) {
    out.games = { ...games };
    for (const id of gamesWithOrbits) {
      out.games[id] = { ...games[id] };
      delete out.games[id].blindLevelOrbits;
    }
  }
  if (hasThinking) { out.ui = { ...cfg.ui }; delete out.ui.showThinking; }
  return out;
}

function makeStore(configPath) {
  function read() {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      // ⚠️ 顺序:先迁移(旧扁平 → global/games.poker),再合默认值。
      //    反过来的话新位置已经被默认值填满,迁移一个值都搬不过去(见 migrateLegacyConfig)。
      return stripLegacyKeys(deepMerge(DEFAULT_CONFIG, migrateLegacyConfig(raw)));
    } catch {
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  }
  function write(cfg) {
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
      return { ok: true, path: configPath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  return { read, write, configPath, defaults: DEFAULT_CONFIG };
}

/** 注册所有 IPC 处理器(重复调用安全) */
function registerIpc(configPath) {
  const store = makeStore(configPath);
  // 对局快照走**独立的文件**(game.json),与配置分开 —— 理由见 gameStore.cjs 的文件头。
  const games = makeGameStore(configPath);
  // 全局排行榜也走**独立的文件**(leaderboard.json):它是长期运行数据,
  // 不能被「重置配置」或「放弃上一局」顺手清掉。理由见 leaderboardStore.cjs。
  const leaderboards = makeLeaderboardStore(configPath);
  const handle = (channel, fn) => {
    try { ipcMain.removeHandler(channel); } catch { /* 没注册过就忽略 */ }
    ipcMain.handle(channel, fn);
  };
  /**
   * 同步 IPC(sendSync)。
   *
   * ⚠️ 为什么需要同步这一套:页面即将被系统回收时(visibilitychange→hidden / pagehide)
   *    之后的异步回调**不保证还会执行**,`ipcRenderer.invoke` 可能永远不落地;
   *    而 web/main.js 正是在那两个钩子上做「最后强存」。sendSync 会阻塞渲染进程,
   *    所以只服务这一种场景 —— 常规保存走下面的异步通道。
   * ⚠️ `event.returnValue` **必须**被赋值:漏了的话渲染进程会一直阻塞等回复,
   *    表现就是「一切到后台整个页面卡死」。
   */
  const handleSync = (channel, fn) => {
    try { ipcMain.removeAllListeners(channel); } catch { /* 没注册过就忽略 */ }
    ipcMain.on(channel, (event, arg) => {
      try { event.returnValue = fn(arg); } catch (err) { event.returnValue = { ok: false, error: err?.message || String(err) }; }
    });
  };

  handle('config:get', () => {
    const cfg = store.read();
    return {
      ...cfg,
      configPath,
      hasKey: hasAnyKey(cfg),
      providerList: providerList(),
    };
  });

  handle('config:set', (_e, patch) => {
    const cfg = deepMerge(store.read(), patch || {});
    const res = store.write(cfg);
    return { ...res, config: cfg, hasKey: hasAnyKey(cfg) };
  });

  handle('config:clearKey', () => {
    const cfg = store.read();
    // ⚠️ 逐厂商的 keys 也要清。以前这里只清 apiKey(单厂商时代的遗留字段),
    //    而网页版一直把 keys 一起清 —— 于是「清掉 Key」在两端效果不同:
    //    桌面版清完还留着 keys.deepseek,hasAnyKey 仍为真,界面上「已保存」的
    //    提示也还在。两端的同名操作必须同义。
    const res = store.write({ ...cfg, global: { ...cfg.global, apiKey: '', keys: {} } });
    return res;
  });

  /* ---------------------------------------------------------- 对局快照
   *
   * 与网页版 web/pokerApi.js 的 localStorage 分支**逐条对齐**:
   *   读 → 读不到/坏了返回 null(调用方据此认为「没有存档」);
   *   写 → 永远返回 { ok, error? },绝不抛(存档失败不能崩掉牌局);
   *   清 → 删不掉也算成功语义之外的失败,返回 { ok:false, error }。
   * 两端的共同逻辑(节流、版本丢弃)在 src/shared/gameStore.js,只有一份实现。
   * 桌面版落在同目录的 game.json,网页版落在 localStorage 的 poker-dealer/game/v1。
   */
  handle('game:get', () => games.read());
  handle('game:set', (_e, snap) => games.write(snap));
  handle('game:clear', () => games.clear());
  // 同步版本:只给「即将被回收」的强存用(见上面 handleSync 的说明)。
  // 通道名与异步版本分开是**故意的**:ipcMain.on 与 ipcMain.handle 是两套注册表,
  // 同名会互相盖不到,而调用方(preload)也需要明确知道哪条路是同步的。
  handleSync('game:getSync', () => games.read());
  handleSync('game:setSync', (snap) => games.write(snap));
  handleSync('game:clearSync', () => games.clear());

  /* ---------------------------------------------------------- 全局排行榜
   *
   * 与网页版(localStorage 的 poker-dealer/leaderboard/v1)**逐条对齐**:
   *   读 → 读不到/坏了返回 null(上层当空榜);
   *   写 → 永远返回 { ok, error? },绝不抛(写榜失败不能把刚打完的界面搞崩);
   *   清 → 删不掉时如实返回失败。
   * 版本校验**不在这里做**:两端共同的逻辑(版本号 / 排序 / 权重换算)只有一份,
   * 在 src/shared/leaderboard.mjs。
   *
   * ⚠️ 这里**不需要**同步版本(sendSync):写榜发生在「一场结束」那一刻,
   *    界面还活着,异步 invoke 一定能落地;而 sendSync 会阻塞渲染进程。
   *    (对局快照需要同步版,是因为它要在页面被回收前写 —— 排行榜没有那个场景。)
   */
  handle('leaderboard:get', () => leaderboards.read());
  handle('leaderboard:set', (_e, board) => leaderboards.write(board));
  handle('leaderboard:clear', () => leaderboards.clear());

  handle('app:info', () => ({
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    configPath,
  }));

  handle('shell:openConfigFolder', () => {
    try { shell.showItemInFolder(configPath); return true; } catch { return false; }
  });

  /**
   * LLM 流式代理。
   * 放在主进程做的两个原因:
   *   1. 绕开渲染进程的 CORS 限制(各家 API 的 CORS 策略不一致);
   *   2. API Key 不必暴露在页面上下文里。
   * 返回 { ok, status, error, text }；增量通过 llm:chunk 推给渲染进程。
   */
  handle('llm:chat', async (event, spec) => {
    const sender = event.sender;
    const provider = getProvider(spec.provider || 'deepseek');
    // 请求构造与流式解析都走共享模块(与浏览器版、Cloudflare Worker 同一份实现)。
    // 注意:主进程是 CJS,共享模块是 ESM,中间经 llmStream.cjs 用 import() 桥接,
    // 所以这两个函数是异步的 —— 必须 await。
    const built = await buildRequest(spec, provider);
    if (built.error) return { ok: false, status: 0, error: built.error };
    const { url, headers, body, kind } = built;

    const controller = new AbortController();
    if (spec.requestId) llmAborts.set(spec.requestId, controller);
    const timer = setTimeout(() => controller.abort(), spec.timeoutMs || 45000);

    let chunkCount = 0;
    // 流里报出来的错误(共享解析器在 finish 事件上带出来的 error 字段)。
    // ⚠️ 以前这里**直接忽略**了 finish 通道,于是「HTTP 200 + 流里 response.failed」
    //    被当成一次成功、text 为空 —— 调用方只能看到「模型没给出可识别动作」这种
    //    误导性的结论,真正的死因(上游渠道不可用 / 额度不足)一个字都没露出来。
    //    连通性测试按钮的全部价值就是把这种话原样交给用户,所以必须接住。
    let streamError = '';
    // 累积到这里的正文,一并回推给渲染层方便它显示「已收到的完整文本」
    let fullForEmit = '';
    const emit = (delta, thinking = false) => {
      if (!delta) return;
      chunkCount += 1;
      if (!thinking) fullForEmit += delta;
      try {
        if (!sender.isDestroyed()) {
          sender.send('llm:chunk', {
            requestId: spec.requestId, delta, thinking, full: fullForEmit,
          });
        }
      } catch { /* 窗口关了就算了 */ }
    };

    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: `接口返回 ${res.status}: ${text.slice(0, 200)}`, chunks: chunkCount };
      }
      if (!res.body) return { ok: false, status: res.status, error: '接口没有返回流式内容' };

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let full = '';
      let reasoning = '';
      // 推理阶段 → 正式回答的切换只通知一次
      let answerStarted = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = await consumeSseBuffer(buffer, kind, (c) => {
          if (c.error) { streamError = String(c.error); return; }
          if (c.phase === 'reasoning') {
            reasoning += c.reasoning;
            // 推理增量也要推给界面 —— 否则整个思考阶段是空白的
            // (deepseek-flash 先流 137 字推理再流 23 字回答,只推 content 就什么都看不到)
            emit(c.reasoning, true);
            return;
          }
          if (c.phase === 'answer') {
            if (!answerStarted) {
              answerStarted = true;
              try {
                if (!sender.isDestroyed()) sender.send('llm:chunk', { requestId: spec.requestId, reset: true });
              } catch { /* 忽略 */ }
            }
            full += c.text;
            emit(c.text);
          }
        });
      }
      // 流里报错要当失败(原文带上),不能返回一个「成功的空文本」
      if (streamError) return { ok: false, status: 200, error: `上游流里报错:${streamError}`, chunks: chunkCount };
      return { ok: true, status: 200, text: full || reasoning, reasoning, chunks: chunkCount };
    } catch (err) {
      const aborted = err?.name === 'AbortError';
      return { ok: false, status: 0, error: aborted ? '请求超时或被取消' : (err?.message || String(err)), chunks: chunkCount };
    } finally {
      clearTimeout(timer);
      if (spec.requestId) llmAborts.delete(spec.requestId);
    }
  });

  handle('llm:abort', (_e, requestId) => {
    const c = llmAborts.get(requestId);
    if (c) { c.abort(); llmAborts.delete(requestId); return true; }
    return false;
  });

  /** 让渲染进程确认主进程还活着(排障用) */
  handle('llm:ping', () => ({ ok: true, providers: providerList().length }));

  return store;
}

module.exports = {
  registerIpc, makeStore, deepMerge, DEFAULT_CONFIG,
  migrateLegacyConfig, stripLegacyKeys, hasAnyKey, LEGACY_GLOBAL_FIELDS,
  DEFAULT_GAME_ID,
};
// 对局快照的存储单独导出:它的行为要与网页版(pokerApi.js 的 localStorage 分支)对齐,
// tools/snapshotest.mjs 直接 require 这个文件就能在**纯 Node**里测桌面版的路径
// (它不依赖 electron,所以不需要开 Electron 窗口)。
module.exports.makeGameStore = makeGameStore;
// 排行榜的桌面存储也单独导出:tools/leaderboardtest.mjs 要在**纯 Node**里
// 验证「写 → 重读 → 数据一致」,不必为了一个文件读写开 Electron。
module.exports.makeLeaderboardStore = makeLeaderboardStore;
