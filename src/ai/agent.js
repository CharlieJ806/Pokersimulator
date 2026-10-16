'use strict';
/**
 * AI 玩家代理层。
 *
 * 设计要点(对应「AI 必须相互独立、不能拥有对方信息」):
 *  1. 每个座位一个 Agent 实例,只持有自己的 callbacks 与历史,互不共享。
 *  2. 发给模型的提示词由 viewForSeat(seat) 生成 —— 那里只有自己的底牌与公开信息。
 *  3. 模型输出要求带一句「思考」,界面上逐字显示,这就是玩家看到的思考过程。
 *  4. 模型超时/报错/输出非法 → 用本地规则兜底,牌局永远不会卡住。
 */

import { cardText, rankOf, suitOf, RANK_LABEL } from '../core/cards.js';
import { evaluate, describe, categoryKey } from '../core/handEval.js';
import { riskLabel } from './personas.js';

/**
 * 厂商表的懒加载缓存。
 *
 * 为什么需要它:callLLMDirect 是**手工拼请求体**的(不像桌面/网页那条路走
 * buildRequest),所以厂商级默认参数得自己去查一次。不查的话,同一次决策
 * 在 Node 环境(测试、命令行工具、离线兜底)会漏掉 reasoning_effort,
 * 而线上带着 —— 正是「测试通过、线上截断」那类最难查的偏差。
 */
let sharedProvidersMod = null;
let sharedStreamMod = null;

/**
 * 厂商 id。
 * ⚠️ app.js 传进来的 cfg.provider 是**整个厂商对象**(界面要用它的 name),
 *    而 getProvider() 只认字符串 id —— 把对象直接传下去会查不到、静默退回 deepseek:
 *    结果 OpenAI / Claude / Gemini 的请求体里都被塞进 deepseek 的 reasoning_effort,
 *    本地模型(不需要 Key)也会被当成「缺 Key」拒掉。所以统一从这里取 id。
 */
function providerIdOf(cfg) {
  if (cfg?.providerId) return cfg.providerId;
  if (typeof cfg?.provider === 'string') return cfg.provider;
  return cfg?.provider?.id || 'deepseek';
}

const ACTION_LABEL = { fold: '弃牌', check: '看牌', call: '跟注', raise: '加注', allin: '全下' };

/** 手上的牌力粗评(仅用于本地兜底,不参与提示词里的判断) */
function preflopStrength(hole) {
  const [a, b] = hole.map((c) => ((c >> 2) + 2));
  const suited = (hole[0] & 3) === (hole[1] & 3);
  const hi = Math.max(a, b), lo = Math.min(a, b);
  const gap = hi - lo;

  // 1) 先按「两张牌的点数」定基础分
  let base;
  if (hi === 14 && lo === 14) base = 1.0;
  else if (hi === 13 && lo === 13) base = 0.95;
  else if (hi === 12 && lo === 12) base = 0.9;
  else if (hi === 11 && lo === 11) base = 0.85;
  else if (hi === 14 && lo === 13) base = 0.855;  // AK(同花加成后 ≈0.95,AA > AKs ≳ KK)
  else if (hi === 14 && lo === 12) base = 0.82;   // AQ
  else if (hi === 13 && lo === 12) base = 0.79;   // KQ
  else if (hi === 14 && lo === 11) base = 0.76;   // AJ
  else if (hi === 14 && lo >= 10) base = 0.72;    // AT
  else if (hi >= 12 && lo >= 10) base = 0.68;     // KQ/KJ/QJ/KT/QT/JT 型
  else if (lo <= 9 && lo >= 6 && gap <= 1) base = 0.52;  // 中小连张
  else if (hi === 14) base = 0.55;                // A + 小牌
  else if (hi >= 13) base = 0.45;
  else if (hi >= 11) base = 0.38;
  else base = 0.2 + Math.max(0, (hi - 7) * 0.02);

  // 2) 再叠加同花 / 连张 / 间隔的修正
  let s = base;
  if (suited) s += 0.06;
  if (gap === 1) s += 0.03;          // 连张
  if (gap === 2) s += 0.01;
  if (gap >= 5) s -= 0.06;           // 大间隔很差
  if (lo < 8 && hi < 12 && !suited && gap > 3) s -= 0.05;
  return Math.max(0.05, Math.min(1, s));
}

/**
 * 翻前(还没有公共牌)的「成牌」说法。
 *
 * 为什么不能直接用 describe():它要的是 evaluate 的 score,而 evaluate **至少
 * 需要 5 张牌**(2 张底牌 + 3 张公共牌)。翻前只有 2 张,硬套会抛异常 ——
 * 所以翻前必须单独有一条路径,而且绝不能把成败押在「模型自己看两张牌判断强弱」上。
 * 这里只复述**客观事实**(两张牌 + 同不同花)再叠一个粗分档,
 * 档位来自 preflopStrength(),与本地兜底用的是同一个函数,两处不会说法不一致。
 *
 * ⚠️ 只用底牌,不碰任何还没发出来的牌(不能用未来信息)。
 */
const PREFLOP_BANDS = [
  [0.88, '极强'],
  [0.80, '强'],
  [0.62, '中等偏强'],
  [0.46, '中等'],
  [0.33, '偏弱'],
  [0, '很弱'],
];

function preflopHandText(hole) {
  const s = preflopStrength(hole);
  const band = (PREFLOP_BANDS.find(([min]) => s >= min) || [0, '很弱'])[1];
  // 大牌写前面(A10 而不是 10A)—— 和玩家习惯的说法一致
  const [hi, lo] = hole.map(rankOf).sort((a, b) => b - a);
  const suited = suitOf(hole[0]) === suitOf(hole[1]);
  const label = hi === lo
    ? `对${RANK_LABEL[hi]}`
    : `${RANK_LABEL[hi]}${RANK_LABEL[lo]}${suited ? '同花' : '不同花'}`;
  return `${label},翻前还没成牌(${band}起手牌)`;
}

/**
 * 「你现在的成牌」—— 由引擎的确定性评估器算好,再交给模型。
 *
 * 为什么必须由我们算(而不是让模型自己数):从 5~7 张牌里凑出牌型是典型的
 * 「数牌」任务,模型经常算错。用户实测:GLM 拿 A♦10♦、公共牌 3♦Q♣10♠ + 转牌 Q,
 * 它说成「转牌 Q 让我成了 Q 带 10 的葫芦」——把 A♦ 记成了 Q;实际是
 * **两对 Q 与 10**(一对 Q 来自公共牌、一对 10 是一张底牌一张公共牌)。
 * 提示词里其实一直带着成牌名(engine 的 me.myHandNow),但它被塞在
 * 「你的底牌」那一行的括号里、又在长提示词的前段,模型照样自己重新数一遍。
 * 所以这一版:① 把它单独成行说清楚是引擎算的;② 在提示词最后再复述一次;
 * ③ 长短牌一律走 evaluate/describe —— 与本地兜底、摊牌判定**同一套**,
 *    绝不能让提示词里的牌型名和摊牌时界面上的牌型名对不上。
 *
 * @param {object} view viewForSeat 的座位视角
 * @returns {string|null} 牌型名;底牌不全时返回 null(宁可不写,也不编)
 */
function madeHandText(view) {
  const hole = (view?.me?.hole || []).filter((c) => c !== null && c !== undefined);
  const board = (view?.board || []).filter((c) => c !== null && c !== undefined);
  const shortDeck = !!view?.shortDeck;
  if (hole.length < 2) return null;
  if (board.length >= 3) {
    // ⚠️ shortDeck 必须同时透给 evaluate 和 describe:
    //    evaluate 会按短牌重排「对外类别号」(三条>顺子、同花>葫芦),
    //    describe 内部再反查回标准类别取名字(SHORT_TO_STANDARD_CATEGORY)。
    //    少传一个,短牌里就会出现「顺子被叫成三条」这种自相矛盾的提示词。
    return describe(evaluate([...hole, ...board], { shortDeck }), { shortDeck });
  }
  // 公共牌不足 3 张(正常只可能是翻前):用起手牌的说法。
  return preflopHandText(hole);
}

/** 本地兜底决策:牌力 + 底池赔率 + 性格权重 */
function fallbackDecide(seatView, persona) {
  const { me, board, pot, toCall, legal, currentBet } = seatView;
  const p = persona || { vpip: 0.33, pfr: 0.24, aggression: 0.6, callDown: 0.55 };
  const hole = me.hole.filter((c) => c !== null);
  const shortDeck = !!seatView.shortDeck;
  if (hole.length < 2) return { action: 'check' };

  // 牌力(0~1)+ 可读牌型名
  let strength, handName = '未成牌';
  if (board.length >= 3) {
    const sc = evaluate([...hole, ...board], { shortDeck });
    handName = describe(sc, { shortDeck });
    const key = categoryKey(sc, { shortDeck });
    // ⚠️ 短牌不能直接用标准牌力表:短牌里 **三条 > 顺子** 且 **同花 > 葫芦**,
    //    拿标准表去查会把顺子(0.84)评得比三条(0.76)强、把葫芦(0.94)评得比同花(0.88)强,
    //    正好反了 —— 断网兜底时 AI 会在短牌里做出错误的强弱判断。
    //    (这个坑之前被另一个 bug 掩盖着:categoryKey 把同花/葫芦的名字说反了,
    //     于是查表结果碰巧是对的。修好命名之后才暴露出来。)
    strength = (shortDeck ? {
      high_card: 0.18, one_pair: 0.42, two_pair: 0.62, straight: 0.70,
      three_of_a_kind: 0.78, full_house: 0.86, flush: 0.92,
      four_of_a_kind: 0.99, straight_flush: 1,
    } : {
      high_card: 0.18, one_pair: 0.42, two_pair: 0.62, three_of_a_kind: 0.76,
      straight: 0.84, flush: 0.88, full_house: 0.94, four_of_a_kind: 0.99, straight_flush: 1,
    })[key] ?? 0.4;
    strength = Math.min(1, strength + Math.max(0, (sc[1] || 0) - 10) * 0.01);
  } else {
    strength = preflopStrength(hole);
  }

  // 性格 → 门槛。参照点:起手牌强度的中位数约 0.38,
  // 实测这套系数能把各性格的入池率拉开到 25%~70%,且与模板值大体吻合。
  const tight = 0.30 - p.vpip;                     // 正数=偏紧,负数=偏松
  const bbSize = seatView.bigBlind || 20;
  const bigBet = toCall > bbSize * 2.5;
  // 风险偏好也参与:惜命的人(callBar 更高)更容易弃掉边缘牌,敢赌的人更容易跟全下。
  // 本地兜底必须和提示词里的「风险偏好」保持一致,否则断网时 AI 会突然换个人格。
  const risk = typeof p.risk === 'number' ? p.risk : 0.5;
  const riskTilt = (0.5 - risk) * 0.16;            // risk 低(惜命)→ 正数 → 门槛抬高
  const callBar = 0.32 + tight * 1.10 + (p.callDown - 0.55) * 0.14 + (bigBet ? 0.10 : 0) + riskTilt;
  const raiseBar = 0.66 - p.aggression * 0.26 - (risk - 0.5) * 0.10;

  // 筹码深度也要影响打法(与提示词里「短码别磨蹭、深码可施压」一致):
  //   · 短码:垃圾牌不该跟注磨蹭(门槛抬高),但拿到好牌要敢全下翻倍
  //   · 深码:可以用更多牌施压(门槛略降)
  const myBB = (me.stack || 0) / bbSize;
  const shortStacked = myBB < 10;
  const deepStacked = myBB > 25;
  const stackTilt = shortStacked ? 0.10 : (deepStacked ? -0.04 : 0);

  const noise = (Math.random() - 0.5) * 0.12;
  const score = strength + noise;
  const canRaise = !!legal?.canRaise;
  const bb = seatView.bigBlind || 20;

  const makeRaise = (note) => {
    const minTo = legal.minRaiseTo;
    const maxTo = legal.maxRaiseTo;
    // 下注尺度:正常 0.5~0.7 个底池,激进的人更大
    const target = Math.round(pot * (0.45 + p.aggression * 0.35) + currentBet + toCall);
    const to = Math.max(minTo, Math.min(maxTo, target || minTo));
    // 只剩一点点就干脆全下,省得来回磨
    if (maxTo - to < bb * 3) {
      const allInChance = strength > 0.9 ? 0.55 : p.aggression > 0.85 ? 0.22 : 0.06;
      if (Math.random() < allInChance) return { action: 'allin', amount: maxTo, note: `${note},直接全下` };
    }
    return { action: 'raise', amount: to, note };
  };

  // 1) 太弱且要花钱 → 弃牌
  const foldBar = 0.12 + tight * 0.25 + Math.max(0, toCall / (pot + toCall) - 0.18) * 0.25;
  // 短码不磨蹭:垃圾牌就别花钱跟了(但下面的分支会保证好牌敢全下)
  if (toCall > 0 && score < foldBar + stackTilt * 0.5) {
    return { action: 'fold', note: `${handName},${((toCall / (pot + toCall)) * 100).toFixed(0)}% 的赔率划不来` };
  }

  // 2) 牌力够好(或够激进)→ 主动下注/加注
  if (canRaise && score >= raiseBar) {
    return makeRaise(handName);
  }

  // 3) 不用花钱 → 看牌(偶尔用一个小注试探)
  if (toCall === 0) {
    if (canRaise && Math.random() < p.aggression * 0.1) {
      return { action: 'raise', amount: legal.minRaiseTo, note: `试探性下注(${handName})` };
    }
    return { action: 'check', note: handName };
  }

  // 4) 该跟就跟
  if (score >= callBar + stackTilt || (p.callDown > 0.7 && Math.random() < 0.35)) {
    // 短码时「跟注」往往不如「全下」——跟完还剩一点点筹码,下一手被盲注吃掉更亏。
    // 与提示词里「短码要么弃、要么直接全下翻倍」保持一致。
    if (toCall >= me.stack) return { action: 'allin', amount: legal.maxRaiseTo, note: `${handName},只能全下跟` };
    if (shortStacked && canRaise && strength >= 0.55) {
      return { action: 'allin', amount: legal.maxRaiseTo, note: `${handName},短码直接全下翻倍` };
    }
    return { action: 'call', note: handName };
  }

  // 5) 短码 + 好牌:与其弃掉被盲注磨死,不如拼一把
  if (shortStacked && canRaise && score >= callBar - 0.06) {
    return { action: 'allin', amount: legal.maxRaiseTo, note: `${handName},短码没得磨,拼一手` };
  }

  return { action: 'fold', note: `${handName},不值得跟 ${toCall}` };
}

/**
 * 清洗模型给的「牌桌发言」。
 *
 * 模型经常不听话,会把这段话写得又长又啰嗦(或者干脆把思考过程抄进来),
 * 而气泡就那么点大 —— 所以这里强制收敛:
 * 去掉换行、去掉首尾引号、压掉多余空格,再截到 24 个字。
 * 空字符串是**合法**的(提示词里明确允许「这手不说话」)。
 */
