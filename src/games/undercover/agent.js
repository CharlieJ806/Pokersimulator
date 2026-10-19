/**
 * 「谁是卧底」的 AI 代理 —— 只做三件事:**拼提示词、解析回答、把说漏嘴的话拦下来**。
 *
 * 重试 / 超时 / 取消 / 参数降级 / JSON 抽取全在 shared/llmCaller.mjs(与扑克共用),
 * 这里不重复实现。真正的规则判定在 engine/kernel.js ——
 * LLM 给的一切都只是**提议**(研究文档「An Implementation of Werewolf Agent That
 * does not Truly Trust LLMs」的主张),非法就拒,不靠提示词求它守规矩。
 *
 * ────────────────────────────────────────────────────────────────
 * 三条设计上的硬要求(都有测试盯着)
 *
 * ① **信息隔离靠「上下文里根本没有」,不靠「请不要作弊」。**
 *    这个 Agent 收到的 view 由 view.js 产出,里面**没有**别人的 words / roles 字段;
 *    提示词里出现的词只有它自己那一个。所以哪怕模型想作弊也无从作弊 ——
 *    它不知道别人拿了什么,也不知道自己是不是卧底。
 *    (提示词里讲规则时会提到「平民 / 卧底」这两个**概念**,但从不落到任何座位、
 *     更不会说「你是 X」。测试断言的正是「没有把阵营告诉它」,而不是「不许出现这两个字」。)
 *
 * ② **自省链必须写进提示词**(研究文档里 11zhouxuan 那份,实测好用):
 *    「全场描述都和你的词对不上 → 你大概率是卧底,别纠正别人,顺着说」。
 *    没有这一条,卧底会坚信自己是平民、疯狂纠正别人,第一轮就被抓 ——
 *    而这个游戏最好玩的地方恰恰是「它自己意识到了」。
 *
 * ③ **说出口的话过一遍代码级过滤器**(filter.js)。
 *    `thinking` / `self_read` 是私密的,可以说真话;`say` / `reason` 是公开的,
 *    出现自己的词、阵营、元信息就作废。命中后的处理策略见 describe() 的注释:
 *    **先带着违规说明重试一次,仍不行就用确定性中性句兜底**(不随机)。
 */

import { LlmCaller, extractJson, resolveRetryPolicy, CANCEL_MESSAGE } from '../../shared/llmCaller.mjs';
import {
  cleanSay, checkSayLeak, neutralSay, repairHint,
} from './filter.js';
// 猜词的「同一个词」怎么算,与裁判用**同一个函数**(kernel 的 normalizeGuess)。
// 两边各写一份清洗规则的话,早晚会出现「模型猜的确实是平民词,但裁判判没中」——
// 而这个机制最不能出错的就是那一下判定。
import { normalizeGuess } from './engine/kernel.js';
// 【你的最终目标】那段(三个游戏共用):目标不是赢这一局,而是本场排名靠前。
import { matchGoalBlock } from '../../shared/leaderboard.mjs';

/** 描述轮必须给出的自省结论(研究文档口径) */
const SELF_READS = ['civilian', 'undercover', 'unsure'];

/** 把模型可能写的同义说法收敛成三个合法值 */
function normalizeSelfRead(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return 'unsure';
  if (SELF_READS.includes(s)) return s;
  if (/卧底|undercover|spy|伪装|内鬼/.test(s)) return 'undercover';
  if (/平民|civilian|好人|村民|normal|villager/.test(s)) return 'civilian';
  return 'unsure';
}

/** 座位号口语化:0 → 「1号」 */
function seatLabel(seat) {
  return `${Number(seat) + 1}号`;
}

/**
 * 公开历史:描述矩阵 + 投票 + 出局。
 *
 * 为什么用**矩阵**而不是流水账:卧底的核心推理就是「横向对比所有人说过的话」,
 * 研究文档专门强调过这一点(谁是卧底的记忆不是摘要,是描述矩阵)。
 * 这里只放**公开过**的东西(view.descriptions / view.votes),别人的词与阵营
 * 根本不在 view 里,拼不出泄漏。
 */
