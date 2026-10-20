'use strict';
/**
 * 扑克的 AI 玩家代理(**提示词 + 决策 + 本地兜底**)。
 *
 * 设计要点(对应「AI 必须相互独立、不能拥有对方信息」):
 *  1. 每个座位一个 Agent 实例,只持有自己的 callbacks 与历史,互不共享。
 *  2. 发给模型的提示词由 viewForSeat(seat) 生成 —— 那里只有自己的底牌与公开信息。
 *  3. 模型输出要求带一句「思考」,界面上逐字显示,这就是玩家看到的思考过程。
 *  4. 模型超时/报错/输出非法 → 用本地规则兜底,牌局永远不会卡住。
 *
 * ★ 2b 之后这个文件只管**扑克**:
 *   · 这里有的:系统/用户提示词、动作解析、本地兜底策略、发言漏牌检测、
 *     读人笔记的提示词、以及「这一手该怎么打」(decide)。
 *   · 这里**没有**的(已搬到 src/shared/llmCaller.mjs):网络重试、参数降级、
 *     截断检测、超时/取消、失败分类、JSON 抽取 —— 那些与游戏无关,
 *     写一次给所有游戏用(PokerAgent 继承 LlmCaller 即可)。
 */

import { cardText, rankOf, suitOf, RANK_LABEL } from './engine/cards.js';
import { evaluate, describe, categoryKey } from './engine/handEval.js';
// 「每条街的成牌」由**引擎**算好(与摊牌判定同一套 evaluate/describe,含短牌重排),
// 这里只负责把它写成牌桌上的中文。绝不在 agent 里再写一份牌型判定 ——
// 两份实现早晚会漂,而「提示词里的牌型名 ≠ 摊牌时的牌型名」是最难查的一类 bug。
import { handByStreet } from './engine/engine.js';
import { riskLabel } from './personas.js';
// 通用调用基座:重试 / 降级 / 超时 / 截断 / 失败分类都在这里(与扑克无关)。
// ⚠️ 下面这几个纯函数在本文件末尾**原样转发**出去 —— 仓库里已有测试与调试脚本
//    (retrytest / parseretrytest / trunctest …)本来就是从 agent 模块取它们的,
//    搬家只该改路径,不该顺手把它们能拿到的东西也搬走。
import {
  LlmCaller, LLM_RETRY, extractJson, classifyLlmFailure, resolveRetryPolicy,
} from '../../shared/llmCaller.mjs';
// 【你的最终目标】那一段(三个游戏共用同一份文案,只换数据)。
// 它是**平台级**的东西:不管玩哪个游戏,模型的目标都是「本场排名靠前」,
// 而不是赢下眼前这一小局 —— 所以不在这里另写一版。
import { matchGoalBlock } from '../../shared/leaderboard.mjs';

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

/**
 * 三条街在牌桌上的叫法。
 *
 * 引擎的 STREET_LABEL 写的是「翻牌 / 转牌 / 河牌」(界面顶栏要短),
 * 而这里说的是「**成牌是在翻牌圈成立的**」这种句子 —— 用户原话就是「翻牌圈」,
 * 所以这一段用带「圈」的说法,读起来更像牌桌上说的话。
 */
const STREET_CN = { flop: '翻牌圈', turn: '转牌圈', river: '河牌圈' };
const STREET_SEQ = ['flop', 'turn', 'river'];

/**
 * 「这个成牌是哪一街成的」+「每条街分别是什么」。
 *
 * 为什么非要有这一段(用户实测的第二个问题):
 *   原话是「AI 分不清 …是什么时候成的牌(比如翻牌圈就成的牌,牌圈也以为是刚成的牌)」。
 *   提示词里原本只有「你现在的成牌:两对 Q 与 10」,模型不知道它是**哪一街**拿到的,
 *   于是在转牌/河牌把一手早就在的牌说成「刚中」,跟着就把下注理由也编错了。
 *   现在明确写出「翻牌圈就成立了,转牌圈、河牌圈都没有改变它」;
 *   如果某一街真的改变了成牌,就写「转牌圈改变了你的成牌:从 X 变成 Y」。
 *
 * ⚠️ 只用**已经发出**的公共牌(逐街截断,见引擎的 handByStreet):
 *    不能用未来信息,否则 AI 就作弊了。
 * ⚠️ 底牌不全时返回 null:宁可不写,也不编(与 madeHandText 同一条规矩)。
 *
 * @param {object} view viewForSeat 的座位视角
 * @returns {{timing:string, streets:string}|null}
 */