function cleanSay(v) {
  if (v === null || v === undefined) return '';
  let s = String(v).replace(/\s+/g, ' ').trim();
  // 模型爱自作主张加引号(「」「"" ''),气泡里再套一层引号很难看
  s = s.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim();
  if (s.length > 24) s = s.slice(0, 24);
  return s;
}

/**
 * `thinking` 的长度上限(字)。
 *
 * 提示词里写的是「不超过 40 个字」,但**不同模型的遵守程度差别很大**:实测有模型
 * 把整段推理草稿(带 markdown、好几百字)倒进这个字段。40 太紧:一句话被从中间
 * 砍断,「为什么这么打」那一半正好没了 —— 那是玩家最想看的部分。
 * 取 80 = 两句典型中文的长度(每句 30~40 字),够放下「牌力 + 读人 + 为什么」,
 * 又远小于界面气泡的 200 字上限(app.js 的 tidyThinking),不会撑破气泡。
 */
const THINKING_LIMIT = 80;

/**
 * 清洗模型给的 `thinking`。
 *
 * 为什么需要:提示词明确要求 thinking 是「一到两句中文、40 字以内」,
 * 但模型不一定守规矩。用户截图里就有模型把整段带 markdown 的推理草稿倒进来:
 *   「**分析当前局面:** - ** 我有6♦7♠, 翻牌3♦Q♠10♠…」
 * 而这段文字是**原样显示在牌桌上给玩家看**的 —— 界面那层(app.js 的 tidyThinking)
 * 只清 JSON 语法和英文格式指令、**不认 markdown**,于是气泡里就是一串星号和短横线。
 *
 * 清洗原则是**保守**:只去标记,不改写内容。
 *   · 去掉强调标记(`**` / `__` / 单个 `*`)与代码块围栏;
 *   · 去掉行首的结构标记(`#` 标题、`-` `*` `+` `•` 列表、`1.` 编号、`>` 引用);
 *   · 多行压成一段,但**用句号接起来**:直接删换行会把「我有6♦7♠」和
 *     「翻牌3♦Q♠10♠」粘成一个词,读起来更糟;
 *   · 超长在句子边界(。!?;,)处断,不切在半个词上。
 * ⚠️ 不去动 `_`:中英混排里 `three_of_a_kind` 这类标识符会被粘成一坨,
 *    而单个下划线做强调的情况极少。
 * ⚠️ 只影响**显示**。提示词 / 历史 / 记忆里都不含 thinking(见 decide 里的
 *    this.history.push 与 app.js 的 memoryFor),所以这里怎么改都不会改变发给
 *    模型的内容 —— 这一点是有意保持的,别在这里加「回写」。
 * ⚠️ `say` 有自己的 cleanSay(气泡只剩一句话的位置,还要去引号),别合并。
 *
 * @param {*} raw 模型输出里 thinking / reasoning / reason 字段的值
 * @param {number} [maxLen] 长度上限(纯文本兜底那条路径用 120,与旧行为一致)
 */
function cleanThinking(raw, maxLen = THINKING_LIMIT) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw);
  // 代码块围栏与强调标记
  s = s.replace(/```[a-zA-Z]*/g, ' ').replace(/\*\*|__/g, '').replace(/\*/g, ' ');
  const parts = [];
  for (const rawLine of s.split(/\r?\n/)) {
    const line = rawLine
      .replace(/^\s*#{1,6}\s*/, '')            // # 标题
      .replace(/^\s*>\s?/, '')                 // > 引用
      .replace(/^\s*[-+•·]\s+/, '')            // - * + • 列表(单星号已在上面变成空格)
      .replace(/^\s*\d+[.)、]\s+/, '')          // 1. / 1) / 1、 编号
      .replace(/\s+/g, ' ')
      .trim();
    if (line) parts.push(line);
  }
  if (!parts.length) return '';
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    // 上一段已经有句末/停顿标点就直接接,否则补一个句号 —— 免得两句粘一起
    out += /[。！？!?；;，,、：:…—-]$/.test(out) ? parts[i] : `。${parts[i]}`;
  }
  // 压掉重复标点(模型爱写「。。。」「,,」)
  out = out.replace(/([。！？!?，,、；;：:])\1+/g, '$1').replace(/\s+/g, ' ').trim();
  // 「标题: - 内容」这种行内列表残留(标记在**冒号后面**,不是行首,上面那轮漏掉):
  // markdown 草稿里非常常见(「**分析当前局面:** - ** 我有6♦7♠」)。只处理紧跟在
  // 冒号后面的孤立短横线 —— 牌面里的连张写法(「6-7」)和数字区间都不带这种冒号前缀,
  // 所以这条规则的误伤面很小。
  out = out.replace(/([:：])\s*[-–—]\s+/g, '$1');
  if (out.length > maxLen) {
    const head = out.slice(0, maxLen);
    const cut = Math.max(
      head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
      head.lastIndexOf('；'), head.lastIndexOf('，'), head.lastIndexOf(' '),
    );
    // 只在后半段找得到边界才按边界断,否则宁可按上限硬切(避免只剩半句)。
    // 边界字符本身要留下:切在句号**前面**会让句子变成没有句号的半截
    // (「…只能过牌」),读起来像是被硬截断的;多留一个顿号/逗号无所谓 ——
    // 下面的收尾会把末尾标点去掉。
    out = cut >= Math.floor(maxLen * 0.5) ? head.slice(0, cut + 1) : head;
  }
  return out.replace(/[\s,，、;；:：\-]+$/, '');
}

/**
 * 本地策略没有 LLM 说话,但玩家模式下如果桌上始终没人开口会很死。
 * 给一句**跟动作对得上的中性短句** —— 刻意不编造牌力
 * (本地策略的行动是算出来的,随口说「我拿的是AA」会和实际打法矛盾)。
 */
const LOCAL_SAY = {
  fold: ['这手先放了。', '不划算,过。', '你们玩。'],
  check: ['过。', '看一张。', '不要。'],
  call: ['跟了。', '陪你看看。', '行,跟。'],
  raise: ['加点压力。', '这个价你接得住吗?', '往上抬一点。'],
  allin: ['全下了。', '就这一把。', '不用想了。'],
};
function localSay(action) {
  const arr = LOCAL_SAY[action];
  return arr ? arr[Math.floor(Math.random() * arr.length)] : '';
}

/**
 * 从厂商/中转站的报错里认出「哪个参数它不认」。
 *
 * 为什么需要:不同模型对**可选参数**的容忍度差别极大。
 * 最典型的是 OpenAI 的 o 系列 / gpt-5 系列,它们会直接拒绝:
 *   "Unsupported value: 'temperature' does not support 1.1 with this model.
 *    Only the default (1) is supported."
 * 还有些模型只认 max_completion_tokens、不认 max_tokens。
 *
 * 中转站把几十家模型挂在**同一个地址**后面,所以我们发的那套统一参数
 * 必然有一部分模型不认 —— 用户看到的就是「大部分模型都调用失败」。
 *
 * 与其维护一张「哪些模型支持 temperature」的白名单(永远追不上新模型),
 * 不如**按报错自适应降级**:它说哪个字段不认,就摘掉哪个再发一次。
 * 只摘可选参数,模型名/消息体这些必需的绝不摘 —— 摘了就变成另一种错。
 */
function unsupportedParamIn(text) {
  const t = String(text || '');
  // 先确认这确实是「参数不支持 / 参数超出范围」类报错,而不是「模型不存在」「余额不足」。
  // 范围类的措辞也要认:Claude 走 OpenAI 兼容口时报的是
  // "temperature: Input should be less than or equal to 1",GLM 报「取值范围是 (0, 1]」——
  // 只认 unsupported/invalid 的话这两种都漏掉。
  if (!/unsupported|not supported|does not support|invalid|unrecognized|unknown|不支持|额外|extra|range|less than|greater than|must be|should be|between|exceed|out of|only .*allowed|取值|范围|超出/i.test(t)) return null;

  /**
   * 我们可能会发出去的可选参数。报错里提到哪个就摘哪个。
   *
   * ⚠️ thinking / reasoning_effort 必须在这里。它们原本是给 DeepSeek 用的,
   *    但**截断重试**会把 `thinking: {type:'disabled'}` 塞进请求体
   *    (见 decide 里的重试分支),而中转站后面绝大多数模型不认这个字段。
   *    于是现象就是「第一次调用成功(但被截断)→ 重试带着 thinking → 400 失败」。
   *    只覆盖 temperature/max_tokens 的时候,这一条会被漏掉。
   *
   * ⚠️ **嵌套字段**也必须能认出来(canonical 名统一成 'thinking' / 'reasoning'):
   *    推理档位这套参数不止顶层有 —— Gemini 的 thinkingConfig 嵌在
   *    generationConfig 里,字段名在报错文本里长这样:
   *      "thinking_budget is out of range"、"thinkingConfig.thinkingBudget: invalid"
   *      "thinking.budget_tokens must be less than max_tokens"
   *      "Unsupported parameter: 'reasoning.effort'"
   *    只按 'thinking' 一个字去匹配虽然能碰对大半,但漏掉
   *    thinkingBudget / thinking_budget / budget_tokens 这几个写法就会「降级不了、
   *    直接失败」—— 而这一版刚把 Gemini 的预算从 0 改成 512、给 Anthropic 加了
   *    1024,正是新参数最可能被某个型号拒掉的时候,兜底必须真的兜得住。
   *    摘掉整块的实现见 shared/llmStream.mjs 的 omit 处理(顶层 delete 摘不到嵌套)。
   *
   *    顺序要紧,分两轮扫,而且**思考类必须排在额度类前面**:
   *      · 'reasoning_effort' 要排在 'reasoning' 前面 —— 后者是前者的子串,
   *        反了的话一个本该按顶层字段摘的报错会被当成 responses 的 reasoning 对象,
   *        openai 协议上就摘了个不存在的东西(降级了但报错照旧)。
   *      · 思考类排在 max_tokens 前面,因为这类报错**经常同时提到额度**:
   *        Anthropic 的 "thinking.budget_tokens: Input should be less than max_tokens"
   *        里两个词都有。先命中 max_tokens 就会去摘额度 ——
   *        而 max_tokens 对 Anthropic 是**必需字段**,摘掉直接变成另一种 400,
   *        降级反而把请求弄坏了。真正的病因是思考预算,摘它才对。
   */
  const OPTIONAL = [
    // —— 第一轮:思考 / 推理块(含各自的嵌套写法)——
    ['reasoning_effort', 'reasoning_effort'],
    ['thinkingconfig', 'thinking'],           // Gemini:generationConfig.thinkingConfig
    ['thinkingbudget', 'thinking'],
    ['thinking_budget', 'thinking'],
    ['thinking budget', 'thinking'],
    ['budget_tokens', 'thinking'],            // Anthropic:thinking.budget_tokens
    ['thinking', 'thinking'],
    ['reasoning.effort', 'reasoning'],        // Responses:reasoning.effort
    ['reasoning', 'reasoning'],
    // —— 第二轮:其余可选参数 ——
    ['temperature', 'temperature'],
    // 同义字段:不同协议/世代叫法不同,但都是「输出额度」这一个东西。
    // 报错里出现哪个都归到 canonical 名 'max_tokens',
    // 由 buildRequest 的 omit 把这几个同义字段一起删掉。
    ['max_completion_tokens', 'max_tokens'],
    ['max_output_tokens', 'max_tokens'],      // Responses 协议的叫法
    ['max_tokens', 'max_tokens'],
    ['top_p', 'top_p'],
  ];
  for (const [needle, field] of OPTIONAL) {
    if (t.toLowerCase().includes(needle)) return field;
  }
  return null;
}

/** 从模型输出里抠出 JSON(容错:代码块、前后废话、单引号) */
function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/```(?:json)?/gi, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = t.slice(start, end + 1);
  const tries = [slice, slice.replace(/'/g, '"').replace(/,\s*}/g, '}')];
  for (const s of tries) {
    try { return JSON.parse(s); } catch { /* 继续尝试 */ }
  }
  return null;
}

/** 把模型的自由文本动作词归一化 */
function normalizeActionWord(raw) {
  const t = String(raw || '').toLowerCase().trim();
  if (!t) return null;
  if (/all.?in|全下|梭哈|推/.test(t)) return 'allin';
  if (/fold|弃牌|放弃|扔/.test(t)) return 'fold';
  if (/check|看牌|过牌|不加/.test(t)) return 'check';
  if (/call|跟注|跟|平跟/.test(t)) return 'call';
  if (/raise|bet|加注|下注|加/.test(t)) return 'raise';
  return null;
}

/* ==================================================================== *
 * 模型调用的重试:临时性失败再试几次,实在不行才回落本地策略
 * ==================================================================== */

/**
 * 默认重试策略(**要调就调这里**,或写进配置的 llmRetry 覆盖)。
 *
 * 为什么要重试:上游的抖动是**一过性**的 —— 中转站报「无可用渠道」「overloaded」
 * 之后隔几秒同一条请求就能成。以前一失败就立刻 `return fallback()`,
 * 用户看到的就是「某个模型偶发超时 → 那一手突然变成本地策略在打」,
 * 而它下一手又好了。用户的诉求很明确:超时/失败重试 3 次,3 次都不行才用本地策略。
 *
 * ⚠️ 「失败」不止是 HTTP 失败。**HTTP 200 但内容用不了**(模型返回了一段没有
 *    可识别动作的文本、或者干脆一个字都没有)也算 —— 用户实测撞到的那条
 *    「模型没有给出可识别的动作,已改用本地策略」就是这一类,它以前在重试外壳
 *    **外面**,一次就兜底。现在它和网络失败共用同一个 times / 同一条死线:
 *    一次决策总共最多 1 + times 次尝试,不管失败是哪种、怎么混合都不变。
 *
 * ⚠️ `budgetMs` 是这套东西唯一的风险点,必须有:
 *    单次调用超时是 45s(用户定的),3 次重试机械地乘起来就是 135s。
 *    一张桌子是**轮流**调用模型的,一个人卡 135 秒全桌一起等 ——
 *    而用户此前已经因为「等了 78 秒」抱怨过一次(见 config.cjs 里 timeoutMs 的注释)。
 *    所以这里给「一次决策的累计耗时」硬上限:到点立刻兜底,绝不再发新请求。
 *    注意是**累计**:截断重试、网络重试、解析重试三者共用同一条死线
 *    (见 decide 里 retryCtx 的构造),所以它们不会各自计时、叠成两分钟。
 */
const LLM_RETRY = {
  /**
   * 失败后**额外**再试几次 → 一共最多 1 + times 次「逻辑尝试」。
   * 3 次:用户要的。再多就只是在同一个病上反复撞墙。
   *
   * ⚠️ 这一个数字同时管住**所有**失败:网络/超时、截断、空回答、
   *    「没有可识别的动作」。`times: 0` 就是「一次都不重试」——
   *    行为与加这套机制之前完全一致(失败/解析不出 → 直接本地策略),
   *    想临时关掉重试就填 0,不必改代码。
   */
  times: 3,
  /**
   * 每次重试前等多久(毫秒),用完之后沿用最后一个值。
   *
   * 为什么是这个量级:上游恢复通常就是几秒内的事,所以**短退避**即可 ——
   * 600ms 足够躲过一次连接抖动,1.5s / 3s 覆盖「过载 / 无可用渠道」的恢复窗口。
   * 刻意**不是**「先把一个完整超时等满再重试」:那等于把一次 45s 变成两次 45s,
   * 用户抱怨的就是这个。三次退避合计 5.1s,相对 90s 的预算只是零头。
   */
  backoffMs: [600, 1500, 3000],
  /**
   * 一次决策的累计耗时上限(毫秒):到点立刻回落本地策略。
   *
   * 90s 的来历:首次尝试最多跑满 45s(timeoutMs),加一次重试就是 90s ——
   * 也就是说「连续两次真的超时」就已经吃光预算,不会再出现第三次、第四次,
   * 更不会出现 3×45=135s。反过来,快速失败(503 / 无可用渠道,通常 1s 内返回)
   * 时四次尝试都能试上,这正是重试真正要救的场景。
   */
  budgetMs: 90000,
  /**
   * 是否**按错误类型**区分值不值得重试(见 classifyLlmFailure)。
   *
   * ⚠️ 这是本轮唯一一处「我替你做了选择」的地方,取舍写在这里:
   *    用户原话是「调用超时或失败重试 3 次」,并没有区分类型;
   *    但 401/403(Key 错)、协议不对、模型名错、余额不足这几种,
   *    **重试必然同样失败** —— 白等 5 秒退避、白发 3 个请求,最后照样兜底。
   *    所以默认 true(按类型分,配置性错误直接兜底),
   *    想完全照原话办(任何失败都重试 3 次)就把这里改成 false,
   *    或在配置里写 `"llmRetry": { "classifyErrors": false }`。
   *
   * ⚠️ 这个开关**管不到**「解析不出动作 / 空回答」那一类:它们没有
   *    「配置性」可言(HTTP 是成功的、配置没错),而且重发一次经常就好,
   *    所以它们无条件可重试(见 classifyLlmFailure 的 ⓪)。
   *    也就是说关掉分类不会让解析失败变成不重试;要完全不重试就用 times: 0。
   */
  classifyErrors: true,
};

/**
 * 预算只剩这么点时间就不要再发下一次了 —— 发出去也几乎必然再超时,
 * 只会让全桌多等一次超时的时间。
 */
const RETRY_MIN_HEADROOM_MS = 1500;

/** 取消(牌局重开 / 退出 / 改规则)不是「模型失败」,用这个固定说法 */
const CANCEL_MESSAGE = '调用已取消(牌局已重开或退出)';

/** 带「已取消」标记的错误:上层据此**不再重试、也不弹失败提示** */
function canceledError() {
  const e = new Error(CANCEL_MESSAGE);
  e.canceled = true;
  return e;
}

/**
 * 带 HTTP 状态码的错误。
 * 状态码是判断「值不值得重试」最硬的信号(5xx/429 重试,401/403 不重试),
 * 而两条调用路径把状态码写在各自的错误文本里,统一在这里挂到 error 上。
 */
function llmFail(message, status) {
  const e = new Error(message);
  const n = Number(status);
  if (Number.isFinite(n) && n > 0) e.llmStatus = n;
  return e;
}

/** 从错误原文里捞状态码(两条路径的措辞:接口返回 / 厂商返回 / 转发失败 / "code":503) */
function statusFromText(text) {
  const m = /(?:接口返回|厂商返回|转发失败|status|HTTP|code)\D{0,8}(\d{3})/i.exec(String(text || ''));
  return m ? Number(m[1]) : 0;
}

/**
 * 这次失败值不值得重试:返回 'retryable'(临时性)或 'fatal'(配置性)。
 *
 * 判定顺序是**刻意**的,每一条都有踩过的坑:
 *   ① 余额/欠费排在 429 前面 —— OpenAI 的 insufficient_quota 回的就是 429,
 *      先按 429 归到「限流」会白白重试三次,而它重试一万次也不会变有钱。
 *   ② 协议不对排在模型名不对前面 —— 上游那句「模型 X 不支持 chat completions 协议」
 *      里两个词都有,先按模型名判会把用户引到错误方向(与 llmProbe 的 probeCause 同序)。
 *   ③ 「无可用渠道」**刻意不归到模型名不对**:探活(llmProbe)把它当「令牌分组不对」,
 *      因为那时要告诉用户去改哪个开关;但打牌时它是上游渠道的一过性状态
 *      (用户实测隔几秒就好),所以这里归可重试。
 *   ④ 参数不认(400 Unsupported parameter)不重试 —— 参数降级重试已经试过摘字段了,
 *      再发一次还是同样的 400,只会白花一次调用。
 *   ⑤ 兜底看状态码:其它 4xx 当配置性(不重试),没有线索的当临时性(重试)。
 */
function classifyLlmFailure(err) {
  const t = String(err?.message ?? err ?? '');
  if (err?.llmFatal) return 'fatal';
  // ⓪ 解析失败(见 parseFailureError):这一条**必须排在最前面**。
  //    HTTP 其实是成功的 —— 拿状态码/措辞去分类只会把它误判成「配置性错误/
  //    什么线索都没有」那一类,而它恰恰是最该重试的一类(模型是随机的,
  //    同一条 prompt 重发一次经常就正常了)。所以不给后面的规则任何机会。
  if (err?.llmParseFail) return 'retryable';
  const code = Number(err?.llmStatus) || statusFromText(t);

  // ① 余额 / 欠费:重试再多次也没用(且它经常和 429 一起出现)
  if (/insufficient[_ -]?(quota|balance|funds)|exceeded your current quota|余额|欠费|欠款|no credit|credit balance|充值/.test(t)) return 'fatal';
  // ② 鉴权 / 权限:Key 错、被禁、Worker 白名单不含目标域名 —— 都改配置才有用
  if (code === 401 || code === 403
    || /unauthorized|forbidden|invalid[_ -]?api[_ -]?key|incorrect api key|authentication|invalid token|令牌.{0,8}(无效|错误|过期)|密钥.{0,8}(无效|错误|过期)|不在白名单|白名单/.test(t)) return 'fatal';
  // ③ 协议不对 / 模型名不对 —— 配置性的
  if (/protocol[_ -]?not[_ -]?supported|unsupported[_ -]?protocol|不支持.{0,16}(协议|chat completions|messages api)/.test(t)) return 'fatal';
  if (/model[_ -]?not[_ -]?found|no such model|unknown model|invalid[_ -]?model|模型.{0,12}(不存在|未找到|无效|没有权限)|does not exist|没有配置接口地址|缺少.{0,12}(API Key|密钥)/.test(t)) return 'fatal';
  // ④ 参数不认(降级重试已经摘到不能再摘了)
  if (/unsupported (value|parameter)|does not support|不支持.{0,12}(参数|temperature|max_tokens)/.test(t)) return 'fatal';
  // ⑤ 临时性:5xx / 408 / 429 / 超时 / 网络 / 过载 / 限流 / 渠道暂时不可用
  if (code >= 500 || code === 408 || code === 425 || code === 429) return 'retryable';
  if (/timeout|timed out|超时|abort|socket hang up|econnreset|econnrefused|enotfound|etimedout|eai_again|fetch failed|network|networkerror|connection (reset|closed|error|refused)|bad gateway|service unavailable|gateway time|temporarily|过载|overload|system_memory_overloaded|rate[_ -]?limit|too many requests|限流|请求过于频繁|请求过快|无可用渠道|no available channel|渠道|try again|稍后|一会儿/.test(t)) return 'retryable';
  // ⑥ 其它明确的 4xx:多半是请求本身错了,别浪费三次重试
  if (code >= 400 && code < 500) return 'fatal';
  // ⑦ 什么线索都没有 → 当临时性。用户的诉求就是「失败就重试 3 次」,
  //    而明确的配置错在前面几条已经拦住了。
  return 'retryable';
}

/**
 * 「HTTP 成功、但内容用不了」—— 打上专用标记,交给重试外壳。
 *
 * 为什么要专门一个错误类型,而不是让 decide() 自己 return fallback():
 *   那样就发生在**重试外壳外面**了,一次就兜底 —— 用户实测撞到的
 *   「Grok(grok-4.7) 调用失败:模型没有给出可识别的动作」就是这么来的。
 *   打上 llmParseFail 之后:
 *     · classifyLlmFailure 无条件判它可重试(见那里的 ⓪);
 *     · retryReason 能把它压成用户看得懂的一句话;
 *     · 尝试次数仍由外层**唯一**那条计数管着,不另起循环、不与网络重试相乘。
 */
function parseFailureError(reason, raw) {
  const e = new Error(parseFailureMessage(reason));
  e.llmParseFail = true;
  e.parseReason = reason;
  e.raw = String(raw || '').slice(0, 400);
  return e;
}

/** reason: 'truncated'(截断)/ 'empty'(空回答)/ 'action'(有内容但没有可识别的动作) */
function parseFailureMessage(reason) {
  if (reason === 'empty') return '模型返回了空内容(HTTP 200 但一个字都没有)';
  if (reason === 'truncated') return '模型只给了推理过程,没有给出正式回答(截断)';
  return '模型没有给出可识别的动作';
}

/** 把失败原因压成几个字,写进「第 N 次重试」的提示里(用户要看懂在等什么) */
function retryReason(err) {
  const t = String(err?.message || err || '');
  // 解析失败没有状态码、也没有网络措辞,直接按标记给准确的说法
  if (err?.llmParseFail) return parseFailureMessage(err.parseReason);
  const code = Number(err?.llmStatus) || statusFromText(t);
  if (/超时|timeout|timed out/.test(t)) return '超时';
  if (/无可用渠道|no available channel/.test(t)) return '上游无可用渠道';
  if (/overload|过载|system_memory_overloaded/.test(t)) return '上游过载';
  if (code === 429 || /rate[_ -]?limit|too many requests|限流|请求过于频繁/.test(t)) return '限流';
  if (code >= 500) return `上游 ${code}`;
  if (/fetch failed|network|econnreset|econnrefused|enotfound|etimedout|socket/.test(t)) return '网络错误';
  return `错误 ${t.replace(/\s+/g, ' ').slice(0, 40)}`;
}

/**
 * 把配置里的 llmRetry 与默认值合并。
 * 单个字段缺省 / 非法都退回 LLM_RETRY 里的值,别让一个手误把重试整个关掉或开成无限。
 */
function resolveRetryPolicy(cfg) {
  const raw = cfg?.llmRetry || {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const arr = Array.isArray(raw.backoffMs)
    ? raw.backoffMs.map(Number).filter((n) => Number.isFinite(n) && n >= 0)
    : null;
  return {
    times: Math.min(num(raw.times, LLM_RETRY.times), 8),
    backoffMs: arr && arr.length ? arr : LLM_RETRY.backoffMs,
    budgetMs: num(raw.budgetMs, LLM_RETRY.budgetMs),
    classifyErrors: raw.classifyErrors === undefined ? LLM_RETRY.classifyErrors : !!raw.classifyErrors,
  };
}

/** 第 attempt 次重试(从 0 数)前等多久 */
function backoffFor(policy, attempt) {
  const list = policy.backoffMs;
  return list[Math.min(attempt, list.length - 1)] ?? 0;
}

/**
 * 可取消的等待。
 * 退避的这几秒里牌局完全可能被重开 / 退出 —— 那样必须**立刻**停,
 * 不能"睡完再发现已经取消了",那会多发一次请求(旧决策被 act 到新引擎上就是这个链条)。
 */
function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(canceledError()); return; }
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); reject(canceledError()); };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