function historyBlock(view) {
  const lines = [];
  const rounds = [];
  for (const d of view.descriptions) if (!rounds.includes(d.round)) rounds.push(d.round);
  rounds.sort((a, b) => a - b);

  lines.push('【描述矩阵】(每格是那个人当时的原话,只有公开内容)');
  if (!rounds.length) {
    lines.push('  (还没有人描述过 —— 你是这一轮最前面几个之一)');
  } else {
    const head = ['座位', ...rounds.map((r) => `第${r}轮`)].join(' | ');
    lines.push(`  ${head}`);
    for (const s of view.seats) {
      const cells = rounds.map((r) => {
        const d = view.descriptions.find((x) => x.seat === s.seat && x.round === r);
        return d ? d.say : '—';
      });
      const you = s.seat === view.seat ? '(你)' : '';
      lines.push(`  ${seatLabel(s.seat)}${you} | ${cells.join(' | ')}`);
    }
  }

  const pastVotes = view.votes.filter((v) => v.round < view.round || view.phase === 'vote');
  if (pastVotes.length) {
    lines.push('');
    lines.push('【投票记录】(公开;「弃票」= 那一票没投出去)');
    const byRound = new Map();
    for (const v of pastVotes) {
      if (!byRound.has(v.round)) byRound.set(v.round, []);
      byRound.get(v.round).push(v);
    }
    for (const [r, list] of byRound) {
      const txt = list.map((v) => (v.to === null
        ? `${seatLabel(v.from)} 弃票`
        : `${seatLabel(v.from)} → ${seatLabel(v.to)}${v.reason ? `(${v.reason})` : ''}`)).join(';');
      lines.push(`  第${r}轮:${txt}`);
    }
  }

  if (view.eliminated.length) {
    lines.push('');
    lines.push('【已出局】(出局时公开阵营,这是公开信息)');
    for (const e of view.eliminated) {
      lines.push(`  ${seatLabel(e.seat)}:第${e.round}轮出局,${e.role === 'undercover' ? '卧底' : e.role === 'blank' ? '白板' : '平民'}`);
    }
  }

  // 猜词记录:谁赌过一次、赌中没有。词本身可能还没公开(规则见 kernel.recordGuess),
  // 所以这里只写「猜中/猜错」——模型据此能推出「他手里有/没有平民词」,这已经够了。
  const guesses = view.guesses || [];
  if (guesses.length) {
    lines.push('');
    lines.push('【猜词记录】(公开;猜的词不一定公开)');
    for (const g of guesses) {
      lines.push(`  ${seatLabel(g.seat)}(第${g.round}轮)${g.text ? `猜「${g.text}」` : '选择了猜词'} → ${g.hit ? '猜中了' : '没猜中'}`);
    }
  }
  return lines.join('\n');
}

/**
 * 「只有你能看到的一格」—— 自己的词。
 *
 * 三种人写三种话(这是**唯一**能提到「词」的地方):
 *   · 平民 / 卧底:给出自己的词;
 *   · 白板(blank):明确告诉它「你手里是空的」,但**不说原因**,也不说这意味
 *     它属于哪一边 —— 一旦它知道自己站在平民这边,它就不用推理、也不会赌猜词,
 *     这个游戏最好玩的那部分就没了。
 * @param {object} view buildView 的返回值
 * @param {'describe'|'vote'} phase
 */
function wordBlockLines(view, phase) {
  const lines = ['════ 只有你能看到的一格:你的词 ════'];
  if (view.me.blank) {
    lines.push('【你的词】(这一局你没有词 —— 你手上是空的)');
    lines.push('(⚠️ 别把这件事说出去,也别试图解释为什么。听别人怎么描述,顺着那个方向编一句。)');
    lines.push('════════════════════════════════════');
    lines.push('');
    lines.push('【这一局你手上是空的】');
    lines.push('· 你没有词可描述,别人的描述就是你全部的素材。');
    lines.push('· 不要说「我没有词」这类话,也不要因为手上是空的就断定自己属于哪一边 —— 你同样不知道。');
    if (phase === 'describe') {
      lines.push('· 你的活法只有一条:挑一个和大家方向一致、但足够模糊的说法,说得像你手上也有一个词。');
      lines.push('  第一个说的人最难(没有可抄的),这时给一句「大类」描述;后面的人说过之后,再往他们的方向上靠。');
      lines.push('· 这一轮**不要猜词**:你不知道平民词,而且猜词对你没有任何好处(猜中猜错都是出局)。');
    } else {
      lines.push('· 投票时照「谁的描述最像在硬编」去投 —— 但别忘了也可能是别人,你并没有比别人多知道什么。');
    }
    return lines;
  }
  lines.push(`【你的词】${view.me.word}`);
  lines.push(phase === 'describe'
    ? '(本局所有平民拿同一个词,卧底拿一个相近但不同的词。**你不知道自己在哪一边。**)'
    : '(你会用「谁说的和我对不上 / 谁在抄别人」来判断,而不是知道别人的词。)');
  lines.push('════════════════════════════════════');
  return lines;
}

