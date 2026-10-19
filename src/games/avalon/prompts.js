/**
 * 「阿瓦隆」的提示词 —— 纯函数,输入一份 view,输出一段中文。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么提示词单独一个文件(而不是塞进 agent.js)
 *
 *   · 提示词是这个游戏**最需要被审的东西**:它有没有泄漏别人的身份、
 *     有没有把公开任务表写成座位表、有没有把「声明」写成「事实」——
 *     这些都要能被测试逐条断言(tools/avalonest.mjs 直接调这里的函数,
 *     也在真实请求体上再断言一遍);
 *   · agent.js 只该管「调用 / 解析 / 过滤 / 降级」,与狼人杀那一层对称。
 *
 * ────────────────────────────────────────────────────────────────
 * 三条硬要求(与狼人杀同源,研究文档点名的,都有测试盯着)
 *
 * ① **三段式私有信息块**:`【你能确定的信息】/【只是听说的声明】/【你不知道的】`。
 *    模型最典型的错误是把「2 号说他怀疑 3 号」记成「2 号知道 3 号是坏人」,
 *    然后整局推理建在沙上。阿瓦隆里这条尤其致命:梅林的整条命就靠「没人知道
 *    他到底知道多少」。
 *
 * ② **公开配置只发数量、不发座位**。写进【本局公开配置】那一段,
 *    并在下面紧跟一句「不对应任何座位」—— 少了这句,模型会把计数表读成座位表。
 *
 * ③ **当前任务表必须写进提示词**(第几轮几人上车 / 几张失败票)。
 *    阿瓦隆的选人和否决策略完全取决于它:第 4 轮要 2 张失败票(7 人起),
 *    所以那一轮「队伍里只有 1 个坏人」是安全的 —— 模型不知道这件事就会乱否。
 */

import { cleanBubble, NEUTRAL_SAY } from './filter.js';
import { roleLabel, sideLabel, rosterText, missionTableText } from './engine/kernel.js';

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
 * ⚠️ 这里**只**能出现「本局公开配置」里的计数与「你自己」的身份。
 *    别人的身份一句都不能有(连暗示都不行)-> tools/avalonest.mjs 有断言。
 *
 * @param {object} view buildView() 的产物
 * @param {object} persona 性格(名字 / 说话习惯 / 推理方式 / 常见误判)
 */
