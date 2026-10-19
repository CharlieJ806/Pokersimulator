/**
 * 「狼人杀」的提示词 —— 纯函数,输入一份 view,输出一段中文。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么提示词单独一个文件(而不是塞进 agent.js)
 *
 *   · 提示词是这个游戏**最需要被审的东西**:它有没有泄漏别人的身份、
 *     有没有把当前胜负规则写清、有没有把「声明」写成「事实」——
 *     这些都要能被测试逐条断言(tools/werewolftest.mjs 直接调这里的函数,
 *     也在真实请求体上再断言一遍);
 *   · agent.js 只该管「调用 / 解析 / 过滤 / 降级」,和卧底那一层对称。
 *
 * ────────────────────────────────────────────────────────────────
 * 三条硬要求(研究文档点名的,都有测试盯着)
 *
 * ① **三段式私有信息块**:`【你能确定的信息】/【只是听说的声明】/【你不知道的】`。
 *    这是把「事实 / 声明 / 未知」硬分开的唯一有效手段 —— 模型最典型的错误是
 *    把「2 号说自己是预言家」记成「2 号是预言家」,然后整局推理建在沙上
 *    (研究文档「坑 3」)。
 *
 * ② **公开角色配置只发数量、不发座位**。写进【本局公开角色配置】那一段,
 *    并在下面紧跟一句「不对应任何座位」—— 少了这句,模型会把计数表读成座位表。
 *
 * ③ **当前胜负规则必须写进提示词**(屠边 / 屠城)。研究文档原话:
 *    「这条必须进提示词,否则狼队会乱刀」。规则文案的真源在 kernel 的
 *    winConditionText(),这里只负责把它摆到显眼位置。
 */

import { cleanBubble, NEUTRAL_SPEECH } from './filter.js';
import { roleLabel } from './engine/kernel.js';
// 【你的最终目标】那段(三个游戏共用):目标不是赢这一局,而是本场排名靠前。
// 排名是**公开信息**(积分榜就摆在界面上),身份/队友/刀口不在这段里。
import { matchGoalBlock } from '../../shared/leaderboard.mjs';

/** 座位号口语化:0 → 「1号」 */
function seatLabel(seat) {
  return `${Number(seat) + 1}号`;
}

/** 把 [{seat,name,alive}] 拼成「1号(小明)、2号(阿强)…」 */
function seatsLine(list) {
  return list.map((s) => `${seatLabel(s.seat)}${s.name && s.name !== `${s.seat + 1}号` ? `(${s.name})` : ''}`
    + (s.alive === false ? '[已出局]' : '')).join('、');
}

/* ==================================================================== *
 * 系统提示词
 * ==================================================================== */

/**
 * 系统提示词 —— 规则 + 私有视角 + 撒谎边界 + 引用纪律 + 输出格式。
 *
 * ⚠️ 这里**只**能出现「本局公开角色配置」里的计数与「你自己」的身份。
 *    别人的身份一句都不能有(连暗示都不行)-> tools/werewolftest.mjs 有断言。
 *
 * @param {object} view buildView() 的产物
 * @param {object} persona 性格(名字 / 说话习惯 / 推理方式 / 常见误判)
 */
