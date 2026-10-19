/**
 * 「狼人杀」的 AI 代理 —— 只做三件事:**拼提示词、解析回答、把说漏嘴的话拦下来**。
 *
 * 重试 / 超时 / 取消 / 参数降级 / JSON 抽取全在 shared/llmCaller.mjs(与扑克、
 * 卧底共用),这里不重复实现。真正的规则判定在 engine/kernel.js ——
 * LLM 给的一切都只是**提议**,非法就拒,不靠提示词求它守规矩。
 *
 * ────────────────────────────────────────────────────────────────
 * 降级策略(**必须确定性**,研究文档「坑 8:随机兜底毁一致性」)
 *
 *   · 发言失败 / 被过滤两次 → 一对**固定的中性气泡**(由座位+天数决定,
 *     同一局面重跑永远同一句);
 *   · 投票失败 / 目标非法  → **弃票**(不是随机投一个 —— 上一秒说信他、
 *     下一秒投他,观众立刻出戏);
 *   · 夜间失败            → **空刀 / 不验 / 不用药**(不是随机挑一个)。
 *
 * 三种降级都不改变任何人的嫌疑,只是「这一步没有动作」。这是被动但一致的。
 *
 * ────────────────────────────────────────────────────────────────
 * 两条只有狼人杀才有的检查
 *
 * ① **投票与发言一致**(wolfcha 的做法):发言里有 `stake`(公开表态要投谁),
 *    投票投了别人却没写 `changed_from` → 带着说明重问一次;仍不一致就接受这一票
 *    (票是动作),但把 changed_from 补成 stake,界面上会标出来「改票未说明」。
 *
 * ② **夜间行动合法集**:目标必须在合法的候选里,不合法 → 换 none。
 *    agent 自己先判一遍,runner / kernel 还会再判 —— 三层都判不是重复,
 *    因为玩家模式的输入也会走同一条路。
 */

import { LlmCaller, extractJson, resolveRetryPolicy, CANCEL_MESSAGE } from '../../shared/llmCaller.mjs';
import { buildSystemPrompt, buildSpeechPrompt, buildVotePrompt, buildNightPrompt, fallbackSpeech } from './prompts.js';
import { cleanBubble, checkSpeechLeak, checkReasonLeak, repairHint } from './filter.js';

/** 座位号口语化:0 → 「1号」 */
function seatLabel(seat) {
  return `${Number(seat) + 1}号`;
}

/** 是不是中文(英文发言在这个游戏里没法互相比较,直接当解析失败) */
function hasHan(s) {
  return /\p{Script=Han}/u.test(String(s || ''));
}

/**
 * 把模型给的 `say` 收敛成 2~4 条气泡。
 * 模型可能给字符串数组(理想)、也可能给一整段字符串(常见)——
 * 后者按句末标点切开,别让「一次糊一大段」毁掉逐条打字机的节奏。
 */
function toBubbles(raw) {
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    const s = String(item ?? '');
    if (!s.trim()) continue;
    if (s.length > 90) {
      for (const part of s.split(/(?<=[。!?！?；;])/)) {
        const b = cleanBubble(part, 60);
        if (b) out.push(b);
      }
    } else {
      const b = cleanBubble(s, 60);
      if (b) out.push(b);
    }
  }
  return out.slice(0, 4);
}

/** 把「几号」收敛成 0 基座位;不在候选里返回 null */
function toSeat(raw, candidates) {
  if (raw === null || raw === undefined) return null;
  const n = Math.round(Number(raw));
  if (!Number.isInteger(n)) return null;
  // 提示词要求「几号」(1 基);这里再兜一层容错:也接受 0 基(仅当 1 基越界时)
  if (candidates.includes(n - 1)) return n - 1;
  if (candidates.includes(n)) return n;
  return null;
}