/**
 * ★【你的最终目标】—— 平台口径:每个模型的目标都是**本场排名尽量靠前**,
 * 不是赢下这一局(用户原话)。
 *
 * 排名从 view.matchStandings 进来(由 runner 从屏幕的本场积分表取,**公开信息**:
 * 座位 / 名字 / 本场积分)。为什么放在 user 提示词而不是系统提示词:
 * 系统提示词是「这个座位是谁」那一套(静态),而本场排名**每一局都在变** ——
 * 放进静态段就等于把第一局的排名一直念到最后一局。
 *
 * ⚠️ 这里**只**能出现公开信息。自己的词在 wordBlockLines 里,别人的词/阵营
 *    在整个 view 里都没有字段 —— 这一段拼不进来,也不需要拼。
 */
function goalBlockFromView(view) {
  const s = view?.matchStandings;
  return matchGoalBlock(s?.ranking || [], {
    selfSeat: view?.seat,
    rounds: Number(s?.rounds) || 0,
    scoreUnit: '分',
    title: '本场积分',
  });
}

export class UndercoverAgent extends LlmCaller {
  /**
   * @param {number} seat 座位号(0 起)
   * @param {object} persona 性格 { name, tag, style, verbosity, ... }
   * @param {object} cfg 该座位的模型配置(app.agentCfg 组装,与扑克同一份)
   * @param {object} hooks { onThink(delta, full, thinking), onError(err), onDebug(msg) }
   */
  constructor(seat, persona, cfg = {}, hooks = {}) {
    super({ seat, cfg, hooks });
    this.persona = persona || {};
    /** 统计:让「这一局调了几次、兜底了几次」在调试时看得见 */
    this.stats = { describe: 0, vote: 0, llmOk: 0, fallback: 0, filtered: 0, errors: 0 };
  }

  get name() { return this.persona?.name || seatLabel(this.seat); }
  get modelLabel() { return this.cfg?.model || '本地策略'; }

  /* ------------------------------------------------------------ 提示词 */