class PokerAgent {
  /**
   * @param {number} seat
   * @param {object} persona
   * @param {object} cfg  { endpoint, apiKey, model, timeoutMs, temperature, maxTokens, reasoningLevel, kind }
   *   reasoningLevel:'off'|'low'|'default' —— 四家协议各自的思考档位,由 shared/llmStream.mjs
   *   统一落到字段上(默认 'low':保留推理但压到最低)。
   * @param {object} hooks { onThink(chunk, full, thinking), onDecision(obj), onError(err), onDebug(msg), onTruncated(info) }
   *   thinking=true 表示这是模型「推理阶段」的增量(如 deepseek 的 reasoning_content),
   *   而不是正式回答 —— 界面可以显示得淡一些,并在正式回答到达时切换。
   *   onTruncated 在「推理吃光了 max_tokens、正式回答没来」时触发,
   *   用于提示用户调大 token 预算(否则决策是从残缺文本硬猜的)。
   */
  constructor(seat, persona, cfg = {}, hooks = {}) {
    this.seat = seat;
    this.persona = persona;
    this.cfg = cfg;
    this.hooks = hooks;
    this.history = [];        // 该座位自己记得的行动(只属于它自己)
    /**
     * 私有「读人笔记」:seat -> 这个 AI 对那个人的判断。
     *
     * 跨手累积,是长期认知的唯一载体(牌桌记忆明细只看最近几手)。
     * 每次写笔记时能看到自己上次写的,可以合并/修正/推翻 —— 越打越准。
     *
     * ⚠️ 这是**私有**的:每个 Agent 一份,读法会分歧(跟真人一样)。
     *    而且只能基于公开信息 —— 弃牌没亮过的牌不许写进去。
     */
    this.notes = {};
    this.notesHandNo = 0;     // 上次写笔记是第几手(用来算「每 N 手写一次」)
    this.stats = { decisions: 0, llmOk: 0, fallback: 0, errors: 0, noteWrites: 0, noteFailures: 0 };
  }

  get name() { return this.persona?.name || `座位${this.seat + 1}`; }

  setConfig(cfg) { this.cfg = { ...this.cfg, ...cfg }; }

  /* ---------------------------------------------------------------- 提示词 */