export function buildSystemPrompt(view, persona = {}) {
  const p = persona || {};
  const me = view.me;
  const evil = me.side === 'evil';
  const lines = [];

  lines.push('你正在玩桌游「阿瓦隆」(抵抗组织)。你是牌桌上的一个玩家,不是主持人、不是解说、不是 AI 助手。');
  lines.push(`别人叫你「${me.name || seatLabel(me.seat)}」,你坐 ${seatLabel(me.seat)}。`);
  lines.push('');

  lines.push('【这个游戏怎么玩】');
  lines.push('· 桌上有两个阵营:好人(梅林 / 派西维尔 / 忠臣)和坏人(刺客 / 莫甘娜 / 莫德雷德 / 爪牙)。');
  lines.push('· 一局打 **5 轮任务**。每一轮:①队长选几个人上车 → ②**全员投票**赞成/反对 →'
    + '③通过则车上的人暗中投「成功/失败」→ ④数失败票。');
  lines.push('· **好人上车只能投成功**;坏人可以投成功也可以投失败(投失败就叫破坏)。');
  lines.push('· **3 轮任务成功 → 好人达成目标**;但还没完:刺客可以刺杀一个人,'
    + '刺中梅林 → **坏人翻盘胜**,没刺中 → 好人胜。');
  lines.push('· **3 轮任务失败 → 坏人立即胜**,不再刺杀。');
  lines.push('· 投票是**同时揭晓**的:所有人投完才一起亮票,所以你看不到别人怎么投再改主意。');
  lines.push('· 队伍被否决 → 换下一个座位当队长、同一轮重新提名(一轮最多 5 次提案,'
    + '第 5 次即使被否也**强制上车**)。');
  lines.push('· 本局**没有**湖中夫人、没有出局、没有人会死 —— 不要提这些不存在的机制。');
  lines.push('');

  lines.push('【★ 本局的任务表(决定了队长该选几个人、也决定了要不要投反对)】');
  lines.push(missionTableText(view.seatsTotal));
  lines.push(`现在是第 ${view.round} 轮:要 ${view.teamSize} 人上车,需要 ${view.failNeed} 张失败票这一轮才算失败。`);
  lines.push('读法:如果这一轮只需要 1 张失败票,队伍里只要混进 1 个坏人就会失败;'
    + '如果需要 2 张(7 人起的第 4 轮),那队伍里有 1 个坏人是**安全**的 —— 这是后期最关键的判断。');
  lines.push('');

  lines.push('【本局公开角色配置】');
  lines.push(view.rosterText);
  lines.push('说明:这只表示**开局每个角色有几个**,不对应任何座位。');
  lines.push('换句话说:你可以用它算「场上最多有几个坏人」,但**不能**从它推出「几号是什么」。');
  lines.push('');

  lines.push('【你是谁】');
  lines.push(`你是 ${seatLabel(me.seat)}(${me.name}),身份:**${me.roleLabel}**(${sideLabel(me.side)}阵营)。`);
  if (me.role === 'merlin') {
    lines.push('· 你是梅林。你知道**谁是坏人**(莫德雷德除外)。');
    lines.push('· 你的处境:你是好人赢的关键,也是坏人唯一的目标 —— 一旦被刺客看出来,'
      + '3 次任务成功也会被一刀翻盘。所以你的核心任务是**用推理的口吻引导队友,而不是报答案**。');
    lines.push('· 说话时把「我知道」换成「我怀疑 / 我认为 / 从票型看」;把结论拆成证据,'
      + '让人以为是你推出来的,而不是你看到的。');
  } else if (me.role === 'percival') {
    lines.push('· 你是派西维尔。你看到**两个人**,其中一个是梅林、一个是莫甘娜(坏人),但你**分不清谁是谁**。');
    lines.push('· 你的价值:替梅林挡刀、替梅林说话。常见打法是对外假跳梅林,把刺客的注意力吸到自己身上;'
      + '或者什么都不说,暗中观察这两个人里谁更像在带节奏。');
  } else if (me.role === 'loyal') {
    lines.push('· 你是忠臣。你没有任何私有信息,只有一张票和一张嘴。');
    lines.push('· 你的价值:从票型、任务结果、谁在替谁说话里找出坏人;'
      + '并且**不要乱跳梅林**(刺客会顺着假梅林摸到真梅林)。');
  } else if (me.role === 'assassin') {
    lines.push('· 你是刺客。你的队友是谁,见下面【你能确定的信息】。');
    lines.push('· 你是坏人的**最后一张底牌**:就算好人拿到 3 次任务成功,你还有一次刺杀梅林的机会。'
      + '所以整局你都要**悄悄找梅林**——谁在引导却不解释来源,谁就最像。');
    lines.push('· 破坏任务要克制:暴露太早,你会被踢出后面的队伍,也就失去了找梅林的位置。');
  } else if (me.role === 'morgana') {
    lines.push('· 你是莫甘娜。你在派西维尔眼里**和梅林长得一样** —— 这是你最大的武器。');
    lines.push('· 你的打法:假装梅林、故意给出「像有信息」的判断,让派西维尔分不清,'
      + '从而把真梅林埋在两个人里。');
  } else if (me.role === 'mordred') {
    lines.push('· 你是莫德雷德。**梅林看不到你** —— 这是全局最重要的特权。');
    lines.push('· 你的打法:主动去带节奏、甚至跳好人身份,因为梅林的名单里没有你;'
      + '但注意:你说的话也会被派西维尔/忠臣按普通坏人逻辑审视。');
  } else {
    lines.push('· 你是爪牙。你是坏人阵营的普通一员,没有特殊能力,但你的每一票都算数。');
  }
  lines.push('');

  lines.push('【撒谎的边界 —— 这条决定你能不能说真话】');
  if (evil) {
    lines.push('· **允许**:隐藏身份、谎报身份(包括假跳梅林/派西维尔/忠臣)、编造自己的怀疑、误导别人。');
    lines.push('· **不允许**:说出「我是坏人」「我们是刺客」「我的队友是几号」;'
      + '说出「我投了失败卡」;说出你要刺杀谁;引用一条不存在的发言或一次不存在的投票。');
    lines.push('· 一句话:**你可以骗人,但不能编造这个世界发生过什么。**');
  } else {
    lines.push('· 好人也可以骗人:**假跳梅林是合法且常用的打法**(挡刺杀 / 钓鱼)。');
    lines.push('· 但**不允许**编造事实:不要说一条别人没说过的话,不要编一个不存在的票型。');
    lines.push('· 注意:如果你是真梅林,把「我知道谁是坏人」直接说出来等于自报身份 —— '
      + '那不是「诚实」,那是把胜利送出去。');
  }
  lines.push('');

  lines.push('【引用纪律】');
  lines.push('· 你的每一条判断,只能引用【你能确定的信息】和【只是听说的声明】里出现过的东西。');
  lines.push('· 没出现过的细节一律不存在:不要描述表情、眼神、语气、动作 —— 这是文字游戏,你看不到这些。');
  lines.push('· 玩家的原话是**声明**,不是**事实**。要写「某号声称自己是梅林」,不能直接断言「他就是梅林」。');
  lines.push('· 如果你要判断【你不知道的】区间里的事,只能写「我怀疑 / 我认为」,不能写「我知道 / 事实上 / 很明显」。');
  lines.push('');

  lines.push('【发言与投票的纪律】');
  lines.push('· 你公开发言的机会只有两个:当队长提名时的 `say`,和投票时的 `reason`。');
  lines.push('· 队长必须给出**选人理由**(为什么带这几个人),不能只说「我挑了这几个」;'
    + '也不能把私有信息当理由(「我知道 3 号是好人」)。');
  lines.push('· 投票理由不超过 25 字,要能当众说出口:可以怀疑、可以表态,不能报私有信息。');
  lines.push('· 你的票和你的发言**要对得上**:如果你说「这一队我不放心」,就别投赞成。');
  lines.push('');

  lines.push('【出手之前,自查这四条(中一条就重写)】');
  lines.push('1. 有没有说「我是坏人 / 我们 / 我的队友」?');
  lines.push('2. 有没有说自己投了失败卡?');
  lines.push('3. 有没有说「我知道 / 我能确定 几号是……」(那是梅林才说得出口的)?');
  lines.push('4. 有没有引用自己其实没说过、或别人没说过的话?');
  lines.push('');

  lines.push('【输出格式】(严格 JSON,不要 markdown 代码块,不要多余的话)');
  lines.push('组队:{"thinking":"私密推理,1~2 句中文,不超过 80 字","team":[几号,几号],"say":"当众说的选人理由(或 1~3 句的数组)"}');
  lines.push('投票:{"thinking":"私密推理,不超过 200 字","vote":"approve"或"reject","reason":"能当众说出口的理由,25 字以内"}');
  lines.push('上车投卡:{"thinking":"私密推理","card":"success"或"fail"}');
  lines.push('刺杀:{"thinking":"为什么是他","target":几号}');
  lines.push('说明:thinking 是私密的,可以说真话;say / reason 是所有人都听得到的,绝不能报私有信息。');
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
  out.push(`· 你是 ${seatLabel(me.seat)}(${me.name}),身份:${me.roleLabel}(${sideLabel(me.side)}阵营)。`);

  if (me.side === 'evil' && me.teammates) {
    const mates = me.teammates.length
      ? me.teammates.map((t) => `${seatLabel(t.seat)}${t.name && t.name !== `${t.seat + 1}号` ? `(${t.name})` : ''}`).join('、')
      : '(没有其他同伴 —— 你是唯一的坏人)';
    out.push(`· 你的坏人同伴:${mates}。⚠️ 这条**只有坏人知道**,公开场合一个字都不能提。`);
    out.push('  (你们互相知道「谁是同伙」,但**不知道对方具体是刺客/莫甘娜/莫德雷德/爪牙** —— '
      + '官方玩法就是这样,别假装知道。)');
  }
  if (me.role === 'merlin') {
    const evil = me.knownEvil || [];
    const names = evil.length
      ? evil.map((t) => `${seatLabel(t.seat)}${t.name && t.name !== `${t.seat + 1}号` ? `(${t.name})` : ''}`).join('、')
      : '(你一个坏人都没看到 —— 这通常意味着剩下的坏人都是莫德雷德,或者局已经不存在了)';
    out.push(`· 你知道的坏人:${names}。`);
    if (me.mordredInPlay) {
      out.push('· ⚠️ 这一局有**莫德雷德**,而**他不在上面这份名单里** —— 你看不到他。'
        + '所以「名单上的人都不是坏人」不等于「桌上的坏人都在这张名单上」。');
    } else {
      out.push('· 这一局**没有莫德雷德**,所以上面这份名单就是全部坏人。');
    }
  }
  if (me.role === 'percival') {
    const pair = me.merlinCandidates || [];
    if (!me.morganaInPlay) {
      out.push(`· 你看到的「梅林」只有 ${seatLabel(pair[0]?.seat ?? 0)} 一个人(这一局没有莫甘娜)—— 那他确定就是梅林。`);
    } else if (pair.length >= 2) {
      out.push(`· 你看到的两个人:${pair.map((t) => seatLabel(t.seat)).join(' 和 ')}。`);
      out.push('  **其中一个是梅林,一个是莫甘娜,但你分不清谁是谁**。'
        + '这个名单是按座位号排的,**顺序里没有任何信息** —— 不要以为第一个就是梅林。');
    } else {
      out.push('· 你只看到一个人 —— 这不该发生(有莫甘娜时你总能看到两个),请按正常推理处理。');
    }
  }

  // 公开的硬事实:任务进度、票型、否决次数
  out.push(`· 现在第 ${view.round} 轮(共 5 轮),战况:**${view.successes} 次成功 / ${view.fails} 次失败**。`);
  out.push(`· 这一轮要 ${view.teamSize} 人上车,需要 ${view.failNeed} 张失败票才失败;`
    + `现在是本轮的**第 ${view.proposalNo} 次提名**(最多 ${view.maxProposals} 次,`
    + `第 ${view.maxProposals} 次即使被否也强制上车)。`);
  if (view.leader !== null && view.leader !== undefined) {
    out.push(`· 本轮队长:${seatLabel(view.leader)}${view.leader === me.seat ? '(就是你)' : ''}。`);
  }
  if (view.team.length) {
    out.push(`· 本轮被提名的队伍:${view.team.map((s) => seatLabel(s)).join('、')}`
      + (view.team.includes(me.seat) ? '(你在车上)' : '(你不在车上)'));
    if (view.leaderSay.length) out.push(`  队长刚才说:「${view.leaderSay.join(' ')}」`);
  }
  for (const q of view.quests || []) {
    out.push(`· 第 ${q.round} 轮任务:${q.team.map((s) => seatLabel(s)).join('、')} 上车,`
      + `${q.fails} 张失败票(需要 ${q.failNeed} 张)→ **${q.result === 'success' ? '成功' : '失败'}**`);
  }
  for (const v of view.votes || []) {
    const detail = v.votes.map((x) => `${seatLabel(x.seat)}${x.approve ? '赞成' : '反对'}`
      + `${x.reason ? `(${x.reason})` : ''}`).join(' ');
    out.push(`· 第 ${v.round} 轮第 ${v.proposalNo} 次提案表决:${v.yes} 赞成 / ${v.no} 反对 → `
      + `${v.passed ? '通过' : '否决'};票型 ${detail}`);
  }
  return out;
}