  /**
   * 系统提示词 —— 规则 + **你知道什么 / 你不知道什么** + 自省链 + 禁止项 + 输出格式。
   *
   * ⚠️ 这里**不许**出现任何具体座位的词或阵营,也不许出现自己座位的结论。
   *    规则层面提到「平民 / 卧底」是概念(必要),但绝不能写成「你是卧底」——
   *    那会把这个游戏瞬间变成狼人杀。tools/undercovertest.mjs 有断言盯着。
   */
  buildSystemPrompt() {
    const p = this.persona || {};
    return [
      '你正在玩桌游「谁是卧底」。你是一个普通玩家,不是裁判、不是解说、不是 AI 助手。',
      `别人叫你「${p.name || `座位${this.seat + 1}`}」。`,
      '',
      '【这个游戏怎么玩】',
      '· 桌上每个人都会拿到一个词,但**只有一个(或少数几个)人和大家拿的不一样**。',
      '· 大多数人的词是同一个 —— 这些人是「平民」。',
      '· 少数人拿的是一个**相近但不同**的词 —— 这些人是「卧底」。',
      '· **没有人知道自己属于哪一边**。你也一样:你只知道自己的词,不知道自己是不是卧底。',
      '· 每一轮:每人用一句话描述自己拿到的词(不许直接把它说出来)→ 全体投票 →',
      '  票最多的人出局(平票则本轮无人出局,出局时公开他是平民还是卧底)→ 判胜负。',
      '· 平民胜 = 把卧底全部投出去;卧底胜 = 卧底活到场上只剩很少几个人。',
      '',
      '【你能确定的信息】',
      '· 你自己的词(见下面「你的词」那一节,那是你唯一的私有信息)。',
      '· 所有人**公开说过**的描述原话。',
      '· 所有人的投票记录、公开理由,以及谁出局、出局者是平民还是卧底。',
      '· 现在是第几轮、场上还剩几个人。',
      '',
      '【你不知道的 —— 不许假装知道】',
      '· 别人拿到的是什么词。',
      '· 卧底词到底是什么。',
      '· **你自己是平民还是卧底**(这一条最重要:你只能靠推理猜)。',
      '· 别人心里怎么想的、有没有说谎。',
      '',
      '【先判断自己站在哪一边 —— 这一步比说什么都重要】',
      '· 逐个看别人的描述:它们和你的词对得上吗?',
      '· 只要有一个人描述明显和你的词吻合,你和他大概率是同一阵营(平民)。',
      '· **如果场上所有人的描述都和你的词对不上,你大概率是卧底** ——',
      '  这时**不要**去纠正别人,也不要坚持自己的说法,顺着大家描述的方向说,',
      '  别让自己显得格格不入。这就是这个游戏最关键的生存技巧。',
      '· 拿不准就在 self_read 里写 "unsure",不要硬猜一个。猜错不丢人,硬演才难看。',
      '',
      '【描述的分寸】',
      '· 说得太具体 → 卧底直接抄你的话,你就白给了;说得太模糊 → 你自己最像卧底。',
      '· 好的描述:一个**真实的、但不唯一**的特征(形状 / 颜色 / 用途 / 口感里挑一个)。',
      '· 第一轮尤其要留手;后面几轮可以逐步更具体,因为那时「谁在抄」已经看得出来了。',
      '· 一句话,10~20 个字。不要复读别人的原话,也不要换个说法说同一件事。',
      '',
      '【禁止 —— 一句话碰到任何一条就直接作废】',
      '· 不能说出、写出、暗示你拿到的词(包括同音字、拆字、直接翻译、谐音梗)。',
      '· 不能说自己「是平民」或「是卧底」。你不知道,也不许编一个说出来。',
      '· 不能评价「这个词」本身(几个字、词性、是不是名词、有没有谐音)。',
      '· 不能引用没出现过的描述,不能描述表情、眼神、语气 —— 这是文字游戏,你看不到。',
      '· 不要报座位号指自己(说「我」,不要说「我是 3 号」)。',
      '',
      '【你可以放弃描述,改为「猜词」】',
      '· 轮到你说话时,你不一定要描述:你可以直接报一个词,声称平民的词就是它。',
      '· 这是**赌博**,代价立刻兑现,而且很重:',
      '  · 如果你其实是**真正的卧底**:猜中 → 你这一边当场获胜;猜错 → 你这一边当场输掉这一局。',
      '  · 如果你不是真正的卧底:一猜就出局(猜没猜中都一样)。',
      '    理由:平民本来就知道平民词,「猜对」没有任何意义,规则不允许靠猜词取胜。',
      '· 所以只有当下面三条**同时**成立时才考虑猜词:',
      '  ① 你在 self_read 里已经判自己大概率是卧底;',
      '  ② 公开描述已经把平民词指向一个很具体的东西(至少两个人说的是同一个东西,',
      '     而且和你的词明显不是一回事)—— 你**知道该猜哪个词**,而不是碰运气;',
      '  ③ 你这一轮大概率会被投出去 —— 不赌就是输,赌一次还有机会。',
      '· 三条里有一条不满足就老老实实描述。**绝大多数轮次都不该猜**:',
      '  乱猜的代价是把整个阵营直接送掉,比说一句平淡的描述糟糕得多。',
      '  拿不准 → 描述。',
      '',
      '【你的说话风格】',
      `别人对你的印象是「${p.tag || '普通'}」:${p.style || '正常聊天,不抢话也不装深沉。'}`,
      p.verbosity === 'short' ? '你说话偏短,能一句说完绝不说两句。'
        : p.verbosity === 'long' ? '你话偏多,喜欢把一件事说透。'
          : '你说话长短正常。',
      '风格只影响语气,**不影响**上面那些禁止项。',
      '',
      '【输出格式】(严格 JSON,不要 markdown 代码块,不要多余的话)',
      '描述轮(二选一,action 决定你在做什么):',
      '  ① 正常描述:{"action":"describe","thinking":"私密推理,1~2 句中文,不超过 80 字","say":"说出口的描述,10~20 字","self_read":"civilian|undercover|unsure","avoid":"我刚才刻意没说的那个词(可选)"}',
      '  ② 放弃描述改猜词:{"action":"guess","thinking":"为什么敢赌这一把(1~2 句)","guess":"你认为是平民词的那一个词","self_read":"undercover"}',
      '     (只有上面三条都成立时才用②;guess 只能是一个词,不要写句子)',
      '投票轮:{"thinking":"私密推理,1~2 句中文","vote":几号(数字,例如 3 表示 3号),"reason":"能当众说出口的理由,25 字以内"}',
      '说明:thinking 是私密的,可以说真话;say / reason 是所有人都听得到的,绝不能报词、报阵营。',
    ].filter(Boolean).join('\n');
  }