export function buildSystemPrompt(view, persona = {}) {
  const p = persona || {};
  const me = view.me;
  const isWolf = me.role === 'werewolf';
  const lines = [];

  lines.push('你正在玩桌游「狼人杀」。你是牌桌上的一个玩家,不是主持人、不是解说、不是 AI 助手。');
  lines.push(`别人叫你「${me.name || seatLabel(me.seat)}」,你坐 ${seatLabel(me.seat)}。`);
  lines.push('');

  lines.push('【这个游戏怎么玩】');
  lines.push('· 桌上有两种人:好人(预言家、女巫、平民)和狼人。狼人每晚共同杀一个人。');
  lines.push('· 每个白天:主持人公布昨夜谁出局(**不公布身份**)→ 所有人依次发言 → 全体放逐投票 → 票最多的人出局。');
  lines.push('· 平票时本轮无人出局。出局的人**不公开身份**,所以「他是什么」永远只能靠推理。');
  lines.push('· 本局**没有**守卫、没有猎人、没有白痴、没有警长、没有自爆 —— 不要提这些不存在的角色和机制。');
  lines.push('· 夜里没有发言;白天投票之前,昨夜的刀口就已经定了。**不能用「他今天跳了什么身份」解释昨夜为什么被刀。**');
  lines.push('');

  lines.push('【★ 本局当前的胜负规则(决定了狼队该怎么刀,也决定了好人该守哪条线)】');
  lines.push(view.winConditionText);
  lines.push(`（狼队的刀法提示:${view.winConditionHint}）`);
  lines.push('');

  lines.push('【本局公开角色配置】');
  lines.push(view.rosterText);
  lines.push('说明:这只表示**开局每个角色有几个**,不对应任何座位,也不表示这些角色现在是否还活着。');
  lines.push('换句话说:你可以用它算「场上最多还剩几个狼」,但**不能**从它推出「几号是什么」。');
  lines.push('');

  /**
   * ★【你的最终目标】—— 用户口径:每个模型的目标都是**本场排名尽量靠前**,
   * 不是赢下这一局。狼人杀一局可能打三四十分钟,「这一局输赢」和
   * 「这一场连打几局谁名次高」是两件事 —— 落后时要敢赌(悍跳/对跳/强势带票),
   * 领先时该收(别为了一个漂亮的白天把已经到手的分数送掉)。
   *
   * 数据来自 view.matchStandings(屏幕的本场积分表,**公开信息**:
   * 座位 / 名字 / 积分)。身份、队友、刀口、药水一律不在这一段里。
   *
   * ⚠️ 为什么放在**系统**提示词:狼人杀的发言/投票/夜间三处的 user 提示词
   *    都以 privateBlock(三段式私有信息)开头,把目标段塞进其中任何一处,
   *    另外两处就没有了。系统提示词每次调用都会重建(参数里带 view),
   *    放这里三处自然一致。
   */
  const st = view.matchStandings;
  lines.push(matchGoalBlock(st?.ranking || [], {
    selfSeat: me.seat,
    rounds: Number(st?.rounds) || 0,
    scoreUnit: '分',
    title: '本场积分',
  }));
  lines.push('');

  lines.push('【你是谁】');
  lines.push(`你是 ${seatLabel(me.seat)}(${me.name}),身份:**${me.roleLabel}**。`);
  if (isWolf) {
    lines.push('· 你是狼人。狼人每晚共同杀一个人,白天要装成好人。');
    lines.push('· 你的队友只有下面【你能确定的信息】里列出的那些 —— 不要在公开发言里提他们。');
  } else if (me.role === 'seer') {
    lines.push('· 你是预言家。每晚你可以查验一个人是「狼人」还是「好人」,结果只有你知道。');
    lines.push('· 白天你要决定:**跳身份报查验**(把信息交给好人,但会被狼人盯上)、'
      + '还是**先藏着**(活得久,但好人没有硬信息)。这个取舍是你这一局最主要的决策。');
    lines.push('· 如果有人抢先跳了预言家,他大概率是狼在悍跳 —— 你要不要对跳,自己判断。');
  } else if (me.role === 'witch') {
    lines.push('· 你是女巫。你有一瓶解药(救下今晚被刀的人)和一瓶毒药(毒死一个人),**全局各一瓶,每晚最多用一瓶**。');
    lines.push('· 你会在夜里看到今晚谁被刀。解药只能救**今晚被刀的那个人**,而且**不能救自己**。');
    lines.push('· 毒药可以在白天开局前毒死任何人 —— 毒错了就是帮狼人。');
  } else {
    lines.push('· 你是平民。你没有夜间技能,只有一张票和一张嘴。');
    lines.push('· 你的价值在于:听谁的发言站不住、谁的票型和发言对不上,然后把票投对。');
  }
  lines.push('');

  lines.push('【撒谎的边界 —— 这条决定你能不能说真话】');
  if (isWolf) {
    lines.push('· **允许**:隐藏身份、谎报身份(包括悍跳预言家/女巫)、编造自己的查验、误导别人、假装好人。');
    lines.push('· **不允许**:说出「我是狼」「我们狼队」「我的队友是几号」;说出昨夜真实刀了谁;'
      + '引用一条不存在的发言或一次不存在的投票。');
    lines.push('· 一句话:**你可以骗人,但不能编造这个世界发生过什么。**');
    lines.push('· 狼队可选的打法(开局挑一个,全程保持一致):'
      + '①深水(装普通好人,只给怀疑对象);②悍跳(抢跳预言家,报一张**固定的假查验表**,之后每晚补一条);'
      + '③倒钩(站真预言家这边,骗信任,后期带节奏)。');
  } else {
    lines.push('· 好人也可以骗人(比如诈身份、故意示弱),但**编造事实**一样是错的:'
      + '不要说一条别人没说过的话,不要编一个不存在的票型。');
    lines.push('· 你可以自称任何身份(包括你不具备的),但要清楚:说了之后这一局就得一直圆下去。');
  }
  lines.push('');

  lines.push('【引用纪律】');
  lines.push('· 你的每一条判断,只能引用【你能确定的信息】和【只是听说的声明】里出现过的东西。');
  lines.push('· 没出现过的细节一律不存在:不要描述表情、眼神、语气、摸牌动作 —— 这是文字游戏,你看不到这些。');
  lines.push('· 玩家原话是**声明**,不是**事实**。要写「某号声称自己是预言家」,不能直接断言「他就是预言家」。');
  lines.push('· 如果你要判断【你不知道的】区间里的事,只能写「我怀疑 / 我认为」,不能写「我知道 / 事实上 / 很明显」。');
  lines.push('');

  lines.push('【怎么发言(每个白天一轮,你是其中一个)】');
  lines.push('· 必须包含三件套:①今天最怀疑谁、为什么(引用某句话或某个票型);②最相信谁、为什么;③这一票打算给谁。');
  lines.push('· 长度:第 1 天 120~220 字;第 2 天以后 60~150 字(只讲**新增**信息,禁止复述上一轮说过的话)。');
  lines.push('· 输出成 **2~4 条气泡**(`say` 是字符串数组),每条 15~40 字 —— 一条一句,前端会逐条打出来。');
  lines.push('· 禁止套话:「我是好人,我怀疑 3 号,因为他发言很飘」这种零信息的句子。要么引用具体内容,要么给新角度。');
  lines.push('· 禁止复读:不要重复自己上一轮说过的观点,除非有新证据。');
  lines.push('');

  lines.push('【投票的一致性(硬规则)】');
  lines.push('· 如果你今天的发言里说了要投谁(`stake` 字段),投票就**必须**投那个人。');
  lines.push('· 只有在你发言之后出现了**新的身份声明 / 新的查验声明 / 主持人公告**,才允许改投,'
    + '并且必须在 `changed_from` 里写上原来打算投谁、在 `reason` 里写明是哪一条新证据。');
  lines.push('· 如果发言里没说过投谁,按你自己的分析决定,但不要编造「我早就说了」。');
  lines.push('');

  lines.push('【发言发出去之前,自查这四条(中一条就重写)】');
  lines.push('1. 有没有出现我队友的座位号(狼)?');
  lines.push('2. 有没有提到昨晚真实的刀口 / 谁被救了 / 谁被毒了?');
  lines.push('3. 有没有说「我是狼」「我们狼人」这类话?');
  lines.push('4. 有没有引用自己其实没说过、或别人没说过的话?');
  lines.push('');

  lines.push('【输出格式】(严格 JSON,不要 markdown 代码块,不要多余的话)');
  lines.push('发言:{"thinking":"私密推理,1~2 句中文,不超过 80 字","say":["第一句","第二句"],"stake":打算投几号(数字)或 null}');
  lines.push('投票:{"thinking":"私密推理,不超过 200 字","vote":几号(数字),"reason":"能当众说出口的理由,25 字以内","changed_from":原来打算投几号或 null}');
  lines.push('夜间(狼人):{"thinking":"…","action":"kill","target":几号}  —— 空刀写 "action":"none"');
  lines.push('夜间(预言家):{"thinking":"…","action":"check","target":几号} —— 不验写 "action":"none"');
  lines.push('夜间(女巫):{"thinking":"…","action":"save"|"poison"|"none","target":几号}');
  lines.push('说明:thinking 是私密的,可以说真话;say / reason 是所有人都听得到的,绝不能报出真实的狼队友与真实刀口。');
  lines.push('座位号一律用「几号」(1 表示 1号),不要用 0 基下标。');
  lines.push('');

  lines.push('【你的说话风格】');
  lines.push(`别人对你的印象是「${p.tag || '普通'}」:${p.style || '正常聊天,不抢话也不装深沉。'}`);
  if (p.verbosity === 'short') lines.push('你说话偏短,能两句说完绝不说三句。');
  else if (p.verbosity === 'long') lines.push('你话偏多,喜欢把一件事说透。');
  if (p.reasoning) lines.push(`你的推理习惯:${p.reasoning}`);
  if (p.blindspot) lines.push(`你自己没意识到的毛病:${p.blindspot}(不要主动提它,但它会影响你的判断)。`);
  lines.push('风格只影响语气,**不影响**上面那些规则与禁止项。');

  return lines.filter(Boolean).join('\n');
}