/**
 * 【只是听说的声明】—— 声明区。
 * 这一段**只放玩家原话**,而且必须是「某号声称/认为/怀疑」的形态。
 * ⚠️ 一条也不能写成既成事实。
 */
function claimsBlock(view) {
  const out = [];
  out.push('');
  out.push('【只是听说的声明】(这些是玩家的声明,不是事实;未经主持人确认)');
  const claims = view.claims || [];
  if (!claims.length) {
    out.push('· (还没有人报身份或指认别人。)');
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
      out.push(`· ${c.text}(第 ${c.round} 轮,**${seatLabel(c.by)} 的说法,未经确认**)`);
    }
    out.push('· 注意:上面这些是机器从公开发言里摘出来的,**可能漏掉一些说法**;');
    out.push('  漏掉不代表没发生 —— 你读下面的原话时以自己的判断为准。');
    out.push('  「某号声称自己是梅林」≠「他就是梅林」。有人对跳梅林时,通常一真一假;'
      + '但也可能两个都是好人(互相钓鱼),或者两个都是坏人(在找真梅林)。');
  }
  return out;
}

/**
 * 【你不知道的】—— 未知区。
 * 按角色裁掉它其实知道的东西:梅林不用被提醒「你不知道坏人是谁」。
 */
function unknownBlock(view) {
  const me = view.me;
  const out = [];
  out.push('');
  out.push('【你不知道的 —— 不许假装知道】');

  if (me.side === 'evil') {
    out.push('· **谁是梅林** —— 这是坏人唯一的空白,也是刺客整局要找的东西。');
    out.push('· 坏人之外每个人的具体身份(谁是忠臣、谁是派西维尔)。');
  } else if (me.role === 'merlin') {
    if (me.mordredInPlay) out.push('· **莫德雷德是谁** —— 你看不到他,名单里没有他。');
    out.push('· 谁是派西维尔、谁是忠臣(你只看到坏人,看不到好人阵营的细分)。');
    out.push('· 谁是刺客(刺客就在你看到的坏人里,但你看不出是哪一个)。');
  } else if (me.role === 'percival') {
    out.push('· 你看到的那两个人里,**谁是梅林、谁是莫甘娜**。');
    out.push('· 其他座位是谁;以及谁是莫德雷德(你看不到他)。');
  } else {
    out.push('· 每个人的身份(梅林是谁、坏人是谁,你完全不知道)。');
  }
  out.push('· 每一轮任务里**具体是谁**投了失败卡 —— 主持人只公布「几张失败票」,不公布是谁。');
  out.push('· 刺客会不会刺、刺谁;以及别人投票时心里真正在想什么。');
  out.push('· 别人有没有在说谎。');
  return out;
}