  buildSystemPrompt() {
    const p = this.persona || {};
    return [
      `你是一个坐在德州扑克牌桌上的牌手,名字叫「${p.name || '无名'}」。`,
      '',
      '【你的目标 —— 这是淘汰赛,不是随便玩】',
      '赢光其他所有人的筹码,把他们都淘汰出局,活到最后,拿下这张桌子的第一名。',
      '第二名没有意义 —— 你要的是冠军。所以该忍的时候忍,该狠的时候狠。',
      '',
      '【筹码就是命】',
      '· **筹码归零你就出局了**,这一局对你彻底结束。所以「活着」永远优先于「赢这一个池」。',
      '· 你的名次目标很清楚:**尽量拿高名次、尽量避免被淘汰、尽量把别人淘汰掉**。',
      '  场上每少一个人,你的名次就高一位 —— 淘汰别人既是收益,也是在给自己腾位置。',
      '· 但也**不能一味龟缩**:盲注每隔几圈就涨一档,一直不进池会被盲注活活磨死。',
      '  该拼的时候要拼,只是要挑**值得的那一手**去拼。',
      '',
      '【你的风险偏好】',
      `别人对你的评价是「${riskLabel(p.risk)}」。`,
      '这决定你有多怕被淘汰:怕的人宁可错过也不冒险,不怕的人愿意用筹码去赌。',
      '但注意 —— 「不怕输」不等于乱来,「怕输」也不等于一直弃牌:',
      '真正的高手是在**该保守的时候保守、该拼命的时候拼命**。',
      '',
      '【这是博弈,不只是算术 —— 光看牌力赢不了】',
      '最重要的观念:你赢的钱**主要来自让对手做错决定**,不是来自你手里的牌好。',
      '牌好就下注、牌差就弃牌,这种打法对手一看就懂,你永远赢不到大钱。',
      '',
      '【节奏:这是牌桌,不是长考】',
      '你要**快速决断** —— 像真人一样,几秒钟就下决定,不要反复推演。',
      '内部推理尽量短(一两句话够了),把篇幅留给最终那个 JSON。',
      '想太久会被判超时,那一手就白打了。',
      '',
      '【诈唬:这是核心技能,不是偶尔的调剂】',
      '你每一手都要问自己一句:**如果我现在下注,他会不会弃牌?**',
      '下面这些情况,即使你手里什么都不是,也应该**果断下注或加注**:',
      '· 对手一路过牌或只是跟注,明显在示弱 —— 他最怕你下注;',
      '· 公共牌看起来对你不利、但其实没人能中(比如 K 高干燥面),谁都不像有牌;',
      '· 你位置在最后,前面的人都过牌 —— 这是最经典的偷池机会;',
      '· 转牌/河牌发出一张「吓人的牌」(A、K 或成对),对手的跟注范围会大幅缩水;',
      '· 只有一两个对手时,诈唬成功率远高于多人底池。',
      '',
      '反过来也要会:**牌很好时不要总是猛加**。偶尔只是跟注或过牌,',
      '让对手以为你软弱,引他在后面下注,你再收网(设陷阱)。',
      '如果对手的大注你读不透,**他很可能正在诈唬你** —— 别被吓跑。',
      '',
      '【读人,不是读概率】',
      '· 他刚才为什么那样下注?那个尺度是想让你跟,还是想让你弃?',
      '· 他筹码多不多?短码的人不敢乱来,深码的人可以施压。',
      '· 他前面几手打得紧还是松?紧的人突然加注,通常真有牌;松的人加注说明不了什么。',
      '· 位置、筹码量、底池大小都是武器。短码不要硬拼,深码可以施压。',
      '',
      '【你的风格】',
      `别人对你的印象是「${p.tag || '普通'}」:${p.style || '按常规打。'}`,
      p.line ? `你常挂在嘴边的一句话是「${p.line}」。` : '',
      '这是你的性格倾向 —— 决定你**偏向**怎么打,但不要打成套路:',
      '紧的人偶尔也要偷一把(否则没人怕你),激进的人也要懂得收手(否则你会被埋伏)。',
      '唯一的原则是:**别让对手猜到你手里是什么**。',
      '',
      '【规则约束】',
      '1. 你只能看到自己的底牌和桌上的公共牌。对手的底牌对你是未知的,不要假装知道。',
      '2. 只能做系统给出的合法动作,加注金额不能超过你的最大可用额。',
      '3. 只输出一个 JSON 对象,不要输出任何别的内容(不要 markdown、不要解释)。',
      '',
      '【不许搞错的三件事 —— 出错了会显得很蠢】',
      '① **别认错自己的位置**。你是什么位置上面写着(UTG / CO / BTN / SB / BB 等),',
      '   照抄那个词就行,不要自己推。也别把「第几个行动」和「位置好坏」搞反:',
      '   BTN 是最后行动、位置最好;SB/BB 是先行动、位置最差。',
      '② **别搞错自己的底牌**。下面会明确给你两张牌,就按那两张说,不要记成别的牌。',
      '   也不要说别人的底牌 —— 你看不到。想提别人只能猜范围,例如「他那个加注像是有一对」。',
      '③ **别把自己刚才做过的事记错**。本手的过程会按顺序列出来,不确定就回去看。',
      '',
      '【关于 thinking 字段 —— 最重要,请认真遵守】',
      '`thinking` 会**原样显示在牌桌上给玩家看**,所以它必须是给人读的中文。',
      '',
      '硬性要求:',
      '· **只能写中文**。一个英文字母都不要出现(牌型可以写「Q6同花」「A高」这种中文写法)。',
      '· **不超过 40 个字**,一到两句,像牌桌上顺口说的一句话。',
      '· 内容说清:你的牌力怎么样 / 你猜对手在想什么 / 为什么这么打。',
      '',
      '绝对不要出现这些(它们不是给人看的):',
      '· "We need…" / "Need analyze…" / "JSON" / "output format" 这类英文说明;',
      '· 复述规则、复述提示词、复述我的这封信;',
      '· 把你的推理过程一步一步写出来(不要过程,只要结论)。',
      '',
      '对照例子:',
      '✗ 错的:"We need answer JSON only. Need analyze poker. Hand Q6o BTN, pot 90, call 20."',
      '✗ 错的:"我需要输出 JSON 格式,先分析一下我的牌力和位置,然后决定动作。"',
      '✓ 对的:"Q6o 是边缘牌,但按钮位有位置、赔率也便宜,跟 20 看个翻牌。"',
      '✓ 对的:"前面都没加注,说明也没人有强牌,我这里可以下注把他们赶走。"',
      '',
      '【关于 say 字段 —— 你**说出口**的那句话】',
      '`say` 是你真的在牌桌上说出口的一句话,会显示在你头顶的气泡里给所有人看。',
      '在玩家模式下,这是别人唯一能看到的内容(`thinking` 是私密的,不给玩家看)。',
      '',
      '硬性要求:',
      '· **不超过 20 个字**,像牌桌上随口说的一句,不要解释、不要复述规则。',
      '· **必须和你这次的动作对得上**:弃牌就别喊加注,跟注别喊「我不玩了」。',
      '· 只说你自己知道的(你的底牌、你的读牌),**不要报别人的底牌**。',
      '',
      '内容可以是真的,也可以是**心理战** —— 这正是这个字段的用处:',
      '· 手里是坚果,可以装作犹豫:「这注有点大啊……」',
      '· 手里是空气,可以放狠话:「我劝你别跟。」',
      '· 也可以只是中性的一句:「跟了。」「过。」',
      '说什么由你的性格决定:诈唬型爱放话,保守型话少。',
      '**不想说话就留空字符串 ""** —— 连话都不说也是一种风格,不用每手都开口。',
      '',
      '【输出格式】(严格 JSON,不要 markdown 代码块)',
      '{"thinking":"一到两句中文,40 字以内","say":"牌桌上说的一句话,20 字以内,可留空","action":"fold|check|call|raise","amount":数字}',
      '说明:check / call / fold 时 amount 可省略;raise 时 amount 是「加注到」的目标总额(不是增量)。想全下就把 amount 写成你的最大可用额。',
    ].filter(Boolean).join('\n');
  }

  /** 由 viewForSeat 的数据生成局面描述(只含该座位可见的信息) */
  buildUserPrompt(view, actionHistory = []) {
    const lines = [];
    // —— 先把「你是谁、你拿的是什么」钉死 ——
    // 这一段刻意放在最前面,而且把位置和底牌**单独列出来**。
    // 原因:之前它们混在几句流水描述里,模型经常记错 ——
    // 实测出现过「AK是翻牌前的强牌」(它根本没有 AK,AK 是别人的)
    // 和把盲注位当好位置这类混乱。
    lines.push(`第 ${view.handNo} 手牌,现在是【${view.streetLabel}】。`);
    lines.push('');
    lines.push('════ 以下是关于你自己的事实,照它说,不要自己推 ════');
    lines.push(`· 你的位置:**${view.position || '未标注'}**`);
    // 底牌与**成牌名**分开写,而且成牌名单独占一行。
    // 以前成牌名是塞在底牌那行末尾的括号里的(「(当前成牌:…)」)—— 位置靠前、
    // 又不起眼,模型会无视它自己重新数牌,结果把 A♦ 记成 Q(用户实测那个葫芦)。
    // 单独成行 + 明说「引擎算好的」,是让模型知道这件事不需要它再算。
    // 翻前没有公共牌,describe 至少要 5 张牌套不上,所以走 preflopHandText 那条路
    // (详见 madeHandText 的注释);绝不能在翻前硬调 describe。
    const myHand = madeHandText(view);
    lines.push(`· 你的底牌:**${view.me.hole.filter((c) => c !== null && c !== undefined).map(cardText).join(' ')}**`);
    if (myHand) {
      lines.push(`· 你现在的成牌:**${myHand}**`
        + '(这是引擎按**当前已经发出**的公共牌算好的,直接采信 —— 不要自己再数一遍)');
    }
    // 筹码不能只给原始数字 —— 实测只写「你的筹码:60」时模型不会自己换算成
    // 「3 个大盲,快出局了」,它就把 60 当一个数字看。这里直接给结论。
    lines.push(`· 你的筹码:${view.me.stack} = **${view.me.bbCount} 个大盲**`
      + (view.me.rank ? `,全场第 ${view.me.rank} 多(共 ${view.aliveCount} 人还在)` : ''));
    lines.push(`  筹码状况:**${this._statusText(view.me.status)}**${this._dangerText(view, view.me)}`);
    lines.push('══════════════════════════════════════════');
    lines.push('');
    // —— 然后是桌面上的公共信息 ——
    //
    // ⚠️ 这里**绝对不能提「几号位」**。
    //    以前写的是「按钮位(D)在 N 号位」,而对手列表每行也带座位号
    //    (「- 1 号位 BTN 阿哲 ...」)。两套编号放在一起,模型会去比对,
    //    一旦它自己的座位号刚好也是 1,就认为信息自相矛盾,然后**在思考里
    //    纠结这件事**,整段思考全是「我的位置是 CO 但按钮位是 1 号位…看描述
    //    有点混乱…」这种废话(实测踩过,用户直接反馈「思考过程完全错乱」)。
    //    所以座位号一律不给 —— 牌桌上本来也不靠座位号认人,靠位置和名字。
    lines.push(`公共牌:${view.board.length ? view.board.map(cardText).join(' ') : '(还没有公共牌)'}`);
    lines.push(`底池:${view.pot}。当前需要跟注:${view.toCall}${view.toCall > 0 ? `(底池赔率约 ${((view.toCall / (view.pot + view.toCall)) * 100).toFixed(0)}%)` : ''}。`);
    lines.push(`盲注:${view.smallBlind}/${view.blindUnit || view.bigBlind}。`);
    if (view.orderText) lines.push(`本手行动顺序:${view.orderText}(越靠后位置越好)`);
    if (view.positionHint) lines.push(`你的位置说明:${view.positionHint}`);
    if (view.shortDeck) lines.push('注意:这是短牌局(36 张,没有 2~5),三条大于顺子、同花大于葫芦。');

    // —— 全场筹码对比:光知道自己有多少还不够,得看清桌上谁有钱、谁快死了 ——
    if (view.stackTable?.length) {
      lines.push('');
      lines.push(`【全场筹码对比】场上还剩 ${view.aliveCount} 人(淘汰一个你的名次就高一位):`);
      for (const s of view.stackTable) {
        lines.push(`  ${s.isMe ? '→ ' : '  '}#${s.rank} ${s.name}`
          + `${s.isMe ? '(你)' : ''}: ${s.bbCount} 个大盲 — ${this._statusText(s.status)}`);
      }
      const threats = view.stackTable.filter((s) => !s.isMe && s.status === 'deep');
      const prey = view.stackTable.filter((s) => !s.isMe && (s.status === 'short'));
      if (threats.length) {
        lines.push(`  〔威胁〕${threats.map((t) => t.name).join('、')} 筹码比你厚,`
          + '他们敢跟你全下 —— 别用边缘牌和他们硬碰。');
      }
      if (prey.length) {
        lines.push(`  〔目标〕${prey.map((t) => t.name).join('、')} 筹码很浅、最怕被淘汰 ——`
          + `对他们施压收益最大:${prey.length > 1 ? '他们' : '他'}不跟就被盲注磨死,`
          + '跟了也可能是被迫的(牌未必强)。');
      }
    }

    lines.push('');
    lines.push('桌上的对手(你看不到他们的底牌,只能靠他们做了什么来猜):');
    for (const p of view.players) {
      if (p.isMe) continue;
      // 用「位置 + 名字」标识,不用座位号(理由见上面那段注释)。
      // 名字可能是引擎的占位名「座位 N」——那只是个名字,不是座位号索引,
      // 不会跟位置混淆;实际开局时每个座位都会被换成性格名字。
      let s = `- ${p.position || ''} ${p.name || ''}`.replace(/\s+/g, ' ');
      // 对手的筹码也换算成大盲数 + 档位 —— 光看绝对数字判断不出威胁程度
      // (「筹码 120」到底是深是浅?要说成「6 个大盲,短码」才可用)
      if (p.bbCount !== undefined && p.bbCount !== null) {
        s += ` 筹码 ${p.stack}(${p.bbCount} 个大盲`;
        if (p.status === 'out') s += ',已出局';
        else if (p.status === 'allin') s += ',已全下';
        else if (p.status === 'short') s += ',**短码**';
        else if (p.status === 'deep') s += ',深码';
        else s += ',中码';
        s += ')';
      } else {
        s += ` 筹码 ${p.stack}`;
      }
      // ⚠️ 判「不再参与」只能看 status === 'out'(真出局),
      //    **不能**写 `|| p.stack <= 0` —— 全下的人筹码也是 0,但他就在这手牌里,
      //    写成「不再参与」会让 AI 以为可以无视他(实测模型在思考里明确纠结过
      //    「阿哲怎么显示 0 个大盲已出局,这列表有点混乱」)。
      if (p.status === 'out') {
        s += '(不再参与)';
        lines.push(s);
        continue;
      }
      if (p.folded) s += ',已弃牌';
      else if (p.allIn) s += ',已全下(他不会再改了)';
      else if (p.betThisRound > 0) s += `,本轮已下注 ${p.betThisRound}`;
      else s += ',本轮还没下注(可能在等你先动)';
      if (p.lastAction?.label) s += `(上一动作:${p.lastAction.label})`;
      lines.push(s);
    }

    if (actionHistory.length) {
      lines.push('');
      lines.push('本手到目前为止的过程(按顺序):');
      lines.push(actionHistory.slice(-26).map((h) => '  ' + h).join('\n'));
    }

    // —— 牌桌记忆:跨手的记性 ——
    // 没有这一段的话,AI 每一手都是从零开始:不知道谁刚才连加了三把,
    // 也不知道谁一直在弃牌 —— 打法就没有变化、也没有针对性。
    if (this.memory) {
      const memBlock = this.buildMemoryBlock();
      if (memBlock) { lines.push(''); lines.push(memBlock); }
    }

    lines.push('');
    const la = view.legal || {};
    lines.push('你现在的合法选择:');
    // 只列**可用**的选项,并且金额一定写具体值 ——
    // 以前不可用时也会印出「跟注 undefined」,模型会盯着这个 undefined 犯嘀咕
    // (实测它在思考里纠结「跟注 undefined 是什么意思」)。
    const opts = ['fold(弃牌)'];
    if (la.canCheck) opts.push('check(看牌)');
    if (la.canCall) opts.push(`call(跟注 ${la.callAmount ?? la.toCall ?? 0})`);
    lines.push(`- ${opts.join(' | ')}`);
    if (la.canRaise) lines.push(`- raise(加注到 ${la.minRaiseTo} ~ ${la.maxRaiseTo});也可以 allin(全下 ${la.maxRaiseTo})`);
    else lines.push('- 你不能加注(筹码不足以加注)');

    lines.push('');
    lines.push('想一想:他为什么这么下注?他是真有牌还是在吓你?你这一手是想拿下这个池,还是在给后面几手布陷阱?');

    /**
     * —— 决策前再确认一次(治 "lost in the middle")——
     *
     * 这份提示词很长:底牌在最前、全场筹码和记忆在中间、合法动作在最后,
     * 而模型对**中间**的内容最不敏感(常见现象,叫 lost in the middle)。
     * 实测的表现就是「记错自己的底牌」:用户那次 GLM 明明拿 A♦10♦、
     * 公共牌 3♦Q♣10♠ + 转牌 Q,它却说成「Q 带 10 的葫芦」——
     * 成牌名在提示词前段写过一次,到决策时已经被它丢了。
     * 所以在**紧挨着输出 JSON 的位置**把这一手真正要用的四个事实再复述一遍。
     *
     * ⚠️ 这里**只复述**、不加新信息:四条全部来自本手已知的信息(自己的底牌、
     *    已经发出的公共牌、引擎算好的成牌、底池与跟注额)。
     *    也**不要**把规则说明搬到这里来 —— 同一件事分两处写,
     *    早晚会一处改了一处没改,然后模型按错的那份打。
     *    成牌名一律用上面算好的 myHand(与摊牌判定同一套),不要重算一次。
     */
    lines.push('');
    lines.push('【决策前再确认一次 —— 下面四行就是事实,照抄,不要自己推】');
    lines.push(`· 你的底牌:${view.me.hole.filter((c) => c !== null && c !== undefined).map(cardText).join(' ')}`);
    lines.push(`· 公共牌:${view.board.length ? view.board.map(cardText).join(' ') : '还没有(这是翻前)'}`);
    lines.push(`· 你现在的成牌:${myHand || '还不知道(牌不全)'}`);
    lines.push(`· 需要跟注:${view.toCall}${view.toCall === 0 ? '(不用花钱,可以看牌)' : ''};底池:${view.pot}`);
    return lines.join('\n');
  }