export class WerewolfAgent extends LlmCaller {
  /**
   * @param {number} seat 座位号(0 起)
   * @param {object} persona 性格 { name, tag, style, verbosity, reasoning, blindspot }
   * @param {object} cfg 该座位的模型配置(app.agentCfg 组装,与扑克/卧底同一份)
   * @param {object} hooks { onThink, onError, onDebug }
   */
  constructor(seat, persona, cfg = {}, hooks = {}) {
    super({ seat, cfg, hooks });
    this.persona = persona || {};
    /** 统计:让「这一局调了几次、兜底了几次、拦了几次」在调试时看得见 */
    this.stats = { speak: 0, vote: 0, night: 0, llmOk: 0, fallback: 0, filtered: 0, errors: 0 };
  }

  get name() { return this.persona?.name || seatLabel(this.seat); }

  /* ------------------------------------------------------------ 调用外壳 */

  _hasLLM() {
    return !!(this.cfg?.endpoint && (this.cfg?.apiKey || this.cfg?.noKey));
  }

  /** 重试会话:每次「发言 / 投票 / 夜间行动」各一条死线,与扑克/卧底的用法一致 */
  _retryCtx() {
    const policy = resolveRetryPolicy(this.cfg);
    const started = Date.now();
    return { startedAt: started, deadline: started + policy.budgetMs };
  }

  async _call(system, user, signal, validator, maxTokens = 800) {
    return this.callLLM(system, user, signal, null, {
      retryCtx: this._retryCtx(),
      validator,
      maxTokens: Math.max(320, Math.min(Number(this.cfg?.maxTokens) || maxTokens, 1600)),
    });
  }

  /* ------------------------------------------------------------ 发言 */