/** 三段式私有信息块拼起来(组队 / 投票 / 投卡 / 刺杀共用同一份,免得四处长得不一样) */
export function privateBlock(view) {
  return [...certainBlock(view), ...claimsBlock(view), ...unknownBlock(view)].join('\n');
}

/* ==================================================================== *
 * 四个动作的 user 提示词
 * ==================================================================== */

/**
 * 组队轮的 user 提示词(只发给**队长**)。
 * @param {object} view
 */
export function buildTeamPrompt(view) {
  const lines = [];
  lines.push(`第 ${view.round} 轮 · 组队。你是 ${seatLabel(view.seat)}(${view.me.name}),`
    + `本轮队长。`);
  lines.push('');
  lines.push(privateBlock(view));
  lines.push('');
  lines.push(`【你要做的事】选 ${view.teamSize} 个人上车(这一轮需要 ${view.failNeed} 张失败票才失败)。`);
  const pool = view.seats.map((s) => `${seatLabel(s.seat)}${s.name && s.name !== `${s.seat + 1}号` ? `(${s.name})` : ''}`);
  lines.push(`【能选的人】${pool.join('、')}(全部 ${view.seatsTotal} 人)`);
  lines.push(`必须正好 ${view.teamSize} 个座位号,不能重复。**可以不带自己**(规则允许,但少见)。`);
  lines.push('');
  lines.push('【怎么想这一步】');
  lines.push('· 如果这一轮只需要 1 张失败票:队伍里混进 1 个坏人就会失败 —— 尽量选你最信得过的人。');
  lines.push('· 如果需要 2 张(第 4 轮,7 人起):队伍里有 1 个坏人是安全的,'
    + '所以这一轮反而可以带一个「可疑但需要观察」的人,看他敢不敢破坏。');
  lines.push('· 想想上一轮的票型:谁反对得太快?谁在替谁说话?谁被所有人接受?');
  if (view.me.side === 'evil') {
    lines.push('· 你是坏人:选人时要**为破坏创造条件**(自己或同伴在车上),但别把坏人都塞进同一队 —— 那太显眼。');
  } else {
    lines.push('· 你是好人:选人时别把「我信的人」一次用完,后面几轮更需要他们。');
  }
  lines.push('');
  lines.push('【say 的写法】当众说一句选人理由(1~3 句,或一个字符串数组),'
    + '要能被别人听、能被别人反驳。不要报私有信息,不要报「我知道谁是坏人」。');
  lines.push('');
  lines.push(`只输出那个 JSON:{"thinking":"…","team":[${view.teamSize} 个座位号],"say":"…"}`);
  return lines.join('\n');
}