  /* ---------------------------------------------------------- 记忆 / 读人笔记 */

  /**
   * 「牌桌记忆」那一段提示词:最近的明细 + 我对每个人的判断。
   *
   * 两块的分工:
   *   · 最近几手明细 → 具体发生了什么(引擎只保留最近 5 手)
   *   · 我写的笔记   → 长期倾向(跨手累积,越打越准)
   * 只给明细的话,AI 永远只知道「刚才几手」;只给笔记又会丢掉细节。
   */
  buildMemoryBlock() {
    const mem = this.memory || {};
    const hands = (mem.recentHands || []).slice(-5);
    const names = mem.opponentNames || {};
    const out = [];
    out.push('【牌桌记忆 —— 你自己积累的,可以据此调整打法】');
    out.push('(这些都是公开信息:谁下注了多少、谁弃牌、摊牌时亮过什么。');
    out.push(' 你看不到任何人没亮过的底牌,你的笔记也只能建立在这些公开信息上。)');
    if (hands.length) {
      out.push('');
      out.push(`最近 ${hands.length} 手:`);
      for (const h of hands) out.push(this.formatHandDelta(h, names));
    }
    const entries = Object.entries(this.notes).filter(([, v]) => v && String(v).trim());
    if (entries.length) {
      out.push('');
      out.push('我对这几个人的判断(我自己的观察):');
      for (const [key, v] of entries) out.push(`· ${key} — ${v}`);
    }
    return out.join('\n');
  }

  /**
   * 把一条公开摘要压成一行(给模型看的)。
   *
   * ⚠️ 这里必须**压缩**,不能把每个「跟注 20」「看牌」都列出来 ——
   *    5 手 × 9 人 × 每手十几条动作,一段记忆就上千 token,每手都要付。
   *    只留有信息量的:谁主动下注/加注(那才是「读人」的依据)、有人弃牌时提一句、
   *    谁赢了多少;纯跟注看牌不逐个列,只留最后一行「XX 等 N 人也跟」表示有这些人参与。
   *    6 人桌实测:压缩后一段记忆约 400 字(而不是 2000+)。
   */
  formatHandDelta(h, names = {}) {
    const nm = (seat) => names[seat] || `座位${seat + 1}`;
    const parts = [];
    // 按街归并
    let cur = null;
    const buckets = [];
    for (const a of (h.actions || [])) {
      if (/^【/.test(a)) { cur = { street: a.replace(/[【】]/g, ''), items: [] }; buckets.push(cur); }
      else { if (!cur) { cur = { street: null, items: [] }; buckets.push(cur); } cur.items.push(a); }
    }
    for (const b of buckets) {
      const keep = [];
      const passive = new Set();
      for (const it of b.items) {
        // 加注/下注:一定留(最有信息量)
        if (/加注到|下注|全下/.test(it)) { keep.push(it); continue; }
        if (/弃牌/.test(it)) { keep.push(it); continue; }
        // 跟注/看牌:只记「谁跟了」,不记金额(金额信息量低,而且会让行变长)
        const m = it.match(/^(\S+?)\s*(跟注|看牌)/);
        if (m) { passive.add(m[1]); continue; }
        keep.push(it);
      }
      let seg = b.street ? `${b.street} ` : '';
      seg += keep.join('、');
      if (passive.size) seg += (seg.endsWith(' ') || !keep.length ? '' : ';') + `${[...passive].join('、')} 跟/看`;
      if (seg.trim()) parts.push(seg);
    }
    let s = `  第 ${h.handNo} 手(${h.type === 'showdown' ? '摊牌' : '没跟到底'}): `;
    s += parts.length ? parts.join(' | ') : '(没有动作)';
    if (h.showdown?.length) {
      s += ` | 亮牌: ${h.showdown.map((x) => `${x.name} ${(x.hole || []).map(cardText).join('')}`).join('、')}`;
    }
    if (h.winners?.length) {
      s += ` | ${h.winners.map((w) => `${nm(w.seat)} 赢 ${w.amount}`).join('、')}`;
    }
    return s;
  }

  /**
   * 该不该现在写笔记。
   * @param {number} handNo 刚结束的手数
   * @param {number} [every] 每几手写一次(默认取 cfg.notesEvery,默认 3)
   */
  shouldWriteNotes(handNo, every) {
    const n = Number(every ?? this.cfg?.notesEvery ?? 3);
    if (!Number.isFinite(n) || n <= 0) return false;   // 0/负数 = 关掉
    return handNo > 0 && (handNo - this.notesHandNo) >= n;
  }

  /** 写笔记这一问的提示词(不含系统提示词的风格部分,由调用方拼) */
  buildNotePrompt(memory, recentCount = 3) {
    const hands = (memory?.recentHands || []).slice(-recentCount);
    const opps = (memory?.opponents || []).filter((o) => o.seat !== this.seat);
    const out = [];
    out.push('这一手打完了。现在**不要做任何决策**,只做一件事:更新你对桌上每个人的判断。');
    out.push('');
    out.push(`你是「${this.name}」。下面是刚刚打完的 ${hands.length} 手的公开过程:`);
    if (!hands.length) out.push('  (没有拿到过程记录)');
    for (const h of hands) out.push(this.formatHandDelta(h, memory?.opponentNames || {}));
    out.push('');
    if (Object.keys(this.notes).length) {
      out.push('你之前写的笔记(可以保留、修正、推翻 —— 有了新证据就以新的为准):');
      for (const [k, v] of Object.entries(this.notes)) out.push(`· ${k}: ${v}`);
    } else {
      out.push('你之前还没有写过笔记。');
    }
    out.push('');
    out.push('规则(务必遵守):');
    out.push('① **笔记必须用中文写**(不要英文,不要中英混杂)。');
    out.push('② 只根据**你看得到的公开信息**下判断 —— 谁下了多少、谁弃牌、谁摊牌亮了什么。');
    out.push('   不要猜别人的具体底牌,更不要编造:「他有一对 A」这种写法是错的。');
    out.push('③ 每人最多 40 字,一句话说清「他打牌有什么倾向」+「我该怎么对付他」。');
    out.push('④ 有把握才写。没有新观察就保留原来的判断;完全没线索就写「暂无观察」。');
    out.push('⑤ 必须覆盖下面名单里的每个人(已有的判断也照抄进去,这样才不会丢)。');
    out.push('');
    out.push('名单: ' + (opps.map((o) => o.name).join('、') || '(没有对手)'));
    out.push('');
    out.push('只输出 JSON,不要别的:');
    out.push('{"notes":{"名字":"一句话判断", ...}}');
    return out.join('\n');
  }