  /**
   * 白天发言。
   *
   * 处理顺序(每一步都写死,别做成「看情况」):
   *   1. 调模型(validator:必须是 JSON、有中文气泡 —— 否则外壳重试);
   *   2. cleanBubble 清洗 + **代码级过滤**(checkSpeechLeak);
   *   3. 命中过滤 → 带着违规说明**重试一次**;
   *   4. 仍命中 / 调用失败 → **确定性中性气泡** + quality:'low'。
   *
   * @returns {Promise<{say:string[], thinking:string, stake:number|null,
   *                    source:string, quality:string, filtered:null|object}>}
   */
  async speak(view, opts = {}) {
    this.stats.speak++;
    const day = view.day | 0;
    const fallback = (why) => {
      this.stats.fallback++;
      this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 发言降级为中性句:${why}`);
      return {
        say: fallbackSpeech(this.seat, day),
        thinking: '这一轮没想好怎么说得更具体,先听大家的。',
        stake: null,
        source: 'fallback',
        quality: 'low',
        filtered: null,
      };
    };
    if (!this._hasLLM()) return fallback('没有可用的模型配置');

    const system = buildSystemPrompt(view, this.persona);
    const orderIdx = view.order ? view.order.indexOf(view.seat) : 0;
    const user = buildSpeechPrompt(view, { orderIdx: Math.max(0, orderIdx) });

    let raw = '';
    try {
      raw = await this._call(system, user, opts.signal, () => this._validateSpeech());
    } catch (err) {
      if (err?.canceled || opts.signal?.aborted) return fallback(CANCEL_MESSAGE);
      this.stats.errors++;
      this.hooks.onError?.({
        seat: this.seat,
        message: err?.llmParseFail ? `${err.message},已改用中性发言` : (err?.message || String(err)),
      });
      return fallback(err?.llmParseFail ? '模型没给出可用的发言' : '调用失败');
    }

    let parsed = this._parseSpeech(raw, view);
    if (!parsed) return fallback('模型没给出可用的发言');

    // ② 公开内容的过滤。命中就带着「你违反了哪一条」重问一次 ——
    //    模型多数时候只是顺手把「我们狼队」写进去了,提示一句就改对。
    let leak = checkSpeechLeak(parsed.say);
    if (leak) {
      this.stats.filtered++;
      this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 发言被拦(${leak.why});带着说明重试一次`);
      const retryUser = `${user}\n\n【你上一次的发言被主持人拦下了】\n`
        + `你上一次说:「${leak.bubble}」 —— ${leak.why}。\n${repairHint(leak)}\n`
        + '请重写这段发言,只输出那个 JSON。';
      try {
        raw = await this._call(system, retryUser, opts.signal, () => this._validateSpeech());
        const again = this._parseSpeech(raw, view);
        if (again) { parsed = again; leak = checkSpeechLeak(parsed.say); }
      } catch (err) {
        if (err?.canceled || opts.signal?.aborted) return fallback(CANCEL_MESSAGE);
        this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 过滤后的重试失败:${err?.message || err}`);
      }
    }
    if (leak) {
      const fb = fallback(`两次发言都命中过滤器(${leak.why})`);
      return { ...fb, thinking: parsed.thinking || '这句话不能公开说,先含糊过去。', filtered: leak };
    }

    this.stats.llmOk++;
    return {
      say: parsed.say,
      thinking: parsed.thinking,
      stake: parsed.stake,
      source: 'llm',
      quality: 'ok',
      filtered: null,
    };
  }

  /* ------------------------------------------------------------ 投票 */

  /**
   * 放逐投票。
   *
   * 降级**必须是弃票**(target=null)—— 研究文档把「随机兜底毁一致性」列为明确的坑。
   *
   * @returns {Promise<{target:number|null, thinking:string, reason:string, changedFrom:number|null,
   *                    source:string, invalid?:string, consistency?:object}>}
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
        changedFrom: null,
        source: 'fallback',
        invalid: why,
      };
    };
    if (!this._hasLLM()) return abstain('没有可用的模型配置');
    if (!view.voteCandidates?.length) return abstain('没有可投的人');

    const system = buildSystemPrompt(view, this.persona);
    const user = buildVotePrompt(view);
    let raw = '';
    try {
      raw = await this._call(system, user, opts.signal, () => this._validateVote(view), 1200);
    } catch (err) {
      if (err?.canceled || opts.signal?.aborted) return abstain(CANCEL_MESSAGE);
      this.stats.errors++;
      this.hooks.onError?.({
        seat: this.seat,
        message: err?.llmParseFail ? `${err.message},这一票弃权` : (err?.message || String(err)),
      });
      return abstain(err?.llmParseFail ? '模型没给出可用的投票' : '调用失败');
    }

    const parsed = this._parseVote(raw, view);
    if (parsed.target === null) return abstain(parsed.invalid || '模型自己选择了弃票', parsed.thinking);

    // 理由泄漏**不弃票** —— 票是有效的动作,理由只是公开的修辞,
    // 换成一句中性的即可(投票目标是模型的选择,不该因为措辞被作废)。
    const lead = checkReasonLeak(parsed.reason);
    if (lead) {
      this.stats.filtered++;
      this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 投票理由被拦(${lead.why}),换成中性理由`);
      parsed.reason = '他的说法和票型对不上。';
    }