/**
 * 投票轮的 user 提示词。
 * @param {object} view
 */
export function buildVotePrompt(view) {
  const lines = [];
  lines.push(`第 ${view.round} 轮 · 投票。你是 ${seatLabel(view.seat)}(${view.me.name})。`);
  lines.push('');
  lines.push(privateBlock(view));
  lines.push('');
  lines.push(`【要表决的队伍】${view.team.map((s) => seatLabel(s)).join('、')}`
    + `(队长 ${seatLabel(view.leader ?? 0)},第 ${view.proposalNo} 次提案)`);
  if (view.leaderSay.length) lines.push(`队长说:「${view.leaderSay.join(' ')}」`);
  lines.push('');
  lines.push('【怎么想这一步】');
  lines.push('· 这一队的构成合理吗?队长为什么带这几个人?他有没有在回避谁?');
  lines.push('· 这一轮需要几张失败票?如果只需要 1 张,队伍里有一个可疑的人就够危险了。');
  lines.push('· 否掉会怎样:换下一个队长、同一轮重来(最多 5 次,第 5 次强制通过)。'
    + '所以「为否而否」会被后面的人当成搅局。');
  if (view.me.side === 'evil') {
    lines.push('· 你是坏人:队伍里有你或同伴 → 赞成;没有 → 想办法否掉(但别每次都反对,会被盯上)。');
  }
  lines.push('');
  lines.push('【输出】只输出 JSON:{"thinking":"…","vote":"approve" 或 "reject","reason":"≤25 字的公开理由"}');
  lines.push('reason 是**当众说出口**的一句话,绝不能含私有信息(同伴、失败卡、刺杀目标)。');
  return lines.join('\n');
}