  /**
   * 从模型输出里解析笔记。
   *
   * @param {string} raw 模型原始输出
   * @param {string[]} [allowedNames] 只接受这些名字作为键。
   *   这一层很关键:散文兜底会把「第8手」「对付」「总结」这类东西也当成键收进来
   *   (实测出现过,整份笔记被污染)。有了白名单,只认真正的对手名。
   */
  parseNotes(raw, allowedNames) {
    const text = String(raw || '');
    const allow = Array.isArray(allowedNames) && allowedNames.length
      ? new Set(allowedNames.map((n) => String(n).replace(/["'「」\s]/g, '')))
      : null;
    const accept = (name, val) => {
      if (!name || !val) return false;
      if (allow && !allow.has(name)) return false;
      // 名字长度也得像个人名,挡掉「第 8 手」这种
      if (name.length > 12 || /\d/.test(name)) return false;
      return true;
    };
    const out = {};
    let jsonText = text.trim();
    const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) jsonText = fence[1].trim();
    // 退一步:直接找第一个 { 到最后一个 }
    if (!jsonText.startsWith('{')) {
      const a = jsonText.indexOf('{'); const b = jsonText.lastIndexOf('}');
      if (a >= 0 && b > a) jsonText = jsonText.slice(a, b + 1);
    }
    let obj = null;
    try { obj = JSON.parse(jsonText); } catch { obj = null; }
    const src = obj?.notes || obj?.observations || (obj && typeof obj === 'object' ? obj : null);
    if (src) {
      for (const [k, v] of Object.entries(src)) {
        const name = String(k).replace(/["'「」\s]/g, '');
        const val = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
        // ⚠️ **必须是中文**。模型偶尔会把笔记写成英文
        //    (实测出现过 "Hands 8,9,10 all involved, showdown J5o… keeps calling")——
        //    那种笔记会**直接影响后面的决策**,而思考气泡里的英文是被挡掉的,
        //    等于一条看不见的英文指令在操纵牌局。这里直接拒收。
        if (accept(name, val) && this._looksChinese(val)) out[name] = val;
      }
    }
    // 兜底:模型有时不给 JSON,而写成一行一条的散文(「小林: 偏松被动」)。
    // 这种情况整条丢掉太可惜 —— 笔记是每 3 手才写一次的长期记忆。
    // 只在 JSON 完全没解析出东西时启用,而且要求至少两条,免得把废话当成笔记。
    if (!Object.keys(out).length) {
      const plain = {};
      for (const line of text.split(/[\n;；]/)) {
        const m = line.match(/^\s*[-*·\d.、]*\s*([^\s:：,，]{1,12})\s*[:：]\s*(.+?)\s*$/);
        if (!m) continue;
        const name = m[1].replace(/["'「」]/g, '');
        const val = m[2].replace(/\s+/g, ' ').trim().slice(0, 60);
        if (val.length >= 2 && accept(name, val) && this._looksChinese(val)) plain[name] = val;
      }
      if (Object.keys(plain).length >= 2) return plain;
    }
    return out;
  }

  /** 判断一段文字是不是「中文为主」(笔记只收中文,见 parseNotes 里的说明) */
  _looksChinese(s) {
    const str = String(s);
    const han = (str.match(/\p{Script=Han}/gu) || []).length;
    const letterish = str.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '').length;
    return han >= 2 && han / Math.max(1, letterish) >= 0.3;
  }

  /**
   * 让这个 AI 更新它的读人笔记。跨手调用,不参与牌局推进。
   *
   * @param {object} memory 由 app 组装:{ recentHands, opponents, opponentNames }
   * @param {number} handNo 刚结束的手数
   * @returns {Promise<boolean>} 是否成功更新
   */
  async writeNotes(memory, handNo) {
    this.memory = memory;
    const recentCount = Number(this.cfg?.notesRecentHands ?? 3);
    const user = this.buildNotePrompt(memory, recentCount);
    // 笔记调用不需要「思考给人看」——用空 hook 把流式引开,
    // 否则笔记的片段会串到牌桌气泡上。
    const quiet = { onThink: null, onError: null, onTruncated: null };
    // 写笔记的 token 预算要比决策大一些:
    // 这个模型(deepseek-flash)会先用 reasoning_content 想一大段,
    // 那段也吃 max_tokens。预算小了就会出现「推理写完了、正式 JSON 没吐出来」——
    // 实测原始输出停在半句英文推理上,笔记直接丢掉(踩过)。
    //
    // ⚠️ 为什么地板是 3000 而不是 1800:笔记是**一整个 JSON,要覆盖名单上的每个人**
    //    (6 人桌 5 个对手 × 最多 40 字 ≈ 300~500 token 的正文),再加一段推理草稿。
    //    1800 在对手多、笔记已经攒了几轮(每次都要把旧笔记抄回去)的时候只剩几百 token
    //    给正文,截断一次就白写一次 —— 而它是每 3 手才有一次的长期记忆,丢了很可惜。
    //    3000 是「推理 + 全部对手的一句话」都装得下的值,且只在每 N 手触发一次。
    const noteBudget = Math.max(Number(this.cfg?.maxTokens) || 2000, 3000);
    const missing = () => {
      this.stats.noteFailures++;
      this.hooks.onDebug?.(`[notes] seat${this.seat} 解析失败,原始输出: ${String(this.lastNoteRaw || '').slice(0, 200)}`);
    };
    const attemptOnce = async () => {
      const raw = await this.callLLM(this.buildNoteSystemPrompt(), user, null, quiet, { maxTokens: noteBudget });
      this.lastNoteRaw = String(raw).slice(0, 400);
      const allowed = (memory?.opponents || []).map((o) => o.name).filter(Boolean);
      return this.parseNotes(raw, allowed);
    };
    try {
      let parsed = await attemptOnce();
      let keys = Object.keys(parsed);
      if (!keys.length) {
        // 重试一次:模型偶发会飘成英文推理、把 JSON 挤掉。
        // 笔记是每 3 手才写一次的长期记忆,丢一次可惜,值得多花一次调用。
        parsed = await attemptOnce();
        keys = Object.keys(parsed);
      }
      if (!keys.length) {
        missing();
        return false;   // 失败静默:保留旧笔记
      }
      // 合并:新笔记覆盖同名,旧的没提到的保留(避免一次失败就把认知清空)
      for (const [k, v] of Object.entries(parsed)) this.notes[k] = v;
      this.notesHandNo = handNo;
      this.stats.noteWrites++;
      return true;
    } catch (err) {
      this.stats.noteFailures++;
      this.lastNoteError = err?.message || String(err);
      this.hooks.onDebug?.(`[notes] seat${this.seat} 请求失败: ${this.lastNoteError}`);
      return false;   // 失败静默:保留旧笔记,绝不影响牌局
    }
  }

  /** 写笔记用的系统提示词(只保留身份,不要决策相关的风格长篇) */
  buildNoteSystemPrompt() {
    const p = this.persona || {};
    return [
      `你是德州扑克牌手「${p.name || '无名'}」,性格:${p.tag || '普通'}。`,
      '你正在整理这局牌里对同桌每个人的观察。',
      '只写你有证据的判断,不确定就说不确定。不要编造任何人的底牌。',
      '只输出 JSON。',
    ].join('\n');
  }

  /** 筹码档位说成人话 */
  _statusText(status) {
    return {
      short: '短码(<10 个大盲,再被盲注磨两圈就没了)',
      medium: '中码(10~25 个大盲,还能周转但经不起一次大失误)',
      deep: '深码(>25 个大盲,有资本施压)',
      // 「全下」和「已出局」都会显示成 0 个大盲,必须说清楚是哪一种 ——
      // 混起来会让 AI 以为全下的人已经退场(踩过这个坑,见 stackSituation 的注释)
      allin: '**已全下**(筹码全在底池里,人还在这一手,赢了就能翻回来)',
      out: '已出局(这局已经结束)',
    }[status] || '未知';
  }

  /** 给自己一句「离出局还有多远」的判断 */
  _dangerText(view, me) {
    if (!me?.status) return '';
    if (me.status === 'out') return ' —— 你已经没筹码了。';
    // 全下的人本来就不该被问话(引擎会跳过),这里只是兜底,避免落到
    // 下面那句「你有资本施压」——对一个筹码全在池子里的人来说完全反了。
    if (me.status === 'allin') return ' —— 你已经全下,这一手不需要再动作了。';
    if (me.status === 'short') {
      const others = (view.aliveCount || 0) - 1;
      return ` —— **你现在最怕的是被盲注磨死**(还有 ${others} 个对手)。`
        + '别用边缘牌跟注磨蹭:要么弃,要么等一手好牌直接全下翻倍。';
    }
    if (me.status === 'medium') return ' —— 正常打,但别为了一个小池押上半个身家。';
    if (me.rank === 1) return ' —— 你是筹码王,可以施压;但别用边缘牌去接别人的全下,输一次就把优势送回去。';
    return ' —— 你有资本施压,挑筹码比你浅的人下手。';
  }

  /** 这个 AI 实际在用的模型(界面与日志用) */
  get modelLabel() {
    if (!this.cfg?.enabled) return '本地策略';
    const name = this.cfg?.provider?.name || this.cfg?.providerId || this.cfg?.provider || '模型';
    return `${name}/${this.cfg?.model || '默认'}`;
  }

  /* ---------------------------------------------------------------- 调用 */

  /**
   * 让这个 AI 做决定。
   * @param {object} view 由 viewForSeat(seat) 生成的座位视角(只含它可见的信息)
   * @param {string[]} actionHistory
   * @param {{signal?:AbortSignal}} opts 外部中断信号(牌局重开时用来立刻掐断)
   * @returns {Promise<{action:string, amount?:number, thinking:string, source:'llm'|'fallback'}>}
   */
  async decide(view, actionHistory = [], opts = {}) {
    const fallback = () => {
      const d = fallbackDecide(view, this.persona);
      this.stats.fallback++;
      const thinking = `(本地策略)${d.note || ''}`.trim();
      return { action: d.action, amount: d.amount, thinking, say: localSay(d.action), source: 'fallback' };
    };

    if (!this.cfg?.endpoint || (!this.cfg?.apiKey && !this.cfg?.noKey)) {
      return fallback();
    }

    this.stats.decisions++;
    const system = this.buildSystemPrompt();
    const user = this.buildUserPrompt(view, actionHistory);
    const started = Date.now();

    /**
     * 这一次决策的重试上下文(只有一条死线,没有别的状态)。
     *
     * 为什么要显式往下传、而不是挂在 this 上:同一个 Agent 的**写笔记**是
     * fire-and-forget 的(app.js 在牌局结束时 Promise.resolve(writeNotes) 就撒手了),
     * 下一手随时可能开始 —— 挂在实例上的话两边的重试会互相踩,
     * 把「这一次决策已经等了多少」算错。
     *
     * 死线从**决策开始**算,而且是**唯一**一条:
     *   网络重试、截断重试、解析重试(没有可识别的动作 / 空回答)全都在它下面,
     *   三者叠加后的总时长被硬压在上限内,不会出现「每一层各自计时、叠起来等两分钟」。
     */
    const retryPolicy = resolveRetryPolicy(this.cfg);
    /**
     * 这一次决策的重试上下文(**唯一**一份计数与死线)。
     *
     * 网络失败、超时、截断、空回答、「没有可识别的动作」全都从这里的
     * session.attempts 里扣次数,上限都是 retryPolicy.times + 1。
     * 之所以要显式往下传而不是各写一个循环:两个循环叠加就是相乘的请求数
     * (1+3)×(1+3)=16,而一张桌子是轮流调用模型的,一个人卡住全桌一起等。
     */
    const retryCtx = { startedAt: started, deadline: started + retryPolicy.budgetMs };

    try {
      /**
       * 把「解析不出动作」也接进**同一个**重试会话 —— 这是本次改动的核心。
       *
       * 以前这一条在重试外壳**外面**:HTTP 成功了、只是文本里没有能解析出的动作,
       * 于是 decide() 立刻 return fallback(),一次就兜底(用户实测撞到的
       * 「Grok(grok-4.7) 调用失败:模型没有给出可识别的动作」)。
       * 但模型是随机的,同一条 prompt 重发一次经常就正常了,完全值得重试。
       *
       * 做法:给 callLLM 一个 validator —— 每拿到一次文本就问它「这次能用吗」。
       * 不能用的三种情况(截断 / 空回答 / 没有可识别的动作)由外壳统一重试,
       * 次数和死线与网络失败**共用**。这样一次决策最多还是 1 + times 次尝试,
       * 不管是网络失败、解析失败还是两者混合(这是最容易被做坏的地方:
       * 一旦各写一条重试循环,上限就变成相乘的 16 次)。
       */
      const raw = await this.callLLM(system, user, opts.signal, null, {
        retryCtx,
        validator: () => this._validateDecision(this.lastTruncated),
      });

      const elapsed = Date.now() - started;
      return this._parseDecision(raw, elapsed, view, fallback);
    } catch (err) {
      /**
       * 取消(**牌局重开 / 退出 / 改规则**)不是「模型失败」。
       *
       * 为什么单独一条:那条路上层的 stale() 判定会把这个结果整个丢掉,
       * 但**提示还是会弹**——用户刚点完「重开」就收到「XX 调用失败,本手先用本地策略」
       * 会以为是新的一局出了问题。而且重试外壳已经保证取消后一个请求都不会再发,
       * 这里只是别把它记成一次错误(也不该进 stats.errors,那会让统计失真)。
       *
       * 注意判据是「信号已中止」而不是错误文本:api 那条路把超时和取消写成同一句
       * 「请求超时或被取消」,只看文本会把正常的超时也吞掉。
       */
      if (err?.canceled || opts.signal?.aborted) {
        this.hooks.onDebug?.(`[座位${this.seat + 1}] ${err?.message || CANCEL_MESSAGE},不再重试`);
        return fallback();
      }
      this.stats.errors++;
      /**
       * 走到这里说明**连重试都救不回来**(次数用完 / 预算见底 / 配置性错误)。
       *
       * 解析失败那条路的文案要维持原样(用户熟悉、日志与测试都按它来):
       * 「模型没有给出可识别的动作,已改用本地策略」。外壳抛出来的消息里
       * 已经带了更准的说明(空回答 / 截断),所以这里只在后面补一句
       * 「已改用本地策略」,不另写一套措辞。
       */
      const msg = err?.llmParseFail
        ? `${err.message},已改用本地策略`
        : (err?.message || String(err));
      this.hooks.onError?.({ seat: this.seat, message: msg, raw: err?.llmParseFail ? err.raw : undefined });
      return fallback();
    }
  }

  /**
   * 重试外壳每拿到一次文本,就问这里一句:这次的回答**能用**吗?
   *
   * 返回 `{ verdict:'truncated'|'empty'|'action' }` 表示不能用(外壳据此重试),
   * 返回 null 表示能用。
   *
   * 为什么不让它顺手把动作也解析出来:外壳只该管「值不值得再发一次」,
   * 真正的解析必须**只此一处**(_parseDecision)—— 同一份 JSON 在两个地方
   * 各解析一次,迟早会漂成两种行为(这个仓库已经栽过两次这种坑)。
   *
   * 三种不能用的回答对应**不同**的重试发法(见 _callWithRetry 里的判定):
   *   · truncated —— 截断(只有推理、没有正式回答):额度翻倍 + 关掉推理通道,
   *                  治的是病因,所以走那条「翻倍」的路;
   *   · empty     —— HTTP 200 但一个字都没有:原样重发(纯随机,重发经常就有);
   *   · action    —— 有内容、但里面没有能解析出的动作:原样重发。
   * 后两种不是截断,不该翻倍额度(翻倍也治不了「模型不听话」)。
   */
  _validateDecision(truncated) {
    const text = this._lastRaw;
    if (truncated) return { verdict: 'truncated' };
    if (!String(text || '').trim()) return { verdict: 'empty' };
    const parsed = extractJson(text);
    const action = parsed
      ? normalizeActionWord(parsed.action ?? parsed.move ?? parsed.decision)
      : normalizeActionWord(text);
    if (!action) return { verdict: 'action' };
    return null;
  }

  /**
   * 把模型输出解析成决策 —— **只此一处**。
   *
   * 抽出来是为了让「两条调用路径 + 重试」都只经过同一份解析:
   * 以前解析写在 decide() 里,而重试外壳在 callLLM 里,两者对「什么算可用」
   * 只能各判一次(validator 判一次、这里再解析一次)。现在 validator 只做
   * 「能不能用」的粗判,真正的解析仍然只有这一个函数,不会漂。
   */
  _parseDecision(raw, elapsed, view, fallback) {
    const parsed = extractJson(raw);
    let action = null, amount, thinking = '', say = '';

    if (parsed) {
      // ⚠️ thinking 必须过 cleanThinking:有的模型不守「一到两句中文」的约定,
      //    会把整段带 markdown 的推理草稿倒进这个字段,而它是**原样给玩家看**的
      //    (界面那层只清 JSON 语法与英文格式指令,不认 markdown)。
      //    详见 cleanThinking 的注释。
      thinking = cleanThinking(parsed.thinking ?? parsed.reasoning ?? parsed.reason ?? '');
      say = cleanSay(parsed.say ?? parsed.speech ?? parsed.talk ?? parsed.line);
      action = normalizeActionWord(parsed.action ?? parsed.move ?? parsed.decision);
      amount = Number(parsed.amount ?? parsed.raiseTo ?? parsed.to ?? parsed.bet ?? 0) || undefined;
    } else {
      // 没有 JSON:退一步,从纯文本里找动作词。
      // 这段是「推理原文当答案」的下场(见 callLLMDirect 里 `full || reasoning` 的说明),
      // 同样过一遍清洗(上限沿用旧的 120 字,不改这条兜底路径的既有行为)。
      action = normalizeActionWord(raw);
      thinking = cleanThinking(raw, 120);
    }

    if (!action) {
      /**
       * 正常情况到不了这里:没有可识别的动作会被 validator 拦在重试外壳里,
       * 重试满 times 次之后以**抛错**的形式出来(见上面 catch 里那段)。
       * 留这一条是纯防御:万一将来有人绕过外壳直接调它,
       * 也不能把 action=null 交给引擎(那正是「旧决策被 act 到新引擎上」的链条)。
       */
      this.stats.errors++;
      this.hooks.onError?.({ seat: this.seat, message: '模型没有给出可识别的动作,已改用本地策略', raw: String(raw).slice(0, 200) });
      return fallback();
    }

    // 极端情况:模型要求加注但金额离谱 → 交给引擎规范化(引擎会把非法的降级)
    this.stats.llmOk++;
    const decision = { action, amount, thinking: thinking || '…', say, source: 'llm', elapsedMs: elapsed };
    this.hooks.onDecision?.(decision);
    this.history.push({ handNo: view.handNo, street: view.street, action, amount });
    return decision;
  }

  /**
   * 发起请求。
   * 优先走 Electron 主进程代理(绕开 CORS、Key 不进页面、天然支持各家流式格式);
   * 在没有 window(纯 Node 测试/脚本)时退回直连 fetch。
   *
   * ⚠️ **重试外壳套在两条路径之外**(见下面的 sendOnce 与 _callWithRetry)。
   *    这个仓库出过两次「只在 callLLMDirect(纯 Node 测试走的那条路)里加逻辑,
   *    真实游戏走的 api.llmChat 那条没有」的事故(参数降级、截断检测),
   *    表现都是「测试全绿、游戏里没生效」。所以重试只写一份,两条路径都必须经过它。
   *
   * @param {object} [overrides] 覆盖 cfg 的字段(maxTokens / requestExtra / timeoutMs …)。
   *   这里还接受两个**不会传给调用层**的东西(拆出来是为了别把它们混进 cfg):
   *     · retryCtx  —— decide() 建好的「一次决策的重试上下文」(死线 + 次数 + 已摘参数);
   *     · validator —— 每次拿到文本后问一句「这次能用吗」(见 _validateDecision)。
   *       它让「解析不出动作 / 空回答」也走这同一条重试,而不是另起一个循环。
   */
  async callLLM(system, user, externalSignal, hookCtx, overrides) {
    const { retryCtx, validator, ...over } = overrides || {};
    const cfg = { ...this.cfg, ...over };
    const providerId = providerIdOf(cfg);
    // hookCtx 用来把「写笔记」这类**非决策**调用的流式回调引开 ——
    // 否则笔记的流式片段会被当成思考喂进牌桌上的气泡(串台)。
    const hooks = hookCtx || this.hooks;
    const api = globalThis.window?.pokerAPI;

    /**
     * 「一次逻辑尝试」。
     *
     * 它内部还可能因为**参数降级**多发 1~3 个 HTTP 请求 —— 那是另一套机制
     * (unsupportedParamIn + omit),与网络重试**正交**:
     *   · 参数降级解决的是「这次请求的报文不对,摘掉那个字段就能成」;
     *   · 网络重试解决的是「这次尝试整体失败了(超时/5xx/过载),值不值得再来一次」。
     * 所以这里只做一次尝试,重试在外层。**不要**在这里面再套一层重试,
     * 否则「参数降级 × 网络重试」会相乘成十几次调用。
     */
    const sendOnce = async (attemptTimeoutMs, attemptNo, session, attemptCfg) => {
      // `attemptCfg` 是外壳按这一趟的语义算好的请求参数(见 _callWithRetry):
      // 平时就是 cfg;截断重试那一趟会带**翻倍后的 maxTokens**(以及 deepseek 的
      // thinking=disabled)。用 cfg 会让翻倍在真实路径上悄悄失效 ——
      // 「截断重试没治住病因」正是这么来的。
      const cfg2 = attemptCfg || cfg;
      if (api?.llmChat) {
        // requestId 每次都不同(t{尝试序号}):上一次尝试超时/被中断后,
        // 主进程那边的 abort 记录已经删掉了,复用同一个 id 万一撞上新的请求,
        // llmAbort 会误杀一个新请求。
        const requestId = `${this.seat}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          + (attemptNo ? `-t${attemptNo}` : '');
        const onAbort = () => { try { api.llmAbort(requestId); } catch { /* ignore */ } };
        if (externalSignal) {
          if (externalSignal.aborted) throw canceledError();
          externalSignal.addEventListener('abort', onAbort, { once: true });
        }
        try {
          /**
           * 参数降级重试 —— **真实游戏走的就是这条路**。
           *
           * ⚠️ 以前降级只写在下面的 callLLMDirect(纯 Node 测试用)里,
           *    这条网页版 / 桌面版真正走的路径没有:测试里模型不认 temperature 会自动摘掉重试、
           *    测试全绿;游戏里同样的报错直接 400、退回本地策略。
           *    这就是「中转站大部分模型调用失败」一直查不出来的原因。
           */
          // 已摘掉的字段从 session 里带过来(不是空数组):模型不认某个参数是
          // **这个模型的属性**,不是这一次请求的属性 —— 每次重试都从零再踩一遍
          // 那个 400,「参数降级 × 网络重试」就叠成两倍的请求了(见 session.omit 的说明)。
          const seeded = (session?.omit || []).length;
          const omit = [...(session?.omit || [])];
          /**
           * 本次尝试的额度。外壳决定「截断后翻倍重发」时会把 session.doubled
           * 置上,所以这里要取**外壳算好的值**,不能写死 cfg.maxTokens ——
           * 写死的话翻倍在真实路径上根本不生效(截断重试又变成没治住病因)。
           */
          const maxTokens = Math.max(Number(cfg2.maxTokens) || 300, 1);
          let res;
          /**
           * 截断检测所需的两个计数。
           *
           * ⚠️ this.lastTruncated 以前**只有** callLLMDirect(Node 测试路径)会写,
           *    这条真实路径从来不写 —— 于是 decide() 里的「截断就重试一次」
           *    在游戏里永远不会触发(只有测试能触发),又是一处
           *    「测试全绿、游戏里没生效」。所以这里也把它算出来。
           *    判据与直连路径一致:只来了推理、正式回答一个字都没有。
           */
          let sawReasoning = false;
          let sawAnswer = false;
          for (let attempt = 0; ; attempt++) {
            res = await api.llmChat({
              requestId: attempt ? `${requestId}-r${attempt}` : requestId,
              provider: providerId,
              kind: cfg.kind,
              endpoint: cfg.endpoint,
              apiKey: cfg.apiKey || '',
              model: cfg.model,
              system,
              user,
              temperature: cfg.temperature ?? 1.1,
              maxTokens,
              // 本次尝试的超时由重试外壳算(不会超过剩余预算,见 _callWithRetry)——
              // 写死 cfg.timeoutMs 的话,第一次超时 45s 之后第二次还能再等 45s,
              // 总时长就冲破上限了。
              timeoutMs: attemptTimeoutMs,
              // 推理档位(off/low/default)。必须透传:这个值决定四条协议各自发什么
              // 思考参数(见 shared/llmStream.mjs 的 REASONING_LEVELS)。
              // ⚠️ timeoutMs / maxTokens 当年就是因为 agentCfg 没传而变成死字段 ——
              //    新加配置项时一定要顺着「界面 → 配置 → agentCfg → 这里」走一遍。
              reasoningLevel: cfg.reasoningLevel,
              // 厂商特有的请求参数(例如 reasoning_effort)。
              // 透传下去之后由 buildRequest 合并进请求体 —— 它放在最后合并,
              // 所以既覆盖厂商默认,又不用为每个厂商写分支。
              requestExtra: cfg2.requestExtra,
              omit: omit.length ? [...omit] : undefined,
            }, {
              // 第三个参数 thinking:true 表示这是「推理阶段」的增量(界面可弱化显示)
              onDelta: (delta, full, thinking) => {
                if (thinking) sawReasoning = true; else sawAnswer = true;
                hooks.onThink?.(delta, full, thinking);
              },
            });
            if (res?.ok) break;
            const bad = unsupportedParamIn(res?.error);
            if (bad && !omit.includes(bad) && omit.length < 3 && !externalSignal?.aborted) {
              omit.push(bad);
              if (session) session.omit = [...omit];   // 记给本次决策的后续尝试
              continue;
            }
            // 带上状态码:重试外壳靠它判断值不值得再试(401/403 直接兜底,5xx/429 重试)
            throw llmFail(res?.error || '请求失败', res?.status);
          }
          // 只有**这一次尝试新摘掉**了字段才提示:同一句提示在每次重试后重复刷
          // 只会让人以为出了新问题。
          if (omit.length > seeded) {
            this.hooks.onError?.({
              seat: this.seat,
              message: `这个模型不认 ${omit.join(' / ')},已自动去掉后重试成功`,
              level: 'info',
            });
          }
          // 与 callLLMDirect 的判据保持一致(见那边的注释)
          this.lastTruncated = (!sawAnswer && sawReasoning)
            ? {
              seat: this.seat, reason: 'length',
              note: `模型把 ${maxTokens} 个 token 全用在推理上了,正式回答被截断`,
              reasoningChars: (res.reasoning || '').length,
              suggestedMaxTokens: Math.max(1200, maxTokens * 3),
            }
            : null;
          if (this.lastTruncated) this.hooks.onDebug?.(`[座位${this.seat + 1}] ${this.lastTruncated.note}`);
          return res.text || '';
        } finally {
          if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
        }
      }
      // 纯 Node(测试 / 脚本):直连 fetch。超时按**本次尝试**的预算传下去 ——
      // 与上面那条路同一个来源,否则两条路的重试时长会不一样。
      // session 也传下去(dropped 的续用规则必须两条路一致,见 callLLMDirect)。
      // ⚠️ 这里必须用 attemptCfg(而不是 cfg):截断重试那一趟的翻倍额度与
      //    thinking=disabled 全靠它带下去 —— 漏掉就又变成「测试全绿、游戏里没生效」。
      return this.callLLMDirect(system, user, externalSignal, { ...cfg2, timeoutMs: attemptTimeoutMs }, session);
    };

    return this._callWithRetry(sendOnce, { cfg, externalSignal, hooks, retryCtx, validator });
  }

  /**
   * 重试外壳 —— **两条调用路径共用同一份**。
   *
   * 为什么单独抽出来:参数降级和截断检测都曾经只加在一条路上(测试走的那条),
   * 于是「测试全绿、游戏里照样失败」。重试是新加的一层,绝不能再犯第三次,
   * 所以它只有这一个实现,api.llmChat 与 callLLMDirect 都必须从它下面过。
   *
   * 三条约束按优先级:
   *   ① 取消 > 一切:牌局重开 / 退出 / 改规则后**立刻**停,不再发新请求,
   *      也绝不把结果交给调用方去 act(那正是「旧决策被 act 到新引擎上」的链条)。
   *   ② 总时长上限(deadline):一次决策累计到点就兜底,不允许全桌停等两分钟。
   *   ③ 次数上限(attempts):**一次决策**一共最多 1 + policy.times 次尝试。
   *
   * ⚠️ ③ 是按**决策**算的,不是按每次 callLLM 算的 —— 这是刻意的:
   *    一次决策里现在有三种「失败」都要重试(网络失败 / 截断 / 解析不出动作),
   *    如果各写一条循环、各自计数,就是 4 × 4 = 16 个请求。所以它们全部从
   *    同一个 session.attempts 里扣次数、共用同一条死线。
   *    「一次决策最多 1 + times 次尝试(默认 4)」这句话就是靠这里成立的。
   *
   * @param {(timeoutMs:number, attemptNo:number, session:object)=>Promise<string>} sendOnce
   * @param {{cfg:object, externalSignal?:AbortSignal, hooks:object, retryCtx?:object,
   *          validator?:()=>({verdict:string}|null)}} ctx
   *   retryCtx 由 decide() 建好并透传:{ startedAt, deadline }。
   *   validator 每次**成功**拿到文本后调用(见 decide 里给的那个):
   *     返回 null 表示这次回答能用,直接交给调用方;
   *     返回 { verdict } 表示 HTTP 成功但内容不可用 —— 也当成一次失败来重试。
   */
  async _callWithRetry(sendOnce, { cfg, externalSignal, hooks, retryCtx, validator }) {
    const policy = resolveRetryPolicy(cfg);
    const session = retryCtx || { startedAt: Date.now(), deadline: 0, attempts: 0, omit: [] };
    if (!session.startedAt) session.startedAt = Date.now();
    if (!session.deadline) session.deadline = session.startedAt + policy.budgetMs;
    if (!session.omit) session.omit = [];
    if (!Number.isFinite(session.attempts)) session.attempts = 0;
    /**
     * 「额度翻倍 + 关掉推理通道」这一趟最多只发一次(见下面截断那条分支)。
     * 记在 session 上而不是本函数的局部变量:session 是本次决策的共享状态,
     * 万一将来有别的入口带着同一个 session 再进来一次,也不会翻倍两次。
     */
    if (session.doubled === undefined) session.doubled = false;
    const startedAt = session.startedAt;
    const deadline = session.deadline;
    const maxAttempts = policy.times + 1;
    const timeoutDefault = Number(cfg?.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 45000;
    let lastErr = null;

    for (;;) {
      if (externalSignal?.aborted) throw canceledError();

      const remaining = deadline - Date.now();
      if (session.attempts > 0 && remaining <= RETRY_MIN_HEADROOM_MS) {
        // 预算见底:发出去也几乎必然再超时,只剩"让全桌多等一次"——
        // 用户宁可这一手用本地策略(见 config.cjs 里 timeoutMs 的注释)。
        hooks.onDebug?.(`[座位${this.seat + 1}] 重试预算用尽(已等 ${Math.round((Date.now() - startedAt) / 1000)}s),不再重试`);
        break;
      }
      if (session.attempts >= maxAttempts) {
        // 这一次决策的尝试次数已经用完 —— 兜底,不再烧调用
        hooks.onDebug?.(`[座位${this.seat + 1}] 本次决策已试 ${session.attempts} 次(上限 ${maxAttempts}),不再重试`);
        break;
      }
      const attemptNo = session.attempts;
      session.attempts += 1;
      /**
       * 截断重试与网络重试的分工(重要,别做坏):
       *
       *   截断是**唯一有病因疗法**的失败 —— 病因是 reasoning_content 和正式回答
       *   共用 max_tokens,所以治法就是「额度翻倍 +(DeepSeek 系)关掉推理通道」。
       *   这个治法**只试一次**:连续两次都截断说明这个局面/模型真的给不出正式回答,
       *   再翻倍也只是继续烧调用,那就老实兜底(与本次改动前的行为一致)。
       *
       *   而「没有可识别的动作 / 空回答」**不是**截断病因,原样重发就可能好,
       *   所以它们按普通失败重试,次数同样从这个 session.attempts 里扣。
       *
       *   两条路都只是本循环里的不同**发法**,不是第二个循环 —— 所以
       *   「网络失败 × 截断 × 解析失败」怎么混合也还是 1 + times 次上限。
       *
       * `thinking: {type:'disabled'}` 只有 DeepSeek 系认。自定义中转站后面
       * 挂的是哪家模型完全不确定 —— 发了大概率被拒(现象就是「第一次成功、
       * 第二次失败」),所以对它**不发这个字段**,只靠额度翻倍达成同样的目的:
       * 把额度全留给正式回答。真遇到不认的厂商,参数降级还会兜一层。
       */
      const useDoubled = !!session.doubled;
      // 关掉推理通道只有 DeepSeek 系认,别的厂商发了大概率被 400 拒掉
      const canSkipThinking = providerIdOf(this.cfg) === 'deepseek';
      const mergeExtra = useDoubled && canSkipThinking
        ? { ...(cfg.requestExtra || {}), thinking: { type: 'disabled' } }
        : (cfg.requestExtra || null);
      const attemptCfg = useDoubled
        // 推理型模型(gpt-5 / Claude thinking / kimi-thinking)的草稿很长,额度要真的翻倍。
        // 默认额度 2000 → 这里 4000,仍然高于 2400 的地板(小额度配置下地板兜底)。
        ? { ...cfg, maxTokens: Math.max(2400, (cfg.maxTokens || 2000) * 2), requestExtra: mergeExtra }
        : cfg;
      // 单次尝试的超时**不超过剩余预算**,否则总时长一定会冲破上限
      //(「3 × 45s = 135s」就是这么来的)。
      const attemptTimeoutMs = Math.max(500, Math.min(timeoutDefault, remaining));
      try {
        this._lastRaw = await sendOnce(attemptTimeoutMs, attemptNo, session, attemptCfg);
        /**
         * HTTP 成功了,但「成功」不等于「能用」—— 内容还得过一遍 validator。
         * 这一层是本次改动的核心:以前判「有没有可识别的动作」在重试外壳**外面**,
         * 所以模型返回一段没动作的文本时一次就兜底了(用户实测撞到的那条)。
         * 现在它也在这里数次数、走退避、给用户提示,与网络失败共享同一个上限。
         */
        const bad = validator ? validator() : null;
        if (bad?.verdict) {
          lastErr = parseFailureError(bad.verdict, this._lastRaw);
          // 「翻倍额度」这一趟也救不回截断 → 立刻兜底,不再换发法、不再等退避
          //(与本次改动前的「截断只重试一次」一致:连续两次都截断是根本性问题)
          if (bad.verdict === 'truncated' && session.doubled) {
            hooks.onDebug?.(`[座位${this.seat + 1}] 额度翻倍之后仍然被截断,不再重试`);
            break;
          }
          // 截断且还没换过发法 → 下一趟用「额度翻倍 + 关掉推理通道」(见循环开头)
          if (bad.verdict === 'truncated' && !session.doubled) {
            session.doubled = true;
            hooks.onDebug?.(`[座位${this.seat + 1}] 截断,改用「额度翻倍${canSkipThinking ? ' + 关掉推理通道' : ''}」再发一次(第 ${session.attempts}/${policy.times} 次重试)`);
          }
        } else {
          if (attemptNo > 0) {
            hooks.onDebug?.(`[座位${this.seat + 1}] 第 ${attemptNo} 次重试成功(累计 ${Math.round((Date.now() - startedAt) / 1000)}s)`);
          }
          return this._lastRaw;
        }
      } catch (err) {
        lastErr = err;
      }

      /**
       * 取消要**先判**,而且不能只看错误文本。
       * api 那条路把「超时」和「用户取消」写成同一句「请求超时或被取消」——
       * 只看文本就会把「用户已经退出了」当成一次超时,然后继续重试,
       * 多发请求、还可能把旧决策交给新牌局。
       */
      const err = lastErr;
      if (err?.canceled || externalSignal?.aborted) throw canceledError();

      /**
       * 解析失败(HTTP 成功、内容不可用)是**无条件可重试**的:模型是随机的,
       * 同一条 prompt 重发一次经常就正常了。所以它不参与 classifyErrors
       * (那个开关的意思是「配置性错误别白试」,而对它没有「配置性」可言)。
       * fatal 与否只由 classifyLlmFailure 决定;解析失败那条路会返回 retryable。
       */
      const verdict = policy.classifyErrors ? classifyLlmFailure(err) : 'retryable';
      const left = deadline - Date.now();
      if (verdict === 'fatal' || session.attempts >= maxAttempts || left <= RETRY_MIN_HEADROOM_MS) break;

      // 第几次重试按**本次决策**数(不是本函数的循环序号):截断/解析重试接着往下数,
      // 用户看到的「第 2/3 次」和实际发了几个请求才对得上。
      const retryNo = session.attempts;
      const delay = Math.min(backoffFor(policy, retryNo - 1), left);
      /**
       * 让用户**看得见**在重试。
       * 重试期间界面上只有「思考中」,不说一声的话,一段静默和卡死没有区别 ——
       * 用户对「等了很久没反应」非常敏感(这条提示同时进 toast 与牌局记录,
       * 见 app.js 的 onError 处理:带 retry 标记的会写成 `↻ 名字(模型):…`)。
       */
      const note = `${retryReason(err)},${(delay / 1000).toFixed(1)}s 后重试(第 ${retryNo}/${policy.times} 次)`;
      hooks.onError?.({ seat: this.seat, level: 'info', retry: { attempt: retryNo, times: policy.times }, message: note });
      hooks.onDebug?.(`[座位${this.seat + 1}] ${note}`);
      // 退避这几秒里牌局完全可能被重开 —— sleepWithSignal 会被取消打断并抛出
      await sleepWithSignal(delay, externalSignal);
    }
    // 走到这里只有两种情况:尝试次数用完,或者预算见底。
    // 没有 lastErr 说明是「刚进来就发现预算不够」——给一句能看懂的说明,
    // 不要甩一个「模型调用失败」让用户以为模型自己坏了。
    throw lastErr || new Error('重试预算已用尽,不再等待模型');
  }

  /**
   * 纯 Node 环境下的直连实现(测试与脚本用)。
   *
   * @param {object} [session] 本次决策的重试上下文(见 _callWithRetry)。
   *   这里**只**用它的 omit:模型不认某个参数是模型自己的属性,一次决策里
   *   没必要每次重试都重新踩一遍那个 400(踩两次 = 参数降级 × 网络重试叠加)。
   *   与 api.llmChat 那条路用的是同一个 session,行为也就不会分叉。
   *   (额度翻倍 / 关掉推理通道不在这里判 —— 那是外壳按「这一趟是不是截断重试」
   *    算好之后通过 overrides 传进来的,两条路必须用同一份判断。)
   */
  async callLLMDirect(system, user, externalSignal, overrides, session) {
    const cfg = { ...this.cfg, ...(overrides || {}) };
    const controller = new AbortController();
    const timeoutMs = cfg.timeoutMs || 45000;
    /**
     * 这个请求是**我们自己的看门狗**掐断的,还是用户取消的?
     * 两种都是 AbortError,但含义完全相反:
     *   · 看门狗 → 一次「超时」,上层可以重试(上游抖动就是一过性的);
     *   · 用户取消 → 不许重试,必须立刻停。
     * 外部信号自己会 abort(见下),上层先查 externalSignal.aborted,
     * 所以这里只需要老实标出「是我掐的」。
     */
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    /**
     * ⚠️ 请求体和 SSE 解析**必须**走 shared/llmStream.mjs,不要在这里手写。
     *
     * 这里原来是一份手工复制的 buildRequest + parseSsePayload。后果很严重:
     * 参数降级/协议支持只加到其中一条路径上时,另一条路径静默不变 ——
     * 于是「Node 测试全绿、游戏里照样失败」(真的发生过:降级只加在了这份
     * 只有测试才走的代码里,而网页版/桌面版走 api.llmChat)。
     * 现在两条路径共用同一份构造与解析,只有「谁去发这个请求」不同。
     */
    sharedStreamMod = sharedStreamMod || await import('../shared/llmStream.mjs');
    sharedProvidersMod = sharedProvidersMod || await import('../shared/providers.mjs');
    const provider = sharedProvidersMod.getProvider(providerIdOf(cfg)) || {};
    const built = sharedStreamMod.buildRequest({
      kind: cfg.kind,
      endpoint: cfg.endpoint,
      apiKey: cfg.apiKey,
      model: cfg.model,
      system,
      user,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      // 推理档位与网页版/桌面版走同一个字段(见 callLLM 里那段说明)。
      // 这里漏掉的话,Node 路径(测试、脚本)与线上就不是同一份报文了。
      reasoningLevel: cfg.reasoningLevel,
      requestExtra: cfg.requestExtra,
    }, provider);
    if (built.error) {
      // 请求体都拼不出来(缺地址 / 缺 Key / 缺模型名)= 配置问题,
      // 标记成 fatal:重试三次只是白等 5 秒退避,配置不会自己变好。
      const e = llmFail(built.error);
      e.llmFatal = true;
      throw e;
    }
    const { url, headers, body: baseBody, kind } = built;

    /**
     * 发送 —— 带**参数降级重试**。
     *
     * 有些模型(尤其中转站后面的 o 系列 / gpt-5 系列)不认 temperature / max_tokens,
     * 会直接回 400。摘掉那个字段再发一次通常就通了,而且不影响别的模型。
     * 最多降级两次,避免拿坏请求死循环。
     *
     * ⚠️ 摘参数用的是 buildRequest 的 omit(而不是在这里 delete),
     *    这样「同义字段一起摘」的规则也只有一份 —— 手写 delete 时漏掉
     *    max_completion_tokens / max_output_tokens 是踩过的坑。
     *
     * ⚠️ `dropped` 的初值来自 session(本次决策已经摘过的字段),不是空数组:
     *    重试一次就重踩一遍同样的 400 = 把「参数降级」和「网络重试」叠起来,
     *    白白多发一半请求。api.llmChat 那条路用的是同一个 session.omit。
     *
     * ⚠️ 「发送 + 解析」整段都在下面这个 try 里(以前发送那段在 finally 外面):
     *    请求一失败(超时 / 5xx / 参数摘到不能再摘)就直接 throw 出去,
     *    **看门狗定时器和 abort 监听不会被清掉** —— 一个已经没用的 timer
     *    继续挂在事件循环上(最多 timeoutMs),测试里用 process.exit 收尾时
     *    还会撞上 libuv 的 UV_HANDLE_CLOSING 断言(退出码变成崩溃码,
     *    而汇总行明明写着 0 失败 —— 这种"看着全绿其实崩了"最难查)。
     *    重试让失败次数变多,这个坑会更容易踩到,所以顺手修掉。
     */
    const cleanup = () => {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    };
    try {
      const seeded = (session?.omit || []).length;
      const dropped = [...(session?.omit || [])];
      let res;
      for (let attempt = 0; ; attempt++) {
        const spec = {
          kind: cfg.kind, endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model,
          system, user, temperature: cfg.temperature, maxTokens: cfg.maxTokens,
          // ⚠️ 降级重试这条路也要带上档位,否则「重试时报文与首次不同」——
          //    推理块会因为漏传档位而凭空消失,测试看起来「降级成功」,
          //    实际测的是另一份报文(这个仓库已经栽过两次「两条路径各写一份」)。
          reasoningLevel: cfg.reasoningLevel,
          requestExtra: cfg.requestExtra, omit: dropped.length ? [...dropped] : undefined,
        };
        const sent = dropped.length ? sharedStreamMod.buildRequest(spec, provider) : built;
        try {
          res = await fetch(sent.url || url, {
            method: 'POST', headers: sent.headers || headers,
            body: JSON.stringify(sent.body || baseBody), signal: controller.signal,
          });
        } catch (err) {
          /**
           * 超时要给上层一个能认出来的说法:Node 的 AbortError 文本是
           * 「This operation was aborted」,靠它根本分不清是超时、是我们自己取消,
           * 还是别的什么被中断了 —— 而重试判据必须认得「超时」。
           * (用户取消不用在这里区分:上层先查 externalSignal.aborted。)
           */
          if (timedOut && !externalSignal?.aborted) {
            throw llmFail(`请求超时(${Math.round(timeoutMs / 1000)}s 没有响应)`);
          }
          throw err;
        }
        if (res.ok) {
          // 只有**这一次尝试新摘掉**了字段才提示(理由同 api 那条路:
          // 同一句提示在每次重试后重复刷,会让人以为又出了新问题)
          if (dropped.length > seeded) {
            this.hooks.onError?.({
              seat: this.seat,
              message: `这个模型不认 ${dropped.join(' / ')},已自动去掉后重试成功`,
              raw: '',
              level: 'info',
            });
          }
          break;
        }
        const errText = await res.text().catch(() => '');
        const bad = unsupportedParamIn(errText);
        if (bad && !dropped.includes(bad) && dropped.length < 2 && attempt < 2) {
          dropped.push(bad);
          if (session) session.omit = [...dropped];   // 记给本次决策的后续尝试
          continue;
        }
        throw llmFail(`接口返回 ${res.status}: ${errText.slice(0, 180)}`, res.status);
      }
      if (!res.body) throw llmFail('接口没有返回流式内容', res.status);

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let full = '';
      let reasoning = '';
      let finishReason = '';
      // 流里报出来的错误(共享解析器在 finish 事件上带出来的 error 字段)。
      // 这里以前只取 c.finish、把 c.error 丢了 —— 「HTTP 200 + 流里报错」于是变成
      // 「成功的空回答」,再经下面的 `full || reasoning` 兜底,最后表现成
      // 「模型没给出可识别动作」这种完全不指向病因的结论。原文必须带上去。
      let streamError = '';

      /**
       * 思考阶段的增量也要推给界面。
       *
       * 以 deepseek-flash 为例,一次请求的流是:
       *   先 137 字的 reasoning_content,再 23 字的 content(正式回答)。
       * 早期实现只对 content 调 onThink,于是**整个推理阶段界面一片空白**,
       * 用户看到的是「等很久 → 答案突然蹦出来」,完全不是「看着他想」。
       *
       * 现在:推理先流式显示(标记 thinking=true,界面可以显示得淡一些),
       * 正式回答到达时再接上,界面据此切换成最终文本。
       */
      const emitThink = (chunk, isReasoning) => {
        if (!chunk) return;
        if (isReasoning) reasoningChunks += 1; else answerChunks += 1;
        try { this.hooks.onThink?.(chunk, full, !!isReasoning); } catch { /* 界面出错不影响主流程 */ }
      };

      let reasoningChunks = 0;
      let answerChunks = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // 解析交给共享实现 —— 它与网页版/桌面版走的是同一个函数,
        // 新增协议(responses 等)只要改那一处,三条路径同时生效。
        buffer = sharedStreamMod.consumeSseBuffer(buffer, kind, (c) => {
          if (c.error) { streamError = String(c.error); return; }
          if (c.phase === 'finish') { if (c.finish) finishReason = c.finish; return; }
          if (c.phase === 'reasoning') { reasoning += c.reasoning; emitThink(c.reasoning, true); return; }
          if (c.phase === 'answer') { full += c.text; emitThink(c.text, false); }
        });
      }

      /**
       * 截断检测:推理把 max_tokens 吃光,正式回答一个字都没来。
       *
       * 这一条很容易被忽略 —— 界面上看是「思考了很久」,实际上模型根本
       * 没来得及给决策,后面的动作是从残缺的推理文本里硬猜出来的。
       * 实测 deepseek-flash 在默认 effort=high 下,复杂局面有 33% 的请求
       * 会这样(推理吃光 1200 token,finish_reason=length,回答 0 字)。
       *
       * 记在实例上,重试外壳靠它决定「这次算不算截断、要不要换发法重试」
       * (见 _callWithRetry 里读 lastTruncated 的那条分支;判据与 api 那条路一致)。
       * ⚠️ 用 cfg.maxTokens(本次尝试**实际**发出去的额度),不是 this.cfg ——
       *    截断重试那一趟额度是翻倍的,写 this.cfg 会把 4000 说成 2000。
       */
      this.lastTruncated = null;
      if (answerChunks === 0 && reasoningChunks > 0) {
        const cur = Number(cfg.maxTokens) || 300;
        const note = finishReason === 'length'
          ? `模型把 ${cur} 个 token 全用在推理上了,正式回答被截断`
          : '模型只输出了推理过程,没有给出正式回答';
        this.lastTruncated = {
          seat: this.seat, reason: finishReason, note,
          reasoningChars: reasoning.length, suggestedMaxTokens: Math.max(1200, cur * 3),
        };
        this.hooks.onTruncated?.(this.lastTruncated);
        this.hooks.onDebug?.(`[座位${this.seat + 1}] ${note}`);
      }
      // 流里报错就当失败抛出(原文带上),不能让下面那条兜底把错误吞成「有回答」。
      // 状态码从原文里捞(HTTP 200 的流里报错通常带着 "code":503 这类东西):
      // 重试外壳要靠它判断值不值得再试。
      if (streamError) throw llmFail(`上游流里报错:${streamError}`);
      // ⚠️ 这里 `|| reasoning` 是**有争议的兜底**:正式回答为空时把推理原文
      //    当答案交出去,调用方会拿英文散文去解析 JSON、失败后还可能从散文里
      //    猜出一个动作(实测猜出过 allin)。保留是为了还能抢救出一点信息,
      //    但外壳会先看 lastTruncated 并重试 —— 不要依赖这条兜底做决策。
      return full || reasoning;
    } finally {
      cleanup();
    }
  }
}

export { PokerAgent, fallbackDecide, preflopStrength, extractJson, normalizeActionWord, ACTION_LABEL, evaluate, describe, categoryKey, cleanThinking, classifyLlmFailure, resolveRetryPolicy, LLM_RETRY };