    /**
     * ① 一致性:发言里说了投 A,投票投了 B,又没写 changed_from → 重问一次。
     * 重问失败就接受这一票(动作比修辞重要),但把 changed_from 补成 A,
     * 界面上会标「改票未说明」—— 不藏,让人看得见。
     */
    const stake = Number.isInteger(view.myStakeToday) ? view.myStakeToday : null;
    let consistency = null;
    if (stake !== null && parsed.target !== stake) {
      consistency = { stake, vote: parsed.target, changedFrom: parsed.changedFrom, explained: false };
      if (parsed.changedFrom === null) {
        this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 投票与发言不一致(${stake + 1}→${parsed.target + 1}),追问一次`);
        const retryUser = `${user}\n\n【一致性检查】\n`
          + `你在今天的发言里说了要投 ${seatLabel(stake)},但你现在投的是 ${seatLabel(parsed.target)}。\n`
          + '如果你确实要改票,请在 changed_from 里写上 ' + seatLabel(stake)
          + ',并在 reason 里写明是哪一条**新证据**(新的身份声明 / 新的查验声明 / 主持人公告)让你改的。\n'
          + '如果没有新证据,请改回投 ' + seatLabel(stake) + '。只输出那个 JSON。';
        try {
          const raw2 = await this._call(system, retryUser, opts.signal, () => this._validateVote(view), 1200);
          const again = this._parseVote(raw2, view);
          if (again.target !== null) {
            const lead2 = checkReasonLeak(again.reason);
            parsed = { ...again, reason: lead2 ? '他的说法和票型对不上。' : again.reason };
            consistency = {
              stake, vote: parsed.target, changedFrom: parsed.changedFrom,
              explained: parsed.changedFrom !== null,
            };
          }
        } catch (err) {
          this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 一致性追问失败:${err?.message || err}`);
        }
      } else {
        consistency.explained = true;
      }
    }

    this.stats.llmOk++;
    return {
      target: parsed.target,
      thinking: parsed.thinking,
      reason: parsed.reason,
      changedFrom: consistency ? (consistency.changedFrom ?? stake) : parsed.changedFrom,
      source: 'llm',
      consistency,
    };
  }

  /* ------------------------------------------------------------ 夜间 */

  /**
   * 夜间行动(狼人 / 预言家 / 女巫共用一个入口,按 step 分派提示词)。
   *
   * 降级 = `action:'none'`:空刀 / 不验 / 不用药。
   * 为什么不是「随机挑一个合法目标」:那会让同一局前后矛盾(今晚随机刀 A,
   * 明天发言却在推 B),而且会把平衡测出来的胜率变成随机数的性质。
   *
   * @param {object} view
   * @param {'wolves'|'seer'|'witch'} step
   * @returns {Promise<{action:string, target:number|null, thinking:string, source:string}>}
   */
  async nightAct(view, step, opts = {}) {
    this.stats.night++;
    const none = (why, thinking = '') => {
      this.stats.fallback++;
      this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 夜间行动降级为 none:${why}`);
      return {
        action: 'none', target: null,
        thinking: thinking || '这一步先不动手。',
        source: 'fallback', invalid: why,
      };
    };
    if (!this._hasLLM()) return none('没有可用的模型配置');

    const system = buildSystemPrompt(view, this.persona);
    const user = buildNightPrompt(view, step);
    let raw = '';
    try {
      raw = await this._call(system, user, opts.signal, () => this._validateNight(view, step));
    } catch (err) {
      if (err?.canceled || opts.signal?.aborted) return none(CANCEL_MESSAGE);
      this.stats.errors++;
      this.hooks.onError?.({
        seat: this.seat,
        message: err?.llmParseFail ? `${err.message},这一步放弃` : (err?.message || String(err)),
      });
      return none(err?.llmParseFail ? '模型没给出可用的夜间行动' : '调用失败');
    }

    const parsed = extractJson(raw) || {};
    const action = String(parsed.action || parsed.act || '').trim().toLowerCase();
    const thinking = String(parsed.thinking || '').slice(0, 200);

    // 各步的合法动作集(与 kernel 的校验一致;这里先判一遍,免得白跑一趟 kernel)
    const legal = step === 'wolves' ? ['kill', 'none']
      : step === 'seer' ? ['check', 'none']
        : ['save', 'poison', 'none'];
    if (!legal.includes(action)) return none(`动作不在合法集合里(${action || '空'})`, thinking);
    if (action === 'none') {
      return { action: 'none', target: null, thinking, source: 'llm' };
    }

    const pool = this._nightCandidates(view, step, action);
    const target = toSeat(parsed.target ?? parsed.seat ?? parsed.vote, pool);
    if (target === null) return none(`目标不在合法候选里(${parsed.target})`, thinking);

    this.stats.llmOk++;
    return { action, target, thinking, source: 'llm' };
  }

  /** 夜间合法目标集 —— 与 kernel 的 _legalTarget 保持同一个口径 */
  _nightCandidates(view, step, action) {
    const alive = view.seats.filter((s) => s.alive).map((s) => s.seat);
    if (step === 'wolves') {
      const mates = new Set((view.me.teammates || []).map((t) => t.seat));
      return alive.filter((s) => s !== view.seat && !mates.has(s));
    }
    if (step === 'seer') return alive.filter((s) => s !== view.seat);
    // 女巫:save 只能救今晚的刀口;poison 可以毒任何活人(不是自己)
    if (action === 'save') {
      const k = view.me.witch?.killTarget;
      return (k === null || k === undefined || k === view.seat) ? [] : [k];
    }
    return alive.filter((s) => s !== view.seat);
  }

  /* ------------------------------------------------------------ 解析 */

  _validateSpeech() {
    const text = this._lastRaw;
    if (this.lastTruncated) return { verdict: 'truncated' };
    if (!String(text || '').trim()) return { verdict: 'empty' };
    const parsed = extractJson(text);
    if (!parsed) return { verdict: 'action' };
    const say = parsed.say ?? parsed.speech ?? parsed.text;
    const bubbles = toBubbles(say);
    if (!bubbles.length) return { verdict: 'action' };
    if (!bubbles.some(hasHan)) return { verdict: 'action' };
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
    // 只判「是不是一个可能的座位号」;是否在候选里由 vote() 最终判
    if (n < 0 || n > view.seats.length) return { verdict: 'vote' };
    return null;
  }

  _validateNight(view, step) {
    const text = this._lastRaw;
    if (this.lastTruncated) return { verdict: 'truncated' };
    if (!String(text || '').trim()) return { verdict: 'empty' };
    const parsed = extractJson(text);
    if (!parsed) return { verdict: 'action' };
    const action = String(parsed.action || parsed.act || '').trim().toLowerCase();
    if (!action) return { verdict: 'action' };
    if (action === 'none') return null;
    const n = Math.round(Number(parsed.target ?? parsed.seat ?? parsed.vote));
    if (!Number.isInteger(n) || n < 0 || n > view.seats.length) return { verdict: 'action' };
    void step;
    return null;
  }

  _parseSpeech(raw, view) {
    const parsed = extractJson(raw);
    if (!parsed) return null;
    const say = toBubbles(parsed.say ?? parsed.speech ?? parsed.text);
    if (!say.length || !say.some(hasHan)) return null;
    const thinking = String(parsed.thinking ?? parsed.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
    // ⚠️ 模型写的是「几号」(1 基),内核存的是 0 基座位 —— 这里必须换算。
    //    不换算的表现是「它说要投 3 号,票却记在 4 号头上」,而且一致性检查
    //    会把每一次投票都判成「改票」,整局的发言-投票一致率恒为 0。
    const stakeRaw = parsed.stake ?? parsed.vote_intent ?? parsed.intent;
    let stake = null;
    if (stakeRaw !== null && stakeRaw !== undefined) {
      const n = Math.round(Number(stakeRaw));
      const seats = view?.seats?.length || 0;
      if (Number.isInteger(n) && n >= 1 && n <= seats) stake = n - 1;
    }
    return { say, thinking, stake };
  }

  _parseVote(raw, view) {
    const parsed = extractJson(raw) || {};
    const thinking = String(parsed.thinking ?? parsed.reason ?? '').slice(0, 240);
    const rawVote = parsed.vote ?? parsed.target ?? parsed.seat;
    let target = null;
    let invalid = '';
    if (rawVote === null || rawVote === undefined) {
      invalid = '模型自己选择了弃票';
    } else {
      target = toSeat(rawVote, view.voteCandidates);
      if (target === null) invalid = `投票目标不在合法候选里(${rawVote})`;
    }
    const reason = cleanBubble(parsed.reason ?? parsed.why ?? '', 25);
    const cf = parsed.changed_from ?? parsed.changedFrom;
    let changedFrom = null;
    if (cf !== null && cf !== undefined) {
      const n = Math.round(Number(cf));
      if (Number.isInteger(n) && n >= 1 && n <= view.seats.length) changedFrom = n - 1;
    }
    return { target, reason, thinking, changedFrom, invalid };
  }
}