  /** 描述轮的 user 提示词(只含自己的词 + 公开历史) */
  buildDescribePrompt(view) {
    const lines = [];
    lines.push(`第 ${view.round} 轮 · 描述轮(共最多 ${view.rounds} 轮)。你是 ${seatLabel(view.seat)},${view.me.name}。`);
    lines.push('');
    lines.push(...wordBlockLines(view, 'describe'));
    lines.push('');
    const alive = view.seats.filter((s) => s.alive).map((s) => seatLabel(s.seat));
    lines.push(`【现在场上】存活 ${view.aliveCount} 人:${alive.join('、')}。`);
    lines.push('');
    lines.push(goalBlockFromView(view));
    lines.push('');
    lines.push(historyBlock(view));
    lines.push('');

    // 本轮已经说过的人(让模型知道自己是第几个,别引用还没出现的发言)
    const said = view.descriptions.filter((d) => d.round === view.round);
    if (said.length) {
      lines.push('【本轮已经说过】');
      for (const d of said) lines.push(`  ${seatLabel(d.seat)}:${d.say}`);
      lines.push('');
    }
    const idx = view.order.indexOf(view.seat);
    lines.push(`【轮到你了】你是本轮第 ${idx + 1} 个要描述的人。`);
    lines.push('先用 1~2 句在心里横向对比(别人说的和你的词对得上吗?对不上的人多不多?),');
    lines.push('再决定这一句说什么 —— 然后**只输出那个 JSON**。');
    if (!view.me.blank) {
      // 猜词这条只在「有词的人」这里提醒一次:白板的提示词里已经写了「不要猜」,
      // 两边都写会让白板也觉得自己该考虑一下(它没有词,猜词只有坏处)。
      lines.push('');
      lines.push('【这一轮你也可以不描述,改成猜词】');
      lines.push('· 前提:你已经强烈怀疑自己是卧底,并且能从上面的公开描述里**具体**指认平民词是哪个。');
      lines.push('· 代价:真的是卧底 → 猜中当场赢、猜错当场输;不是卧底(平民)→ 一猜就出局。');
      lines.push('· 拿不准就按正常描述走(绝大多数轮次都该这样)。');
    }
    return lines.join('\n');
  }

  /** 投票轮的 user 提示词(只含公开信息 + 自己的词,用于判断谁可疑) */
  buildVotePrompt(view) {
    const lines = [];
    lines.push(`第 ${view.round} 轮 · 投票轮。你是 ${seatLabel(view.seat)},${view.me.name}。`);
    lines.push('');
    lines.push(...wordBlockLines(view, 'vote'));
    lines.push('');
    lines.push(goalBlockFromView(view));
    lines.push('');
    lines.push(historyBlock(view));
    lines.push('');
    const cands = view.voteCandidates.map((s) => seatLabel(s));
    lines.push(`【你能投的人】${cands.length ? cands.join('、') : '(没有人可投 —— 这不该发生)'}`);
    lines.push('不能投自己,不能投已经出局的人。');
    lines.push('');
    lines.push('【怎么想这一步】');
    lines.push('· 谁的描述和大多数人对不上?那是卧底最可能的形态。');
    lines.push('· 谁在复读/改写别人说过的话?卧底没有自己的词,最容易抄。');
    lines.push('· 谁说得比所有人都空?「很好吃」「很常见」这种话谁都能说。');
    lines.push('· 反过来:如果**全场描述都和你的词对不上**,那很可能**你**才是卧底 ——');
    lines.push('  这时投谁都是错,投那个最不按大家方向说的人,别暴露自己。');
    lines.push('');
    lines.push('【输出】只输出 JSON:{"thinking":"…","vote":几号,"reason":"≤25 字的公开理由"}。');
    lines.push('vote 用**几号**(1 表示 1号),不要用 0 基下标;没有可投的人就写 null。');
    return lines.join('\n');
  }

  /* ------------------------------------------------------------ 调用 */

  _hasLLM() {
    return !!(this.cfg?.endpoint && (this.cfg?.apiKey || this.cfg?.noKey));
  }

  /** 重试会话:每次「描述 / 投票」各一条死线,与扑克的用法一致 */
  _retryCtx() {
    const policy = resolveRetryPolicy(this.cfg);
    const started = Date.now();
    return { startedAt: started, deadline: started + policy.budgetMs };
  }