/* ==================================================================== *
 * 三段式私有信息块
 * ==================================================================== */

/**
 * 【你能确定的信息】—— 事实区。
 * 只放**主持人确认过**的东西 + 自己角色的私有信息。
 * ⚠️ 这里绝不能出现别人的身份(测试盯着这一条)。
 */
function certainBlock(view) {
  const me = view.me;
  const out = [];
  out.push('【你能确定的信息】(这些是事实,主持人确认过)');
  out.push(`· 你是 ${seatLabel(me.seat)}(${me.name}),身份:${me.roleLabel}${me.alive ? '' : '(你已出局)'}。`);
  if (me.role === 'werewolf' && me.teammates) {
    const mates = me.teammates.length
      ? me.teammates.map((t) => `${seatLabel(t.seat)}${t.alive ? '' : '[已出局]'}`).join('、')
      : '(没有其他狼队友了 —— 你是最后一只狼)';
    out.push(`· 你的狼队友:${mates}。⚠️ 这条**只有狼队知道**,公开场合一个字都不能提。`);
    const kills = (me.wolfKills || []).filter((k) => k.target !== null);
    if (kills.length) {
      out.push(`· 狼队夜里定过的刀口:${kills.map((k) => `第${k.day}夜刀 ${seatLabel(k.target)}`).join(';')}。`);
    }
  }
  if (me.role === 'seer') {
    const checks = me.checks || [];
    if (!checks.length) out.push('· 你还没有验过人。');
    else {
      out.push('· 你的查验记录(只有你知道):');
      for (const c of checks) {
        out.push(`  - 第 ${c.day} 夜验 ${seatLabel(c.target)} → **${c.result === 'wolf' ? '狼人' : '好人'}**`);
      }
    }
  }
  if (me.role === 'witch') {
    const w = me.witch || {};
    out.push(`· 你的药:解药${w.antidote ? '还在' : '**已经用掉**'},毒药${w.poison ? '还在' : '**已经用掉**'}。`);
    if (w.killTarget !== null && w.killTarget !== undefined) {
      out.push(`· **今晚被刀的是 ${seatLabel(w.killTarget)}** —— 你要决定救不救(解药不能自救)。`);
    }
  }
  // 公开的硬事实:谁死了、谁被放逐、票型
  const dead = view.seats.filter((s) => !s.alive);
  out.push(`· 现在存活 ${view.aliveCount} 人:${seatsLine(view.seats.filter((s) => s.alive))}。`);
  if (dead.length) {
    const d = view.deaths.map((x) => `${seatLabel(x.seat)}(第${x.day}天)`).join('、');
    out.push(`· 已经出局:${d} —— **身份都没有公开**,死的是狼是神谁也不知道。`);
  }
  if (view.days.length) {
    out.push('· 每天的天亮结果与票型(公开):');
    for (const day of view.days) {
      const deaths = day.peaceful ? '平安夜' : (day.deaths.length
        ? `出局 ${day.deaths.map((s) => seatLabel(s)).join('、')}` : '无记录');
      const voteTxt = day.votes.length
        ? day.votes.map((v) => (v.to === null ? `${seatLabel(v.from)}弃票` : `${seatLabel(v.from)}→${seatLabel(v.to)}`)).join(' ')
        : '无票';
      const exit = day.exiled !== null ? `,${seatLabel(day.exiled)}被放逐` : (day.tie ? ',平票无人出局' : '');
      out.push(`  - 第 ${day.day} 天:${deaths}${exit};票型 ${voteTxt}`);
    }
  }
  return out;
}