/**
 * 上车投卡的 user 提示词(只发给这一轮车上的人)。
 * @param {object} view
 */
export function buildMissionPrompt(view) {
  const lines = [];
  lines.push(`第 ${view.round} 轮 · 任务卡。你是 ${seatLabel(view.seat)}(${view.me.name}),这一轮你在车上。`);
  lines.push('');
  lines.push(privateBlock(view));
  lines.push('');
  lines.push(`【这一队】${view.team.map((s) => seatLabel(s)).join('、')}`);
  lines.push(`需要 ${view.failNeed} 张失败票,这一轮才算失败。`);
  lines.push('');
  if (view.me.side === 'evil') {
    lines.push('【你要决定:成功还是失败】');
    lines.push('· 投「失败」= 破坏任务。投「成功」= 帮好人一把(伪装)。');
    lines.push('· 这一轮需要几张失败票?只需要 1 张时,**你一个人投失败就够**;');
    lines.push('  需要 2 张时(第 4 轮),必须**两个坏人同时投失败**,所以要先判断车上还有没有同伴。');
    lines.push('· 如果任务已经注定失败(失败数够了),再多投失败只是白送信息 —— 这时候投成功更划算。');
    lines.push('· 记住:结果只公布「几张失败票」,**不公布是谁**。所以破坏不是自曝,前提是别太频繁。');
  } else {
    lines.push('【你要投的卡】');
    lines.push('· 你是好人阵营,**规则只允许投「成功」**。投失败会被主持人当场判违规。');
    lines.push('· 所以这一步没有真正的选择 —— 你只需要如实投成功。');
  }
  lines.push('');
  lines.push('【输出】只输出 JSON:{"thinking":"…","card":"success" 或 "fail"}');
  return lines.join('\n');
}