function handTimingInfo(view) {
  const info = handByStreet(view?.me?.hole, view?.board, { shortDeck: !!view?.shortDeck });
  if (!info) return null;
  // 翻前:还没有公共牌,谈不上「哪一街成的」。但这句话也要给 ——
  // 否则模型会自己脑补一个「成牌时机」出来。
  if (!info.streets.length) {
    return {
      timing: '现在还是**翻牌前**,一张公共牌都没发,所以还谈不上「哪一街成的」;'
        + '等翻牌圈发出 3 张公共牌,才有成牌这一说',
      streets: '',
    };
  }
  const { formed, current, streets } = info;
  const later = streets
    .filter((s) => STREET_SEQ.indexOf(s.street) > STREET_SEQ.indexOf(formed.street))
    .map((s) => STREET_CN[s.street]);
  let timing;
  if (info.changedNow) {
    // 就是当前这一街(转牌/河牌)变的 —— 用户点名要的说法:「从 X 变成 Y」
    const from = info.prev ? `从「${info.prev.name}」(${STREET_CN[info.prev.street]})` : '从「还没成牌」';
    timing = `**${STREET_CN[current.street]}改变了你的成牌**:${from}变成「${current.name}」`;
  } else if (later.length) {
    // 早就在了,后面几街没有改变它 —— 这是最容易被模型说成「刚中」的情况
    timing = `这个成牌在**${STREET_CN[formed.street]}**就成立了,${later.join('、')}都没有改变它`
      + `(不是刚成的,别再当成新牌型)`;
  } else {
    // 翻牌圈一出来就成了(公共牌只有 3 张)
    timing = '这个成牌是**翻牌圈**成的(翻前还没有公共牌,翻牌一出来它就在了)';
  }
  const perStreet = streets.map((s) => `${STREET_CN[s.street]}「${s.name}」`).join(' → ');
  return { timing, streets: perStreet };
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

/* ==================================================================== *
 * 「说出口的那句话」不能漏牌 —— 确定性的第二层
 * ==================================================================== */

/**
 * 为什么光靠提示词不够,非要再加这一层确定性检查:
 *
 *  ① **模型不遵守是常态**。这个项目已经实测到它把整段带 markdown 的推理
 *     倒进 `thinking` 字段(所以才有了 cleanThinking)。提示词里写着
 *     「不要报自己的底牌」,它照样会在 `say` 里说「我拿的是 A♦10♦」。
 *  ② **要求本身有张力**。提示词同时要求它「可以诈唬、可以放狠话」,
 *     而诈唬最顺手的一句就是「我这可是葫芦」—— 让它自己拿捏这条边界,
 *     等于每一手都赌一次它守不守规矩。
 *  ③ **这是公平性问题,不是文风问题**。玩家模式下 `say` 是给人类玩家看的:
 *     如实报出自己的牌 = 白送信息。这种规则必须是**确定性**的,
 *     不能靠模型自觉 —— 它不老实的时候,用户根本看不出来自己白赚了信息。
 *
 * 所以分两层:提示词负责「尽量别让它想说」(见 buildSystemPrompt 的 say 一节),
 * 这里负责「真说了就一定拦」。
 *
 * 处理方式是**整句丢掉**(置空),不是改写 —— 改写要另生成一句话,新句子里
 * 再长出新的泄漏就没人管了;而 `say` 本来就是可选的(提示词明确允许
 * 「这手不说话」,界面把空串当「没说话」),所以丢掉是最安全的降级。
 *
 * ⚠️ 只碰 `say`。`thinking` 是**私密推理**(玩家模式才藏,荷官模式要展示),
 *    提示词对它的要求正好相反 —— 那里必须说真牌力,所以绝不能拿这套规则
 *    去过滤它(它只有 cleanThinking 的格式清洗)。两件事别混。
 *
 * ---------------------------------------------------------------------
 * 规则(拦什么 / 放什么 / 边界怎么定)
 * ---------------------------------------------------------------------
 * 判据全部来自**引擎已经知道的事实**(view.me.hole / view.board),
 * 不猜、不联网、不看模型自己说了什么。五条:
 *
 *  ① 具体牌张(点数 + 花色,如 `A♦`):命中自己的底牌 → 拦,**无豁免**。
 *     底牌不可能同时是公共牌,所以这张牌被说出口只可能是报牌。
 *     花色字母写法(`Ad` / `10c`)、全角、夹空格的写法都会先归一化。
 *
 *  ② 只写点数(「我有 A 高」):该点数在自己底牌里 → 按顺序判:
 *       · 归属于**别人**(「他八成有 A」)           → 放行(读牌,不是报牌);
 *       · 归属于**自己**(「我有 A 高」)             → 拦;
 *       · 公共牌上**有**这个点数(「这张 10 不好办」) → 放行(公共信息);
 *       · 其余(只有自己知道这个点数)               → 拦。
 *     「归属」只看紧挨在「我/俺/咱」后面的持有句式(中间只允许「拿了/中了个」
 *     这类连接字);紧挨「他/她/对手」就归给别人。刻意保守:判不清归属时
 *     **不**当成报牌,而是落到「公共牌上有就放行」那条 —— 免得把
 *     「我猜他有 A」这种正经读牌拦掉。
 *
 *  ③ 只写花色(「方块」):同②的顺序。花色单独说出来的信息量本来就低,
 *     真正的判据是「这个花色在公共牌上一张都没有」—— 公共牌上看得见的花色
 *     是公开信息,只有自己知道的花色才是秘密。
 *
 *  ④ 自己**实际**的成牌名(describe 的结果):类别词命中 → 拦,
 *     同样放行明确归属别人的那句(「他八成是葫芦」是读牌)。
 *     ⚠️ 只拦**真实**牌型。**说谎是允许的**:手里是空气却说「我是葫芦」
 *        不拦 —— 那不是漏牌,是在制造错误信息,正是这个字段要的心理战;
 *        连谎话一起拦掉,等于把诈唬台词也禁了。
 *     ⚠️ 短牌必须传 { shortDeck }:同一个牌型在短牌/标准里名字不同
 *        (A6789 在短牌是顺子、在标准只是 A 高),传错了两个方向都会判错。
 *
 *  ⑤ 翻前(board 为空)把**底牌结构**说出来:真的同花却说「同花」、
 *     真的对子却说「对子」→ 拦。翻前没有公共牌,这些话只能是在描述自己那两张。
 *
 * 已知取舍(有意为之,不是 bug):
 *  · 公共牌上有的点数默认放行,但**被「我」的持有句式绑住时照样拦**
 *    (公共牌有 10、手里也有 10,说「我中了个 10」就是报牌)。
 *  · 「他顶多一对」这种读牌,在自己正好是一对时也会被拦 —— 读牌句式只在
 *    明确带「他/她/对手」时才放行。少说一句的代价远小于漏一次牌。
 *  · 成牌名一律用 describe(与摊牌判定同一套),不自己数牌 —— 否则
 *    界面摊牌时显示的牌型名和这里判的会是两个说法(这个仓库栽过)。
 */

/** 花色符号:0=♠ 1=♥ 2=♦ 3=♣(与 cards.js 的 suitOf 一致) */
const SUIT_LETTER = { s: '♠', h: '♥', d: '♦', c: '♣' };

/** 一个花色可能被写成的几种样子(符号 + 常见中文叫法) */
const SUIT_WORDS = [
  ['♠', '黑桃'],
  ['♥', '红桃', '红心'],
  ['♦', '方块', '方片'],
  ['♣', '梅花', '草花'],
];

/**
 * 自己**实际**成牌类别的常见说法。
 *
 * 键用 categoryKey 的名字(与 handEval 的英文类别一一对应),值是中文说法。
 * ⚠️ 只收「说了就等于报牌」的词:不收单个「对」「花」「顺」——
 *    那些在「打法很对」「花招」「顺手」里都会出现,误伤面太大。
 */
const HAND_WORDS = {
  high_card: ['高牌'],
  one_pair: ['一对', '顶对', '超对', '中对', '底对', '口袋对', '对子'],
  two_pair: ['两对', '双对', '两双'],
  three_of_a_kind: ['三条', '暗三', '明三'],
  straight: ['顺子'],
  flush: ['同花'],
  full_house: ['葫芦', '满堂红', '俘虏'],
  four_of_a_kind: ['四条', '金刚'],
  straight_flush: ['同花顺', '皇家同花顺'],
};

/** 点数 token 的规范写法:T → 10,小写字母 → 大写 */
function rankNorm(r) {
  const t = String(r).toUpperCase();
  return t === 'T' ? '10' : t;
}

/**
 * 把发言归一化成「便于扫牌」的形式。
 * 三条都是为了**别漏**:
 *  · 全角 → 半角(NFKC):模型偶尔写全角「Ａ♦」;
 *  · 空白全去:它爱写「A ♦」「10 10」,留着空格就扫不到;
 *  · 花色字母写法 → 符号,但**只在紧跟点数时**换(Ad / 10c / Kh),
 *    否则英文单词里的 s / d 也会被换掉。
 */
function normalizeForScan(raw) {
  let t = String(raw || '');
  try { t = t.normalize('NFKC'); } catch { /* 老引擎没有 normalize:中文与牌面符号不受影响 */ }
  t = t.replace(/[\s\u3000]+/g, '');
  return t.replace(/(10|[2-9]|[AJQKajqkTt])([shdcSHDC])(?![A-Za-z])/g,
    (m, r, su) => rankNorm(r) + SUIT_LETTER[su.toLowerCase()]);
}

/**
 * 切出文本里所有「点数 token」及它们的位置。
 *
 * 难点全在**别把数字当点数**:
 *  · 「跟20」「加到100」是金额,不是牌 —— 数字点数后面还跟着数字的,不算;
 *  · 但「A10」里的 A 后面跟数字是正常的(那是两张牌),所以这条只管数字点数;
 *  · 花色符号在这儿是天然的分隔符(归一化后 `A♦10♦` 会被切成 `A` / `10`)。
 */
function rankTokens(text) {
  const out = [];
  const RE = /[0-9A-Za-z]+/g;
  let m;
  while ((m = RE.exec(text))) {
    const run = m[0], base = m.index;
    for (let i = 0; i < run.length;) {
      const ch = run[i];
      if (run.slice(i, i + 2) === '10') {
        // 「1020」这种更长的数字不是点数
        if (!/[0-9]/.test(run[i + 2] || '')) out.push({ rank: '10', index: base + i, len: 2 });
        i += 2; continue;
      }
      if (ch === 'T' || ch === 't') { out.push({ rank: '10', index: base + i, len: 1 }); i++; continue; }
      if (/[2-9AJQKajqk]/.test(ch)) {
        if (/[0-9]/.test(ch) && /[0-9]/.test(run[i + 1] || '')) { i++; continue; }
        out.push({ rank: ch.toUpperCase(), index: base + i, len: 1 });
      }
      i++;
    }
  }
  return out;
}

/**
 * 这个点数说的是「钱」还是「牌」?
 * 前面是下注动词、后面是钱的单位 → 当成金额放过。
 * (「跟10看一张」里那个 10 是跟注额,不是底牌 —— 拦掉它属于纯误伤。)
 * ⚠️ 刻意**不**把单独的「到」算进去:「我拿到10」是拿到一张 10,
 *    那是报牌,不能因为前面有个「到」就放过。
 */
const BET_WORDS_BEFORE = ['跟', '加', '下', '押', '注', '全下', '抬', '赌'];
const MONEY_WORDS_AFTER = ['块', '元', '万', '筹码', 'bb', 'BB', '个大盲', '大盲', '个盲注', '点'];
function looksLikeAmount(text, tok) {
  const before = text.slice(Math.max(0, tok.index - 2), tok.index);
  const after = text.slice(tok.index + tok.len, tok.index + tok.len + 4);
  return BET_WORDS_BEFORE.some((w) => before.endsWith(w))
    || MONEY_WORDS_AFTER.some((w) => after.startsWith(w));
}

/**
 * 「我这个/这张」后面接持有的说法 —— 中间只允许这类连接字。
 * 用它区分「我有A」(报牌)和「我猜他有A」(读牌,归属在「他」那边)。
 */
const ME_BIND = /^[的了着有个一两门对张手拿中是成抓来起把现这自己牌头里将收发方块黑桃红心梅片]*$/;
const BIND_MAX = 6;

/** 归属词:紧挨着它们后面的点数/花色,才认「说的是谁」 */
const WHO_MARKER = /我|俺|咱|他|她|对手|别人|人家|对方|那人/g;
const OTHER_MAX_DIST = 8;

/**
 * 这个 token 是在说自己的牌,还是在读别人的牌?
 * @returns {'me'|'other'|null} null = 说不清(公共牌、泛指、纯放话)
 */
function whoSays(text, index) {
  let who = null, at = -1;
  WHO_MARKER.lastIndex = 0;
  for (let m; (m = WHO_MARKER.exec(text));) {
    if (m.index >= index) break;
    who = /^(?:我|俺|咱)$/.test(m[0]) ? 'me' : 'other';
    at = m.index + m[0].length;
  }
  if (!who) return null;
  const between = text.slice(at, index);
  if (who === 'other') return between.length <= OTHER_MAX_DIST ? 'other' : null;
  // 自己:必须是「我 + 持有句式 + 点数」这种紧贴的说法才算报牌
  return between.length <= BIND_MAX && ME_BIND.test(between) ? 'me' : null;
}

/** 词 w 在文本里出现的所有位置(同一个人可能先说错再改口) */
function occurrences(text, w) {
  const out = [];
  for (let from = 0; ;) {
    const at = text.indexOf(w, from);
    if (at < 0) break;
    out.push(at);
    from = at + w.length;
  }
  return out;
}

/** 命中这些词、且不是明确在说别人的 → 返回命中的写法 */
function hitsSelfWord(text, words) {
  for (const w of words) {
    for (const at of occurrences(text, w)) {
      if (whoSays(text, at) === 'other') continue;
      return w;
    }
  }
  return null;
}

/**
 * 这句话有没有漏自己的牌?
 *
 * @param {string} rawSay 已经过 cleanSay 的发言(必须是**最终要显示**的那句)
 * @param {object} view viewForSeat 的座位视角(只用 me.hole / board / shortDeck)
 * @returns {null|{kind:string, hit:string, why:string}} null = 没漏,可以照说
 */
function detectSayLeak(rawSay, view) {
  const say = normalizeForScan(rawSay);
  if (!say) return null;

  const hole = (view?.me?.hole || []).filter((c) => c !== null && c !== undefined);
  const board = (view?.board || []).filter((c) => c !== null && c !== undefined);
  const holeRanks = new Set(hole.map((c) => RANK_LABEL[rankOf(c)]));
  const boardRanks = new Set(board.map((c) => RANK_LABEL[rankOf(c)]));
  const holeSuits = new Set(hole.map(suitOf));
  const boardSuits = new Set(board.map(suitOf));

  // ① 具体牌张:命中自己的底牌 → 拦(底牌不可能同时是公共牌,所以没有豁免)
  for (const c of hole) {
    const t = cardText(c);
    if (say.includes(t)) return { kind: 'holeCard', hit: t, why: `说出了自己的底牌 ${t}` };
  }

  // ② 只写点数
  for (const tok of rankTokens(say)) {
    if (!holeRanks.has(tok.rank)) continue;
    if (looksLikeAmount(say, tok)) continue;
    const who = whoSays(say, tok.index);
    if (who === 'other') continue;                    // 「他八成有 A」是读牌
    if (who === 'me') return { kind: 'rank', hit: tok.rank, why: `说漏了底牌里的点数 ${tok.rank}` };
    if (boardRanks.has(tok.rank)) continue;           // 公共牌上看得见这个点数
    return { kind: 'rank', hit: tok.rank, why: `说漏了底牌里的点数 ${tok.rank}(公共牌上没有)` };
  }

  // ③ 只写花色
  for (let s = 0; s < 4; s++) {
    if (!holeSuits.has(s)) continue;
    for (const w of SUIT_WORDS[s]) {
      for (const at of occurrences(say, w)) {
        const who = whoSays(say, at);
        if (who === 'other') continue;
        if (who === 'me') return { kind: 'suit', hit: w, why: `说漏了底牌里的花色 ${w}` };
        if (boardSuits.has(s)) continue;              // 公共牌上有这个花色
        return { kind: 'suit', hit: w, why: `说漏了底牌里的花色 ${w}(公共牌上一张都没有)` };
      }
    }
  }

  // ④ 自己实际的成牌名
  //    ⚠️ shortDeck 必须与提示词、摊牌判定用同一个值(见 madeHandText 里那段说明)
  if (hole.length >= 2 && board.length >= 3) {
    const shortDeck = !!view?.shortDeck;
    const score = evaluate([...hole, ...board], { shortDeck });
    const key = categoryKey(score, { shortDeck });
    const name = describe(score, { shortDeck });
    const hit = hitsSelfWord(say, HAND_WORDS[key] || []);
    if (hit) return { kind: 'madeHand', hit, why: `说漏了自己的成牌「${name}」` };
    // 高牌的口语说法:「高牌 A」在牌桌上说成「A 高」
    if (key === 'high_card') {
      const hw = `${RANK_LABEL[score[1]]}高`;
      if (occurrences(say, hw).some((at) => whoSays(say, at) !== 'other')) {
        return { kind: 'madeHand', hit: hw, why: `说漏了自己的成牌「${name}」` };
      }
    }
  }

  // ⑤ 翻前把底牌结构说出来(翻前没有公共牌,「同花 / 对子」只可能是在说自己那两张)
  if (board.length === 0 && hole.length === 2) {
    const suited = suitOf(hole[0]) === suitOf(hole[1]);
    const paired = rankOf(hole[0]) === rankOf(hole[1]);
    if (suited) {
      const hit = hitsSelfWord(say, ['同花', '同色', '一个花色', '一样的花色']);
      if (hit) return { kind: 'preflopShape', hit, why: '翻前报了自己的底牌是同花' };
    }
    if (paired) {
      const hit = hitsSelfWord(say, ['对子', '口袋对', '一对']);
      if (hit) return { kind: 'preflopShape', hit, why: '翻前报了自己的底牌是对子' };
    }
  }

  return null;
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
 * 动作捞取 —— 「动作优先」契约的解析半边
 * ==================================================================== *
 *
 * 用户原话:「为什么需要返回思维链?有时阶段时提示仅返回思维链,但是思维链不是
 * 必须的,优先保证操作和简短的思路文本」。
 *
 * 也就是说:**动作是唯一必须的东西**。所以解析这边的目标变了 ——
 * 不再是「JSON 里没有 action 就判这一手失败」,而是「从任何位置把动作捞出来」:
 *   · JSON 里有 action → 直接用(老路径,最可靠);
 *   · JSON 里有 thinking/say 但没有 action → 从这些文字里捞
 *     (实测最常见:模型把「跟注」写进了思路,却忘了给 action 字段);
 *   · 干脆没有 JSON、只有一段话 → 也从那段话里捞。
 * 只有**真的捞不到**时才回落本地策略(那时才该报「没有给出可识别的动作」)。
 *
 * ★ 三条设计红线(每一条都是踩过的坑):
 *   ① **不能只扫关键词**。以前是拿整段文字跑 normalizeActionWord,谁先被正则
 *      撞上就算谁 —— 「他加注到 200,我弃牌」会被读成 raise(命中的是**对手**的动作)。
 *      所以这里看**动作词前面的几个字**:出现「对手/他/她」就当不是我的动作,
 *      出现「我/决定/还是/最后」才当成我的决定。
 *   ② **英文散文不算决定**。`tools/truncfallback.mjs` 钉着一条:连续截断时
 *      「The opponent bet 180 into a 60 pot.」这种推理原文**不许被猜成动作**
 *      (以前从散文里猜出过 allin,玩家看到的是一手莫名其妙的牌)。
 *      所以英文动词只有在「像我的决定」时才算:句首、或前面有 I/we/should/action 这类词;
 *      而 "the opponent bet" 会被第 ① 条直接排除。
 *   ③ **不依赖 reasoning 通道**。`reasoning_content` 是模型的草稿,可选项 ——
 *      这里没有任何一处读它(它要真被当成答案交上来,也只是「一段文本」,
 *      照样按上面的规则判,捞不到就兜底)。
 */

/** 中文动作词 → 内部动作名。长词排前面(「加注到」必须先于「加注」被匹配) */
const CN_ACTION_WORDS = [
  ['全下', 'allin'], ['全压', 'allin'], ['梭哈', 'allin'],
  ['弃牌', 'fold'], ['盖牌', 'fold'], ['放弃这手', 'fold'],
  ['看牌', 'check'], ['过牌', 'check'], ['不加注', 'check'],
  ['跟注', 'call'], ['平跟', 'call'], ['跟一注', 'call'],
  ['加注到', 'raise'], ['加注至', 'raise'], ['加注', 'raise'], ['下注', 'raise'], ['加到', 'raise'],
];
const CN_ACTION_MAP = new Map(CN_ACTION_WORDS);
/** 长的在前:同一个起点上,正则的备选顺序决定谁先命中 */
const CN_ACTION_RE = new RegExp(
  CN_ACTION_WORDS.map(([w]) => w).sort((a, b) => b.length - a.length).join('|'), 'g');

/** 英文动作词(带词边界,免得 'called' 里的 call、'folded' 里的 fold 之类乱入) */
const EN_ACTION_RE = /\b(all[\s-]?in|shove|fold|check|call|raise|bet)\b/gi;
const EN_ACTION_MAP = new Map([
  ['allin', 'allin'], ['all in', 'allin'], ['shove', 'allin'],
  ['fold', 'fold'], ['check', 'check'], ['call', 'call'], ['raise', 'raise'], ['bet', 'raise'],
]);

/** 「这是我的决定」的语境词(中英各一套) */
const SELF_CUE_CN = /(我|我们|咱|决定|选择|打算|准备|计划|就|先|还是|最后|最终|结论|动作|应该|所以|要)/;
const SELF_CUE_EN = /\b(i|i'm|i'll|i'd|we|we'll|let's|my|me|should|will|would|gonna|decide|decision|action|final)\b/i;
/**
 * 「这是对手的动作」的判断 —— **只看紧挨着动作词的那几个字**。
 *
 * 为什么不能看整句:实测的错例是「他加注到 200,我弃牌」——
 * 按整句找「他」的话,连「我弃牌」都会被判成对手的动作,于是整条被丢掉;
 * 而按前面 5 个字找,「他加注」被排除、「我弃牌」正常命中。
 * 反过来,「对手很强,我跟注」这种句子也不该因为前半句提到对手就把跟注丢掉。
 */
const OTHER_CUE_NEAR = /(对手|对方|别人|有人|他们|她们|他|她|opponent|villain|\bhe\b|\bshe\b|\bthey\b|\bhis\b|\bher\b)/i;
function isOtherAction(pre) { return OTHER_CUE_NEAR.test(String(pre).slice(-5)); }

/** 整段就是一个动作词(可带金额)。**锚定**整串,不做子串猜测 */
const BARE_ACTION_RE = /^(?:all[\s-]?in|shove|fold|check|call|raise|bet|全下|全压|梭哈|弃牌|盖牌|看牌|过牌|跟注|平跟|加注|下注)(?:\s*(?:到|至)?\s*\d+)?$/i;

/** 取 idx 之前的那一小段(截到上一个句读为止),用来判断语境 */
function cueBefore(text, idx, n = 12) {
  const from = Math.max(0, idx - n);
  const p = text.slice(from, idx);
  const cut = Math.max(...['。', '！', '？', '!', '?', '\n', ';', '；', '：', ':'].map((ch) => p.lastIndexOf(ch)));
  return cut >= 0 ? p.slice(cut + 1) : p;
}

/** 动作词后面紧跟的金额(「加注到 200」「raise 200」) */
function amountAfter(text, idx, n = 14) {
  const tail = String(text).slice(idx, idx + n);
  const m = /(\d+(?:\.\d+)?)/.exec(tail);
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * 从一段自然语言里捞动作。
 *
 * 五层,优先级从高到低:
 *   ① 显式标注(action: call / 动作:跟注 / 决定:弃牌)—— 模型自己标出来的,最可信;
 *   ② 中文动作词 + 「我的决定」语境 —— 取**最后**一个(模型的结论一般写在最后);
 *   ③ 中文动作词(没有语境词也认)—— 取**第一个**,只用于「整段话都很短、
 *      就是在说要怎么打」的情况,例如思路里只写「这价格便宜,跟注看一张」;
 *   ④ 英文动作词 + 语境(句首 / I should / let's)—— 兜底,散文里描述对手的不算;
 *   ⑤ 整段就是一个动作词(「call」「跟注」)。
 */
function mineActionText(rawText) {
  const text = String(rawText || '');
  if (!text.trim()) return null;

  // ① 显式标注
  const labeled = /["']?(?:action|move|decision|choice|玩法|动作|决定|结论)["']?\s*[:=]\s*["']?\s*([a-z][a-z-]*|全下|弃牌|盖牌|看牌|过牌|跟注|平跟|加注到|加注|下注)/i.exec(text);
  if (labeled) {
    const action = normalizeActionWord(labeled[1]);
    if (action) return { action, amount: amountAfter(text, labeled.index + labeled[0].length), why: 'labeled' };
  }

  // ② 中文动作词 + 我的决定语境(取最后一个)
  let bestCue = null;
  let firstPlain = null;
  CN_ACTION_RE.lastIndex = 0;
  for (let m = CN_ACTION_RE.exec(text); m; m = CN_ACTION_RE.exec(text)) {
    const pre = cueBefore(text, m.index);
    if (isOtherAction(pre)) continue;                  // 「他加注」「对手全下」不是我的动作
    const hit = { action: CN_ACTION_MAP.get(m[0]), amount: amountAfter(text, m.index + m[0].length), why: 'cn' };
    if (!hit.action) continue;
    if (SELF_CUE_CN.test(pre) || !pre.trim()) bestCue = hit;   // 句首也算「我的决定」
    if (!firstPlain) firstPlain = hit;
  }
  if (bestCue) return bestCue;
  if (firstPlain) return firstPlain;

  // ③ 英文动作词(只在「像我的决定」时算;见文件顶上红线 ②)
  let bestEn = null;
  EN_ACTION_RE.lastIndex = 0;
  for (let m = EN_ACTION_RE.exec(text); m; m = EN_ACTION_RE.exec(text)) {
    const pre = cueBefore(text, m.index);
    if (isOtherAction(pre)) continue;
    const action = EN_ACTION_MAP.get(m[0].toLowerCase().replace(/\s+/g, ' '));
    if (!action) continue;
    if (SELF_CUE_EN.test(pre) || !pre.trim()) {
      bestEn = { action, amount: amountAfter(text, m.index + m[0].length), why: 'en' };
    }
  }
  if (bestEn) return bestEn;

  /**
   * ④ 整段**就是**一个动作词(「call」「跟注」「加注到 200」)。
   *
   * ⚠️ 这里必须用**锚定**的整串匹配,不能拿 normalizeActionWord 去猜「短句」:
   *    normalizeActionWord 认单字「跟」「加」,于是「我劝你别跟。」「他可能会加注」
   *    都会被猜成动作 —— 实测这就是把「对手要加注」读成「我要加注」的来源。
   *    只有整段干干净净就是一个动作词(+ 可选金额)时才认。
   */
  const bare = text.trim().replace(/^["'「『(\s]+|["'」』).,。;；\s]+$/g, '').trim();
  if (BARE_ACTION_RE.test(bare)) {
    const action = normalizeActionWord(bare);
    if (action) return { action, amount: amountAfter(bare, 0, bare.length), why: 'bare' };
  }
  return null;
}

/**
 * 一次回答 → 动作(**唯一入口**):重试外壳的 validator 与 _parseDecision 都走它,
 * 所以「算不算能用」和「最后解析出什么」永远是同一份判断(不会漂)。
 *
 * @param {object|null} parsed 已经 extractJson 出来的对象(没有就传 null)
 * @param {*} rawText 原始文本(截断/纯文本时靠它)
 * @returns {{action:string, amount?:number, why:string}|null}
 */
function extractAction(parsed, rawText) {
  if (parsed && typeof parsed === 'object') {
    // ① JSON 的动作字段 —— 最可靠,而且字段名各家写法不一,都认
    const word = normalizeActionWord(parsed.action ?? parsed.move ?? parsed.decision ?? parsed.choice ?? parsed.do ?? parsed.play);
    if (word) {
      const n = Number(parsed.amount ?? parsed.raiseTo ?? parsed.to ?? parsed.bet ?? parsed.size ?? 0);
      return { action: word, amount: Number.isFinite(n) && n > 0 ? n : undefined, why: 'field' };
    }
    // ② 有 JSON 但没有动作字段(实测最常见:动作只写在了思路里)
    const fields = [parsed.thinking, parsed.reasoning, parsed.reason, parsed.say, parsed.speech, parsed.talk, parsed.line, parsed.text, parsed.note];
    for (const f of fields) {
      if (typeof f !== 'string') continue;
      const hit = mineActionText(f);
      if (hit) return { ...hit, why: `${hit.why}:json-field` };
    }
  }
  // ③ 没有 JSON(或 JSON 里什么都捞不到)→ 从整段原文捞
  const hit = mineActionText(rawText);
  return hit ? { ...hit, why: `${hit.why}:text` } : null;
}


/* ==================================================================== *
 * 模型调用的重试:临时性失败再试几次,实在不行才回落本地策略
 * ==================================================================== */



























class PokerAgent extends LlmCaller {
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
   *
   * 重试 / 降级 / 超时那套在父类(LlmCaller)里,这里只管扑克:
   * 座位、性格、历史、读人笔记、以及「这一手该怎么打」。
   */
  constructor(seat, persona, cfg = {}, hooks = {}) {
    super({ seat, cfg, hooks });
    this.persona = persona;
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

  // setConfig 在父类(合并 cfg 的语义完全一样),这里不再覆写。

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
      '【不许搞错的五件事 —— 出错了会显得很蠢】',
      '① **别认错自己的位置**。你是什么位置上面写着(UTG / CO / BTN / SB / BB 等),',
      '   照抄那个词就行,不要自己推。也别把「第几个行动」和「位置好坏」搞反:',
      '   BTN 是最后行动、位置最好;SB/BB 是先行动、位置最差。',
      '② **别搞错自己的底牌**。下面会明确给你两张牌,就按那两张说,不要记成别的牌。',
      '   也不要说别人的底牌 —— 你看不到。想提别人只能猜范围,例如「他那个加注像是有一对」。',
      '③ **别把自己刚才做过的事记错**。本手的过程会按顺序列出来,不确定就回去看。',
      // ④⑤ 是用户实测的第二类混乱:「分不清手牌和公共牌」「分不清成牌是哪一街成的」。
      // 只加约束、不动上面三条 —— 这份提示词被多轮调过,删改的代价很高。
      '④ **底牌和公共牌是两类完全不同的牌,别混**。',
      '   · 「你的底牌」只有**两张**,而且**只有你有** —— 对手看不到,公共牌里也不会出现它们;',
      '   · 「公共牌」是桌上所有人**共用**的 3~5 张 —— 你能用,对手也能用,它们不属于任何人;',
      '   · 你的一手牌 = **你的两张底牌 + 公共牌里挑出来的**最好的 5 张。',
      '     所以「公共牌上有一对 Q」不等于「你有一对 Q」,更不等于「对手没有」;',
      '   · 说「我中了」的时候,先想清楚那张牌到底是**你的底牌**还是**大家共用的公共牌**。',
      '⑤ **成牌是哪一街成的,提示词里写着,照它说,不要自己猜**。',
      '   · 提示词里有一行「成牌是哪一街成的」——翻牌圈就成立、后面转牌/河牌没变的牌,',
      '     **不是刚成的**。别在转牌/河牌把它说成「我刚中」;',
      '   · 如果那一行写着「转牌圈改变了你的成牌:从 X 变成 Y」,那才是这一街真的变了;',
      '   · 这一行只按**已经发出**的公共牌算,不会包含还没发的牌。',
      '',
      '【输出契约 —— 动作第一,思路第二】',
      '★ 每次回答**只有动作是必须的**:`action`(fold / check / call / raise / allin);',
      '  要加注/全下再给 `amount`。除此之外的字段都是可选的。',
      '· `say`(牌桌上说的一句话)—— 可选,可以留空;',
      '· `thinking`(私密思路)—— **可选,可以不写**。要写就一句话(20 字以内),',
      '  能省则省:**别为了写思路把动作挤掉**。',
      '',
      '⚠️ **只写思路、没有动作 = 这次回答作废**。系统拿不到动作只能改用本地策略替你打,',
      '   等于你白白让掉一手牌。所以先把动作定下来,再补一句想法 ——',
      '   哪怕只剩一点额度,也要保证把 `action` 写出来。',
      '',
      '【关于 thinking 字段 —— 它是可选的,不是作业】',
      '`thinking` 会**原样显示在牌桌上给玩家看**,所以它必须是给人读的中文。',
      '**不写它完全可以**(字段省略、或者给空字符串都行)。写的话请守下面的规矩:',
      '',
      '硬性要求:',
      '· **只能写中文**。一个英文字母都不要出现(牌型可以写「Q6同花」「A高」这种中文写法)。',
      '· **不超过 20 个字**,一句话,像牌桌上顺口说的一句话。',
      '· 内容说清:你的牌力怎么样 / 你猜对手在想什么 / 为什么这么打 —— 挑一句说就行。',
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
      '· **不要报别人的底牌**(你看不到),也不要替别人说话。',
      '',
      '⚠️ **最要紧的一条:不要把自己的牌报出来 —— 那等于白送给对手。**',
      '· **不要说出自己底牌的点数或花色**:「我拿的是 A♦」「我有 A 高」这种话**绝对不许说**;',
      '· **也不要说自己实际成了什么牌**:「我是两对」「葫芦别跟了」这种话**同样不许说** ——',
      '  就算你是想拿它吓唬人也不行,换个模糊的说法,别把真牌力说出口。',
      '这一条没有例外:诈唬可以,报自己的真牌不行。',
      '',
      '那还能说什么?下面这些都可以,而且正是这句话的用处:',
      '· **公共牌**是所有人看得见的,随便聊:「这张 10 不好办」「牌面很干」;',
      '· **读别人**也可以:「他那个加注像是有牌」「我猜他在诈唬」—— 说你的猜测,不是报自己的牌;',
      '· **心理战**是核心技能:手里是坚果可以装作犹豫「这注有点大啊……」,',
      '  手里是空气可以放狠话「我劝你别跟。」—— **可以虚张声势,但只能用模糊的话**,',
      '  不能靠报出自己的底牌或真实牌型来吓人;',
      '· 也可以只是中性的一句:「跟了。」「过。」',
      '说什么由你的性格决定:诈唬型爱放话,保守型话少。',
      '**不想说话就留空字符串 ""** —— 连话都不说也是一种风格,不用每手都开口。',
      '',
      '【输出格式】(严格 JSON,不要 markdown 代码块)',
      // ⚠️ 字段顺序**故意**是 action 在前:模型是自回归的,先写出来的字段更容易被写出来。
      //    以前 thinking 排第一位,于是「思考写得很长、动作忘了写」成了实测里最常见的一种失败。
      '{"action":"fold|check|call|raise|allin","amount":数字,"say":"牌桌上说的一句话,20 字以内,可留空,但绝不能报自己的底牌或牌型","thinking":"可选,一句话,20 字以内,不写也行"}',
      '说明:`action` 是**唯一必须**的字段;check / call / fold 时 amount 可省略;raise 时 amount 是「加注到」的目标总额(不是增量)。想全下就把 amount 写成你的最大可用额。',
      '⚠️ 只有 `thinking` 没有 `action` 的回答会被判为无效(见上面那段输出契约)。',
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
    /**
     * ★ 底牌区与公共牌区**必须一眼能分开**(用户实测的第二个问题:
     *   「AI 分不清手牌和公共牌」)。
     *
     * 光写成两行普通文字是不够的 —— 模型会把两行当成同一类事实混着用
     * (实测它把公共牌上的 10 说成「我的 10」,或者把自己的底牌当成「大家都有」)。
     * 所以这里做三件事:
     *   ① 底牌区有**只属于你**的抬头,公共牌区有**所有人共用**的抬头;
     *   ② 底牌那行末尾直接标「这两张只有你有」,公共牌那行末尾标「这几张所有人共用」;
     *   ③ 成牌单独成行,并额外给「是哪一街成的」(见 handTimingInfo)。
     */
    lines.push('════ 下面这几行是**只属于你**的信息(别人看不到,里面没有对手的牌)════');
    lines.push(`· 你的位置:**${view.position || '未标注'}**`);
    // 底牌与**成牌名**分开写,而且成牌名单独占一行。
    // 以前成牌名是塞在底牌那行末尾的括号里的(「(当前成牌:…)」)—— 位置靠前、
    // 又不起眼,模型会无视它自己重新数牌,结果把 A♦ 记成 Q(用户实测那个葫芦)。
    // 单独成行 + 明说「引擎算好的」,是让模型知道这件事不需要它再算。
    // 翻前没有公共牌,describe 至少要 5 张牌套不上,所以走 preflopHandText 那条路
    // (详见 madeHandText 的注释);绝不能在翻前硬调 describe。
    const myHand = madeHandText(view);
    const timing = handTimingInfo(view);
    lines.push(`· 你的底牌:**${view.me.hole.filter((c) => c !== null && c !== undefined).map(cardText).join(' ')}**`
      + '  ← 这两张**只有你有**:别人手里没有它们,公共牌里也不会出现它们');
    if (myHand) {
      lines.push(`· 你现在的成牌:**${myHand}**`
        + '(这是引擎按「你的两张底牌 + **当前已经发出**的公共牌」算好的,直接采信 —— 不要自己再数一遍)');
    }
    // 「是哪一街成的」单独占一行,而且放在成牌名**紧后面** ——
    // 模型读成牌名时顺手就看到时机,不会等到转牌/河牌才去猜「这是刚中的吗」。
    if (timing) {
      lines.push(`· 成牌是哪一街成的:${timing.timing}`);
      if (timing.streets) lines.push(`· 每条街的成牌(只列**已经发出**的公共牌):${timing.streets}`);
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
    //
    // ★ 公共牌单独成区,并明说「这几张所有人共用」——
    //   与上面那个「只属于你」的底牌区在视觉上彻底分开(用户实测:模型会混)。
    //   注意 `公共牌:` 这个前缀**必须保留**(测试与其它工具按它替换/定位这一行)。
    lines.push('──── 公共牌(这几张**所有人共用**:你能用、对手也能用,它们**不是**你的底牌)────');
    lines.push(`公共牌:${view.board.length ? view.board.map(cardText).join(' ') : '(还没有公共牌)'}`
      + (view.board.length ? '  ← 这几张是**所有人共用**的,不是只有你有' : ''));
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
    /**
     * ★【你的最终目标】—— 用户明确要求:每个模型的目标都是「本场排名尽量靠前」,
     *   不是「赢下这一手」。
     *
     * 为什么放在**这里**(紧挨着「决策前再确认」与输出 JSON):
     *   · 这一段是**改变取舍**的指令,不是背景资料 —— 越靠近「现在决定打不打」,
     *     越不会被 lost-in-the-middle 吞掉;
     *   · 它排在对手列表**之后**:前面那些「谁筹码深/谁快出局」是素材,
     *     这一段是把素材收成目标(先看事实,再看目标);
     *   · 也避开了「第一行含某个名字」的既有断言(stacktest 用名字定位对手行,
     *     名次表如果排在前面会把那些行抢走)。
     *
     * ⚠️ 只给**公开信息**:名字 + 筹码 + 公开的出局/全下状态
     *    (牌桌上所有人都看得到)。底牌一张都不进这段。
     * ⚠️ showSeat:false —— 扑克提示词**刻意不给座位号**(见上面那大段注释:
     *    座位号会和位置标签打架,模型会纠结「我是 CO 但按钮位是 1 号位」)。
     */
    const goalRows = (view.players || []).map((p) => ({
      seat: p.seat,
      name: p.name || `座位${p.seat + 1}`,
      score: Math.max(0, Number(p.stack) || 0),
      // 出局 / 全下标出来 —— 它们是公开状态,而且「最后一名 0 筹码、已经出局」
      // 比单写「0 筹码」更像一张真实的名次表。不写档位(短/中/深):
      // 那是给决策的解读,不是名次表的一部分。
      text: `${Math.max(0, Math.round(Number(p.stack) || 0))} 筹码`
        + (p.status === 'out' ? '(已出局)' : p.status === 'allin' ? '(已全下)' : ''),
    }));
    lines.push('');
    lines.push(matchGoalBlock(goalRows, {
      selfSeat: view.me.seat,
      rounds: view.handNo || 0,
      scoreUnit: '筹码',
      showSeat: false,
      title: '本场筹码排名',
    }));

    lines.push('');
    lines.push('【决策前再确认一次 —— 下面几行就是事实,照抄,不要自己推】');
    // 每条都带上「这属于谁」:底牌只有你有 / 公共牌所有人共用。
    // 用户实测的「分不清手牌和公共牌」就发生在这一块 —— 复述是模型最后读到的东西,
    // 在这里把归属写死,比在前面那一大段里写十遍都管用。
    lines.push(`· 你的底牌:${view.me.hole.filter((c) => c !== null && c !== undefined).map(cardText).join(' ')}`
      + '(**只有你有**,对手看不到)');
    lines.push(`· 公共牌:${view.board.length ? view.board.map(cardText).join(' ') : '还没有(这是翻前)'}`
      + (view.board.length ? '(**所有人共用**,不是你的底牌)' : ''));
    lines.push(`· 你现在的成牌:${myHand || '还不知道(牌不全)'}`);
    // 「哪一街成的」也要进复述块:模型是在**读完这一块之后**才下决定的,
    // 只在开头写一次的话,它到决策时已经把「翻牌圈就成立了」丢掉了(治 lost in the middle)。
    if (timing) lines.push(`· 成牌是哪一街成的:${timing.timing}`);
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
      // 本地那几句(LOCAL_SAY)是写死的中性短句,本来就不可能漏牌 —— 但两条路径
      // 都过同一层,免得将来改 LOCAL_SAY 时忘了这条规矩(这个仓库「两条路径
      // 各写一份,测试全绿、线上没生效」已经栽过两次)。
      return { action: d.action, amount: d.amount, thinking, say: this._cleanSayForView(localSay(d.action), view), source: 'fallback' };
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
   * ⚠️ 它也会顺手判一次动作(extractAction),但**不是**第二个解析入口:
   *    `_parseDecision` 之后再走**同一个函数**,所以两处不可能得出两种结论。
   *    真正的「解析成决策」仍然只在 _parseDecision 一处。
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
    if (!String(text || '').trim()) return { verdict: 'empty' };
    /**
     * ★ 先看**能不能捞到动作**,再看是不是截断 —— 顺序不能反。
     *
     * 用户的要求是「动作优先」:推理把额度吃光、正式回答没来,但只要那段残缺输出里
     * 已经写明了要跟注/加注,就没必要再拿「截断」把这一手判死 —— 直接把动作捞出来用,
     * 比退回去让本地策略替它打更接近模型的真实意图。
     * 捞不到才按截断走「额度翻倍 + 关掉推理通道」那条重试。
     *
     * 注意这里和 _parseDecision 用的是**同一个** extractAction:
     * 两处各写一份判断的话,迟早会出现「validator 说能用、解析说没有」的漂移。
     */
    const hit = extractAction(extractJson(text), text);
    if (hit && hit.action) return null;
    if (truncated) return { verdict: 'truncated' };
    return { verdict: 'action' };
  }

  /**
   * `say` 的完整处理:先 cleanSay(去引号 / 压空白 / 24 字上限),
   * 再跑一次漏牌检测(见文件上面 detectSayLeak 那一大段)。
   *
   * 顺序**不能**反:cleanSay 会把话截到 24 字,截断后可能只剩半个牌张
   * (「我拿的是 A♦10♦…」被截成「我拿的是 A」)—— 检测必须按
   * **最终要显示的那句话**判,否则拦下的和显示的不是同一句。
   *
   * 检测挂了也**宁可不说**:say 本来就是可选的,漏牌的代价(白送信息)
   * 远大于少一句话;但必须留下痕迹 —— 否则「桌上忽然都不说话了」
   * 会被当成别的问题去查(比如以为模型坏了)。
   *
   * @returns {string} 可以显示的发言;被拦掉 / 空值时是 ''
   */
  _cleanSayForView(rawSay, view) {
    const say = cleanSay(rawSay);
    if (!say) return '';
    let leak = null;
    try {
      leak = detectSayLeak(say, view);
    } catch (err) {
      this.hooks.onDebug?.(`[座位${this.seat + 1}][say] 漏牌检测异常(按漏牌处理,这句丢掉):${err?.message || err}`);
      return '';
    }
    this.lastSayLeak = leak || null;
    if (!leak) return say;
    this.hooks.onDebug?.(`[座位${this.seat + 1}][say] 拦掉一句会漏牌的发言(${leak.why}):${JSON.stringify(say)}`);
    return '';
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
      // ⚠️ say 比 thinking 多一层**漏牌检测**(清洗之后跑,见 _cleanSayForView):
      //    thinking 是私密的,说真牌力没问题;say 是要给玩家看的,报牌就是白送信息。
      say = this._cleanSayForView(parsed.say ?? parsed.speech ?? parsed.talk ?? parsed.line, view);
    } else {
      // 没有 JSON:退一步,从纯文本里找动作词。
      // 这段是「推理原文当答案」的下场(见 callLLMDirect 里 `full || reasoning` 的说明),
      // 同样过一遍清洗(上限沿用旧的 120 字,不改这条兜底路径的既有行为)。
      thinking = cleanThinking(raw, 120);
    }

    /**
     * ★ 动作解析:**不区分有没有 JSON**,统一走 extractAction(动作优先)。
     *
     * 以前是两个分支:有 JSON 就只看 `action` 字段,没有 JSON 就 `normalizeActionWord(整段)`。
     * 两者的毛病正好相反 —— 前者只要模型忘了写 action 就整手作废(用户实测),
     * 后者会让「他加注到 200」里的动词被当成自己的动作。
     * 现在交给同一个函数:先看字段,再从思路/原文里捞,捞不到才算没有。
     *
     * ⚠️ 截断的回答里 `raw` 其实是模型的**推理草稿**(见 callLLMDirect 的 `full || reasoning`),
     *    能捞到动作就照用(动作优先),但那段草稿**不能**当 thinking 显示给玩家 ——
     *    用户截图里的英文占位气泡就是这么来的。所以截断时清掉英文草稿。
     */
    const hit = extractAction(parsed, raw);
    if (hit && hit.action) {
      action = hit.action;
      amount = hit.amount;
      if (this.lastTruncated && !/[\u4e00-\u9fa5]/.test(thinking)) thinking = '';
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






}

/**
 * 除了 PokerAgent 本身,这里还**原样转发**通用调用层的几个东西
 * (extractJson / classifyLlmFailure / resolveRetryPolicy / LLM_RETRY):
 * 已有测试与调试脚本是从这个模块取它们的,搬家只改路径、不改它们能拿到什么。
 */
export {
  PokerAgent, fallbackDecide, preflopStrength, normalizeActionWord, ACTION_LABEL, LOCAL_SAY,
  evaluate, describe, categoryKey, cleanThinking, cleanSay, detectSayLeak,
  // 动作捞取(「动作优先」契约的解析半边)与「成牌是哪一街成的」:
  // 都导出给测试直接钉行为(tools/actioncontracttest.mjs),不必绕过 decide() 去构造模型输出。
  mineActionText, extractAction, handTimingInfo,
  extractJson, classifyLlmFailure, resolveRetryPolicy, LLM_RETRY,
};