/**
 * 【只是听说的声明】—— 声明区。
 * 这一段**只放玩家原话**,而且必须是「某号声称/认为」的形态。
 * ⚠️ 一条也不能写成既成事实 —— 研究文档「坑 3」。
 */
function claimsBlock(view) {
  const out = [];
  out.push('');
  out.push('【只是听说的声明】(这些是玩家的声明,不是事实;未经主持人确认)');
  const claims = view.claims || [];
  if (!claims.length) {
    out.push('· (还没有人报身份或查验。)');
  } else {
    // 同一条声明只留最后一次(重复报同一件事只会把提示词撑长)
    const seen = new Set();
    const kept = [];
    for (const c of claims.slice().reverse()) {
      const key = `${c.by}|${c.kind}|${c.value}|${c.target ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(c);
    }
    for (const c of kept.reverse()) {
      out.push(`· ${c.text}(第 ${c.day} 天,**${seatLabel(c.by)} 的说法,未经确认**)`);
    }
    out.push('· 注意:上面这些是机器从发言里摘出来的,**可能漏掉一些说法**;');
    out.push('  漏掉不代表没发生 —— 你读下面的发言原文时以自己的判断为准。');
    out.push('  「某号声称自己是预言家」≠「他就是预言家」。有人对跳时,通常一真一假;'
      + '只有一个人跳、没人对跳时,才**大概率**是真的。');
  }
  return out;
}

/**
 * 【你不知道的】—— 未知区。
 * 按角色裁掉它其实知道的东西:女巫不用被提醒「你不知道女巫用没用解药」。
 */
function unknownBlock(view) {
  const me = view.me;
  const out = [];
  out.push('');
  out.push('【你不知道的 —— 不许假装知道】');
  out.push('· 其他每个座位**真实的身份**(这是这个游戏的核心未知)。');
  const isWitch = me.role === 'witch';
  const isWolf = me.role === 'werewolf';
  if (!isWitch) out.push('· 女巫有没有用药、救了谁、毒了谁。');
  if (!isWolf) out.push('· 昨夜狼队真实想刀的是谁、刀口有没有被守住或救活。');
  else out.push('· 被刀的人有没有被女巫救下来(如果天亮是平安夜,你只知道有人救了,不知道是谁救的)。');
  if (me.role !== 'seer') out.push('· 预言家验过谁、验出了什么(除非他自己说出来)。');
  out.push('· 出局的人是什么身份 —— 主持人只公布「谁出局」,**从来不公布身份**。');
  out.push('· 别人心里怎么想的、有没有在说谎。');
  return out;
}

/** 三段式私有信息块拼起来(发言 / 投票 / 夜间共用同一份,免得三处长得不一样) */
export function privateBlock(view) {
  return [...certainBlock(view), ...claimsBlock(view), ...unknownBlock(view)].join('\n');
}

/** 最近几天的发言原文(逐字;只保留最近 2 天,更早的看上面的摘要) */
function transcriptBlock(view, keepDays = 2) {
  const out = [];
  const from = Math.max(1, view.day - keepDays + 1);
  const recent = view.speeches.filter((s) => s.day >= from);
  if (!recent.length) return '';
  out.push('');
  out.push(`【最近两天的发言原文】(第 ${from}~${view.day} 天,逐字,只有公开发言)`);
  let curDay = null;
  for (const s of recent) {
    if (s.day !== curDay) { curDay = s.day; out.push(`  ── 第 ${curDay} 天 ──`); }
    out.push(`  ${seatLabel(s.seat)}:${(s.say || []).join(' ')}`);
  }
  return out.join('\n');
}

/* ==================================================================== *
 * 发言 / 投票 / 夜间 的 user 提示词
 * ==================================================================== */

/**
 * 发言轮的 user 提示词。
 * @param {object} view
 * @param {{orderIdx?:number}} [opts]
 */
export function buildSpeechPrompt(view, opts = {}) {
  const lines = [];
  const idx = opts.orderIdx ?? 0;
  lines.push(`第 ${view.day} 天 · 白天发言轮。你是 ${seatLabel(view.seat)}(${view.me.name})。`);
  lines.push('');
  lines.push(privateBlock(view));
  lines.push('');
  const said = view.speeches.filter((s) => s.day === view.day);
  if (said.length) {
    lines.push('【今天已经发过言的人】');
    for (const s of said) lines.push(`  ${seatLabel(s.seat)}:${(s.say || []).join(' ')}`);
    lines.push('(不要复述他们说过的观点;要么补充新角度,要么明确表态支持/反对谁。)');
    lines.push('');
  } else {
    lines.push('【今天还没有人发过言 —— 你是第一个。】');
    lines.push('(这意味着:你没有任何「今天的发言」可以引用。不要编造「刚才谁说了一句…」。)');
    lines.push('');
  }
  const tr = transcriptBlock(view);
  if (tr) { lines.push(tr); lines.push(''); }

  lines.push(`【轮到你了】你是今天第 ${idx + 1} 个发言的人。`);
  lines.push(`长度:${view.day === 1 ? '120~220 字' : '60~150 字'},拆成 2~4 条气泡(每条 15~40 字)。`);
  lines.push('必须包含:①最怀疑谁+为什么(引用具体某句话或某个票型)②最相信谁+为什么 ③这一票打算给谁(stake)。');
  lines.push('');
  lines.push('只输出那个 JSON:{"thinking":"…","say":["…","…"],"stake":几号或 null}');
  return lines.join('\n');
}

/**
 * 投票轮的 user 提示词。
 * 一致性要求写在这里(也与系统提示词里的那条呼应):改票必须写 changed_from。
 */
export function buildVotePrompt(view) {
  const lines = [];
  lines.push(`第 ${view.day} 天 · 放逐投票。你是 ${seatLabel(view.seat)}(${view.me.name})。`);
  lines.push('');
  lines.push(privateBlock(view));
  lines.push('');
  const mine = view.mySpeechToday || [];
  const stake = view.myStakeToday;
  if (mine.length) {
    lines.push('【你今天说过的话】');
    for (const b of mine) lines.push(`  「${b}」`);
    if (stake !== null && stake !== undefined) {
      lines.push(`你在发言里**明确说了要投 ${seatLabel(stake)}**(stake)。`);
      lines.push(`→ 默认就投 ${seatLabel(stake)}。只有出现**新的身份声明 / 新的查验声明 / 主持人公告**才允许改投,`
        + '并且要把原来打算投的人写进 `changed_from`。');
    } else {
      lines.push('你在发言里没有明确说投谁 —— 按你上面的推理决定,但不要编造「我早就说了」。');
    }
  } else {
    lines.push('【你今天没有发过言】(你是刚被跳过的,或者今天的发言轮还没轮到你就进了投票。)');
    lines.push('那就按上面的公开信息判断,不要假装自己说过什么。');
  }
  lines.push('');
  const cands = view.voteCandidates.map((s) => seatLabel(s));
  lines.push(`【你能投的人】${cands.length ? cands.join('、') : '(没有人可投 —— 这不该发生)'}`);
  lines.push('不能投自己,不能投已经出局的人。');
  lines.push('');
  lines.push('【怎么想这一步】');
  lines.push('· 谁跳了身份、有没有人对跳?(一真一假?还是双狼演戏?)');
  lines.push('· 谁的票型和发言对不上(说投 A 却投了 B)?谁在跟票而不给理由?');
  lines.push('· 昨晚的刀口和今天的发言有没有矛盾(谁在替死人说话 / 谁在替被刀的人喊话)?');
  lines.push('');
  lines.push('【输出】只输出 JSON:{"thinking":"…","vote":几号,"reason":"≤25 字的公开理由","changed_from":原来打算投几号或 null}');
  lines.push('reason 是**当众说出口**的一句话,绝不能含私有信息(队友、真实刀口、用药)。');
  return lines.join('\n');
}

/**
 * 夜间的 user 提示词。三种角色三种说法,但**共用同一个三段式信息块**。
 * @param {object} view
 * @param {'wolves'|'seer'|'witch'} step
 */
export function buildNightPrompt(view, step) {
  const lines = [];
  const nightNo = view.day;
  lines.push(`第 ${nightNo} 夜 · ${step === 'wolves' ? '狼人行动' : step === 'seer' ? '预言家行动' : '女巫行动'}。`);
  lines.push('');
  lines.push(privateBlock(view));
  lines.push('');
  const alive = view.seats.filter((s) => s.alive);

  if (step === 'wolves') {
    const mates = (view.me.teammates || []).filter((t) => t.alive).map((t) => seatLabel(t.seat));
    lines.push(`【狼队】你和 ${mates.length ? mates.join('、') : '(无人)'} 都还活着。`);
    lines.push('今天白天谁说得好、谁最像神职、谁最该闭嘴 —— 现在你一个人决定这一刀。');
    lines.push(`【今晚的刀法】${view.winConditionHint}`);
    const pool = alive.filter((s) => s.seat !== view.seat && !(view.me.teammates || []).some((t) => t.seat === s.seat));
    lines.push(`【你能刀的人】${pool.map((s) => seatLabel(s.seat)).join('、')}`);
    lines.push('不能刀自己,不能刀队友。空刀(不杀)写 "action":"none"。');
    lines.push('');
    lines.push('只输出 JSON:{"thinking":"…","action":"kill","target":几号}');
    return lines.join('\n');
  }

  if (step === 'seer') {
    const checked = (view.me.checks || []).map((c) => seatLabel(c.target));
    lines.push('【今晚验谁】你的查验结果只有你自己知道。');
    lines.push('优先验:白天最像狼的人;或者最像神职、你想确认他是好人的那个。');
    const pool = alive.filter((s) => s.seat !== view.seat);
    lines.push(`【你能验的人】${pool.map((s) => seatLabel(s.seat)).join('、')}`);
    if (checked.length) lines.push(`(已经验过:${checked.join('、')} —— 再验一次没有新信息。)`);
    lines.push('不验写 "action":"none"。');
    lines.push('');
    lines.push('只输出 JSON:{"thinking":"…","action":"check","target":几号}');
    return lines.join('\n');
  }

  // witch
  const w = view.me.witch || {};
  lines.push('【你的药】');
  lines.push(`· 解药:${w.antidote ? '还在' : '已经用掉'}`);
  lines.push(`· 毒药:${w.poison ? '还在' : '已经用掉'}`);
  if (w.killTarget !== null && w.killTarget !== undefined) {
    lines.push('');
    lines.push(`【今晚被刀的是 ${seatLabel(w.killTarget)}】`);
    lines.push('你可以用解药救他(解药不能自救),或者用毒药毒别人,或者什么都不做。');
    lines.push('**每晚最多用一瓶药。** 救下来的那一次会变成平安夜 —— 但你自己要清楚是谁救的。');
  } else {
    lines.push('');
    lines.push('【今晚是平安夜(没有人被刀)】所以解药没有目标可救。');
  }
  lines.push('');
  lines.push('决定:救(save)/ 毒(poison)/ 不用(none)。毒错了就是帮狼人,慎重。');
  lines.push('只输出 JSON:{"thinking":"…","action":"save"|"poison"|"none","target":几号}');
  return lines.join('\n');
}

/* ==================================================================== *
 * 兜底文案
 * ==================================================================== */

/**
 * 兜底发言(**确定性**):解析失败 / 被过滤两次都过不去时用。
 * 直接复用 filter 里的 NEUTRAL_SPEECH(同一份池子,不留第二套文案)。
 */
export function fallbackSpeech(seat, day) {
  const i = Math.abs((Number(seat) || 0) * 7 + (Number(day) || 0) * 13) % NEUTRAL_SPEECH.length;
  return NEUTRAL_SPEECH[i].map((s) => cleanBubble(s, 60));
}

/** 角色 → 中文(给别的模块用,避免各处写一遍映射) */
export { roleLabel };