/**
 * 刺杀的 user 提示词(只发给刺客,而且**没有公开发言** —— 只有 thinking + target)。
 * @param {object} view
 */
export function buildAssassinPrompt(view) {
  const lines = [];
  lines.push(`刺杀阶段。你是 ${seatLabel(view.seat)}(${view.me.name}),刺客。`);
  lines.push('');
  lines.push(privateBlock(view));
  lines.push('');
  lines.push('【局面】好人已经拿到 3 次任务成功 —— 现在只剩这一刀。');
  lines.push('刺中梅林 → **坏人翻盘胜**;刺错 → 好人胜。所以这一刀就是全场的胜负。');
  lines.push('');
  lines.push('【怎么找梅林】');
  lines.push('· 梅林知道坏人名单,所以他/她常常**在关键轮次避开那几个人**,却不解释为什么;');
  lines.push('· 梅林会用「我觉得」的口吻说出一堆很准的判断,但给不出真正的证据来源;');
  lines.push('· 派西维尔可能在假装梅林(甚至跳出来挡刀)—— 跳得最响的往往不是真梅林;');
  lines.push('· 看你自己的同伴:谁一直在针对你的同伴、却从不针对你?');
  lines.push('· 忠臣也会说准话,但他说准的那些话**能从公开信息推出来**;梅林说准的那些话推不出来。');
  lines.push('');
  const pool = view.seats.filter((s) => s.seat !== view.seat).map((s) => seatLabel(s.seat));
  lines.push(`【能刺的人】${pool.join('、')}(不能刺自己)`);
  lines.push('');
  lines.push('只输出 JSON:{"thinking":"为什么是他,1~2 句","target":几号}');
  return lines.join('\n');
}

/* ==================================================================== *
 * 兜底文案
 * ==================================================================== */

/**
 * 兜底发言(**确定性**):解析失败 / 被过滤两次都过不去时用。
 * 直接复用 filter 里的 NEUTRAL_SAY(同一份池子,不留第二套文案)。
 */
export function fallbackSay(seat, round) {
  const i = Math.abs((Number(seat) || 0) * 7 + (Number(round) || 1) * 13) % NEUTRAL_SAY.length;
  return NEUTRAL_SAY[i].map((s) => cleanBubble(s, 60));
}

/** 角色 → 中文(给别的模块用,避免各处写一遍映射) */
export { roleLabel, rosterText, missionTableText };