  /**
   * 描述这一轮(或者:放弃描述,改猜词)。
   *
   * 处理顺序(每一步都写死,别把它做成「看情况」):
   *   1. 调模型(校验:必须是 JSON,且要么有中文 say、要么是一个能用的 guess);
   *   2. **猜词闸门**(见下面的 guessGate):不是「强烈怀疑自己是卧底」就不许赌;
   *   3. cleanSay 清洗 + **代码级过滤**;
   *   4. 命中过滤 → **带着违规说明重试一次**(模型经常只是顺手把词写进去了);
   *   5. 仍命中 / 调用失败 → **确定性中性句兜底**(neutralSay(seat, round)),
   *      并标 quality:'low'。
   *
   * 为什么兜底不是「随机挑一句话」:研究文档「坑 8」写得很清楚 ——
   * 随机兜底会让同一局前后矛盾(刚说信他,下一拍就投他),观众立刻出戏。
   * 这里用 (座位, 轮次) 的哈希选句,同一局面重跑永远同一句,对局可复现。
   *
   * ────────────────────────────────────────────────────────────────
   * 猜词闸门(AI 不瞎猜的**代码级**保证,不只靠提示词)
   *
   * 提示词写了「三条同时成立才考虑猜」,但模型经常只看见「可以猜」就赌一把 ——
   * 一局里赌错的代价是整个阵营直接输,而且观众会觉得 AI 在犯傻。所以这里再加一道
   * 硬闸门:只有 `self_read === 'undercover'`(它自己已经断定是卧底)时才放行。
   * 这不只是为了好看 —— 一个判自己是平民的模型去猜词,按规则就是「平民猜词直接出局」,
   * 那是纯粹的送人头。被拦下来时**不报错**,而是退回正常描述(用它本来想说的话;
   * 话也说不清就用中性句),局照常往下走。
   *
   * @returns {Promise<{action:'describe'|'guess', say?:string, guess?:string,
   *                    thinking:string, selfRead:string, source:string,
   *                    quality:string, filtered:null|object}>}
   */
  async describe(view, opts = {}) {
    this.stats.describe++;
    const round = view.round | 0;
    const fallback = (why) => {
      this.stats.fallback++;
      this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 描述降级为中性句:${why}`);
      return {
        action: 'describe',
        say: neutralSay(this.seat, round),
        thinking: '这一轮没想好怎么说得更具体,先给一句模糊的。',
        selfRead: 'unsure',
        source: 'fallback',
        quality: 'low',
        filtered: null,
      };
    };
    if (!this._hasLLM()) return fallback('没有可用的模型配置');

    const system = this.buildSystemPrompt();
    const user = this.buildDescribePrompt(view);
    const started = Date.now();

    let raw = '';
    try {
      raw = await this._call(system, user, opts.signal, () => this._validateDescribe());
    } catch (err) {
      if (err?.canceled || opts.signal?.aborted) return fallback(CANCEL_MESSAGE);
      this.stats.errors++;
      this.hooks.onError?.({
        seat: this.seat,
        message: err?.llmParseFail ? `${err.message},已改用中性描述` : (err?.message || String(err)),
      });
      return fallback(err?.llmParseFail ? '模型没给出可用的描述' : '调用失败');
    }

    let parsed = this._parseDescribe(raw, view, Date.now() - started);
    if (!parsed) return fallback('模型没给出可用的描述');

    // ② 猜词闸门:先判「这一下该不该赌」,再判「赌的那个词干不干净」
    if (parsed.action === 'guess') {
      const why = this._guessGate(parsed, view);
      if (!why) {
        this.stats.llmOk++;
        this.stats.guess = (this.stats.guess || 0) + 1;
        this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 赌一把:猜「${parsed.guess}」`);
        return {
          action: 'guess',
          guess: parsed.guess,
          thinking: parsed.thinking,
          selfRead: parsed.selfRead,
          source: 'llm',
          quality: 'ok',
          filtered: null,
        };
      }
      // 拦下来 → 退回描述。它原本可以给 say,这里 parsed.say 可能为空,
      // 那就走下面那条「没有 say」的路(中性句兜底)。
      this.stats.guessBlocked = (this.stats.guessBlocked || 0) + 1;
      this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 猜词被闸门拦下(${why}),改回描述`);
      parsed = { ...parsed, action: 'describe' };
      if (!parsed.say) return fallback(`猜词被拦(${why}),而且没给描述`);
    }

    // ③ 公开内容的过滤。命中就带着「你违反了哪一条」重问一次 ——
    //    重问一次的原因是:模型多数时候只是顺手把词写进去了,提示一句就改对。
    const leakOpts = { word: view.me.word, blank: !!view.me.blank };
    let leak = checkSayLeak(parsed.say, leakOpts);
    if (leak) {
      this.stats.filtered++;
      this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 描述被拦(${leak.why});带着说明重试一次`);
      const retryUser = `${user}\n\n【你上一次的回答被主持人拦下了】\n`
        + `你上一次说:「${parsed.say}」 —— ${leak.why}。\n${repairHint(leak, view.me.word)}\n`
        + '请重写这一句描述,只输出那个 JSON。';
      try {
        raw = await this._call(system, retryUser, opts.signal, () => this._validateDescribe());
        parsed = this._parseDescribe(raw, view, Date.now() - started) || parsed;
        // 重试那一次也可能又来一个 guess —— 同一个闸门再判一遍(不给自己开绿灯)
        if (parsed.action === 'guess' && !this._guessGate(parsed, view)) {
          this.stats.llmOk++;
          this.stats.guess = (this.stats.guess || 0) + 1;
          return {
            action: 'guess',
            guess: parsed.guess,
            thinking: parsed.thinking,
            selfRead: parsed.selfRead,
            source: 'llm',
            quality: 'ok',
            filtered: null,
          };
        }
        leak = parsed.action === 'guess' ? null : checkSayLeak(parsed.say, leakOpts);
      } catch (err) {
        if (err?.canceled || opts.signal?.aborted) return fallback(CANCEL_MESSAGE);
        // 重试失败不等于这一局没法继续 —— 用兜底句,局照常往下走
        this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 过滤后的重试失败:${err?.message || err}`);
      }
    }
    if (leak) {
      // ④ 两次都说不干净 → 确定性中性句(不随机、不硬编一句带信息的)
      const fb = fallback(`两次描述都命中过滤器(${leak.why})`);
      return {
        ...fb,
        thinking: parsed.thinking || '这句话不能公开说,先含糊过去。',
        selfRead: parsed.selfRead,
        filtered: leak,
      };
    }
    if (!parsed.say) return fallback('模型没给出可用的描述');

    this.stats.llmOk++;
    return {
      action: 'describe',
      say: parsed.say,
      thinking: parsed.thinking,
      selfRead: parsed.selfRead,
      source: 'llm',
      quality: 'ok',
      filtered: null,
    };
  }

  /**
   * 猜词闸门:返回 null = 放行;返回一段中文 = 为什么不放行(只进调试日志)。
   *
   * 三条:
   *   ① 它自己必须已经认定「我大概率是卧底」(self_read === 'undercover')。
   *      这一条同时挡掉了两个坏情况:判自己是平民还去猜(= 白送一个人头)、
   *      以及根本没想过自己是谁就顺手赌一把(= 瞎猜)。
   *   ② 猜的必须是一个能比的词(清洗后非空、有中文、不超过 12 字)。
   *   ③ 不能猜**自己手里的词**:卧底猜自己的词一定判错(等于自爆),
   *      平民猜自己的词是「明知故犯」(照样出局)。两种情况都没有意义。
   * @param {object} parsed _parseDescribe 的结果
   * @param {object} view
   */
  _guessGate(parsed, view) {
    if (parsed.selfRead !== 'undercover') return `self_read 是 ${parsed.selfRead},它并不认为自己是卧底`;
    const g = normalizeGuess(parsed.guess);
    if (!g) return '猜的词是空的';
    if (!/\p{Script=Han}/u.test(g)) return `猜的词不是中文(${g})`;
    if (view.me.word && g === normalizeGuess(view.me.word)) return '猜的就是自己手里的词(必错)';
    return null;
  }

  /**
   * 投票。
   *
   * 降级**必须是弃票**(target=null),不是随机挑一个 —— 研究文档把「随机兜底
   * 毁一致性」列为明确的坑:解析失败就随机投,会让上一秒还说信他的人下一秒被他投,
   * 观众立刻出戏。弃票是安全的:它不改变任何人的嫌疑,只是少一票。
   *
   * @returns {Promise<{target:number|null, thinking:string, reason:string,
   *                    source:string, invalid?:string}>}
   */
  async vote(view, opts = {}) {
    this.stats.vote++;
    const abstain = (why, thinking = '') => {
      this.stats.fallback++;
      this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 投票降级为弃票:${why}`);
      return {
        target: null,
        thinking: thinking || '这一票我先不投,免得跟着别人乱推。',
        reason: '',
        source: 'fallback',
        invalid: why,
      };
    };
    if (!this._hasLLM()) return abstain('没有可用的模型配置');
    if (!view.voteCandidates?.length) return abstain('没有可投的人');

    const system = this.buildSystemPrompt();
    const user = this.buildVotePrompt(view);
    const started = Date.now();

    let raw = '';
    try {
      raw = await this._call(system, user, opts.signal, () => this._validateVote(view));
    } catch (err) {
      if (err?.canceled || opts.signal?.aborted) return abstain(CANCEL_MESSAGE);
      this.stats.errors++;
      this.hooks.onError?.({
        seat: this.seat,
        message: err?.llmParseFail ? `${err.message},这一票弃权` : (err?.message || String(err)),
      });
      return abstain(err?.llmParseFail ? '模型没给出可用的投票' : '调用失败');
    }

    const parsed = extractJson(raw);
    const voteVal = parsed?.vote ?? parsed?.target ?? parsed?.seat;
    let target = null;
    let invalid = '';
    if (voteVal === null || voteVal === undefined) {
      invalid = '模型自己选择了弃票';
    } else {
      // 提示词要求「几号」(1 基);这里再兜一层容错:也接受 0 基(仅当 1 基越界时)
      const n = Math.round(Number(voteVal));
      if (Number.isInteger(n) && view.voteCandidates.includes(n - 1)) target = n - 1;
      else if (Number.isInteger(n) && view.voteCandidates.includes(n)) target = n;
      else invalid = `投票目标不在合法候选里(${voteVal})`;
    }
    if (target === null) return abstain(invalid);

    let reason = cleanSay(parsed?.reason ?? parsed?.why ?? '', 25);
    const leak = checkSayLeak(reason, { word: view.me.word, blank: !!view.me.blank });
    if (leak) {
      // 理由泄漏**不弃票** —— 票是有效的动作,理由只是公开的修辞,
      // 换成一句中性的即可(投票目标是模型的选择,不该因为措辞被作废)。
      this.stats.filtered++;
      this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 投票理由被拦(${leak.why}),换成中性理由`);
      reason = '他那句跟大多数人说的对不上。';
    }

    this.stats.llmOk++;
    return {
      target,
      thinking: String(parsed?.thinking ?? parsed?.reason ?? '').slice(0, 200),
      reason,
      source: 'llm',
      elapsedMs: Date.now() - started,
    };
  }

  /* ------------------------------------------------------------ 内部 */

  async _call(system, user, signal, validator) {
    return this.callLLM(system, user, signal, null, {
      retryCtx: this._retryCtx(),
      validator,
      // 描述/投票都是短句,不需要大额度;但也不能压到推理型模型给不出正式回答
      maxTokens: Math.max(300, Math.min(Number(this.cfg?.maxTokens) || 600, 1200)),
    });
  }

  /**
   * 重试外壳的 validator:这一次的回答「能用」吗?
   * 只做粗判(有 JSON、要么有一个中文 say、要么有一个像样的 guess),
   * 真正的解析仍然只有 _parseDescribe 一处。
   */
  _validateDescribe() {
    const text = this._lastRaw;
    if (this.lastTruncated) return { verdict: 'truncated' };
    if (!String(text || '').trim()) return { verdict: 'empty' };
    const parsed = extractJson(text);
    if (!parsed) return { verdict: 'action' };
    // 猜词那条分支:有 action:"guess" 就按猜词校验(guess 必须是一个中文词)。
    // ⚠️ 只有 action 明确写了 guess 才算 —— 描述 JSON 里偶尔会带一个 guess 字段
    //    (模型自作主张),那个不该被当成「它想猜词」。
    if (String(parsed.action ?? '').toLowerCase() === 'guess') {
      const g = normalizeGuess(parsed.guess ?? parsed.word ?? parsed.answer);
      if (!g || !/\p{Script=Han}/u.test(g)) return { verdict: 'action' };
      return null;
    }
    const say = parsed.say ?? parsed.description ?? parsed.text;
    if (typeof say !== 'string' || !say.trim()) return { verdict: 'action' };
    // 中文是硬要求:英文描述在这个游戏里根本没法互相比较
    if (!/\p{Script=Han}/u.test(say)) return { verdict: 'action' };
    return null;
  }

  _validateVote(view) {
    const text = this._lastRaw;
    if (this.lastTruncated) return { verdict: 'truncated' };
    if (!String(text || '').trim()) return { verdict: 'empty' };
    const parsed = extractJson(text);
    if (!parsed) return { verdict: 'vote' };
    const v = parsed.vote ?? parsed.target ?? parsed.seat;
    if (v === null || v === undefined) return null;          // 显式弃票是合法的
    const n = Math.round(Number(v));
    if (!Number.isInteger(n)) return { verdict: 'vote' };
    // 这里只判「是不是一个可能的座位号」;是否在候选里由 vote() 最终判
    if (n < 0 || n > view.seats.length) return { verdict: 'vote' };
    return null;
  }

  /**
   * 解析描述轮的回答。两种形状:
   *   ① `{"action":"describe","say":"…","self_read":"…"}` —— action 可以省略
   *      (老提示词 / 模型习惯),省略时按描述处理;
   *   ② `{"action":"guess","guess":"<词>","self_read":"undercover"}` —— 放弃描述改猜词。
   *
   * ⚠️ 为什么**不**凭「有没有 guess 字段」判动作:描述 JSON 里也允许带 guess 字段
   *    (模型有时会多写一个「我猜的平民词」当备注),那不能变成一次真赌 —— 一次误判
   *    就是整局胜负。
   * @returns {{action:'describe'|'guess', say:string, guess:string, thinking:string,
   *            selfRead:string, avoid:any, elapsedMs:number}|null}
   */
  _parseDescribe(raw, view, elapsed) {
    const parsed = extractJson(raw);
    if (!parsed) return null;
    const thinking = String(parsed.thinking ?? parsed.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const selfRead = normalizeSelfRead(parsed.self_read ?? parsed.selfRead ?? parsed.self);
    const action = String(parsed.action ?? '').toLowerCase() === 'guess' ? 'guess' : 'describe';
    if (action === 'guess') {
      const guess = normalizeGuess(parsed.guess ?? parsed.word ?? parsed.answer);
      if (!guess) return null;
      return {
        action, guess, say: '', thinking, selfRead, avoid: parsed.avoid, elapsedMs: elapsed,
      };
    }
    const say = cleanSay(parsed.say ?? parsed.description ?? parsed.text, 30);
    if (!say || !/\p{Script=Han}/u.test(say)) return null;
    return {
      action, say, guess: '', thinking, selfRead, avoid: parsed.avoid, elapsedMs: elapsed,
    };
  }
}
