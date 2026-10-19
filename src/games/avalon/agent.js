/**
 * 「阿瓦隆」的 AI 代理 —— 只做三件事:**拼提示词、解析回答、把说漏嘴的话拦下来**。
 *
 * 重试 / 超时 / 取消 / 参数降级 / JSON 抽取全在 shared/llmCaller.mjs(与扑克、
 * 卧底、狼人杀共用),这里不重复实现。真正的规则判定在 engine/kernel.js ——
 * LLM 给的一切都只是**提议**,非法就拒,不靠提示词求它守规矩。
 *
 * ────────────────────────────────────────────────────────────────
 * 降级策略(**必须确定性**,研究文档「坑 8:随机兜底毁一致性」)
 *
 *   · 组队解析失败 → 「不上车」的确定性队伍:按座位号从小到大凑够人数,
 *     **尽量不含队长自己**(规则允许队长不带自己)。同一局面重跑永远是同一队。
 *     为什么不是随机抽人:同一局里队长上一秒说「我信 3 号」,下一秒队伍里没有 3 号,
 *     观众立刻出戏;而且随机队伍会把平衡测出来的胜率变成随机数的性质。
 *   · 投票解析失败 → **reject**(弃票的等价物)。阿瓦隆的票只有赞成/反对两种,
 *     「不表态」最接近的是**不赞成**:默认赞成会让一个坏掉的 agent 变成
 *     「永远放行」的橡皮图章,而默认反对最多是让这一轮重来一次。
 *   · 投卡解析失败 → **success**。好人的卡本来就被规则钉死成 success;
 *     坏人降级也投成功 = 不主动送分、也不自曝(投失败才是暴露自己)。
 *   · 刺杀解析失败 → 座位号最小的**别人**。刺杀不能空着(它是流程的终点),
 *     所以必须给一个确定的目标;取最小座位号是唯一一个不需要任何判断的答案。
 *
 * 四种降级都只是「这一步没有表达意见」,不改变任何人的嫌疑 —— 被动但一致。
 *
 * ────────────────────────────────────────────────────────────────
 * 两条阿瓦隆独有的检查
 *
 * ① **组队必须真的能打**:人数不对、座位重复、超出范围 → 当作解析失败
 *    (不偷偷截断/补齐,那会把模型的错误变成一个看起来合法的队伍)。
 *
 * ② **公开说法与动作分开处理**:say / reason 被过滤器拦下时**不推翻动作** ——
 *    队伍/票/卡是决策,说法只是修辞。改成确定性的中性说辞即可(与狼人杀
 *    「理由泄漏不弃票」同一条原则)。
 */

import { LlmCaller, extractJson, resolveRetryPolicy, CANCEL_MESSAGE } from '../../shared/llmCaller.mjs';
import {
  buildSystemPrompt, buildTeamPrompt, buildVotePrompt, buildMissionPrompt,
  buildAssassinPrompt, fallbackSay,
} from './prompts.js';
import {
  cleanBubble, checkSpeechLeak, checkReasonLeak, repairHint, neutralSay, neutralReason,
} from './filter.js';

/** 座位号口语化:0 → 「1号」 */
function seatLabel(seat) {
  return `${Number(seat) + 1}号`;
}

/** 是不是中文(英文发言在这个游戏里没法互相比较,直接当解析失败) */
function hasHan(s) {
  return /\p{Script=Han}/u.test(String(s || ''));
}

/**
 * 把模型给的 `say` 收敛成 1~3 条气泡。
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
  return out.slice(0, 3);
}

/** 把「几号」收敛成 0 基座位;不在合法集合里返回 null */
function toSeat(raw, candidates) {
  if (raw === null || raw === undefined) return null;
  const n = Math.round(Number(raw));
  if (!Number.isInteger(n)) return null;
  // 提示词要求「几号」(1 基);这里再兜一层容错:也接受 0 基(仅当 1 基越界时)
  if (candidates.includes(n - 1)) return n - 1;
  if (candidates.includes(n)) return n;
  return null;
}

export class AvalonAgent extends LlmCaller {
  /**
   * @param {number} seat 座位号(0 起)
   * @param {object} persona 性格 { name, tag, style, verbosity, reasoning, blindspot }
   * @param {object} cfg 该座位的模型配置(app.agentCfg 组装,与其它游戏同一份)
   * @param {object} hooks { onThink, onError, onDebug }
   */
  constructor(seat, persona, cfg = {}, hooks = {}) {
    super({ seat, cfg, hooks });
    this.persona = persona || {};
    /** 统计:让「这一局调了几次、兜底了几次、拦了几次」在调试时看得见 */
    this.stats = { team: 0, vote: 0, card: 0, assassinate: 0, llmOk: 0, fallback: 0, filtered: 0, errors: 0 };
  }

  get name() { return this.persona?.name || seatLabel(this.seat); }

  /* ------------------------------------------------------------ 调用外壳 */

  _hasLLM() {
    return !!(this.cfg?.endpoint && (this.cfg?.apiKey || this.cfg?.noKey));
  }

  /** 重试会话:每次「组队 / 投票 / 投卡 / 刺杀」各一条死线,与其它游戏的用法一致 */
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

  /* ------------------------------------------------------------ 组队 */

  /**
   * 队长提名队伍。
   *
   * @returns {Promise<{team:number[], say:string[], thinking:string,
   *                    source:string, quality:string, filtered:null|object, invalid?:string}>}
   */
  async proposeTeam(view, opts = {}) {
    this.stats.team++;
    const fallback = (why) => {
      this.stats.fallback++;
      this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 组队降级为确定性队伍:${why}`);
      return {
        team: this._deterministicTeam(view),
        say: fallbackSay(this.seat, view.round),
        thinking: '这一轮先按座位顺序凑一队,不额外挑人。',
        source: 'fallback',
        quality: 'low',
        filtered: null,
        invalid: why,
      };
    };
    if (!this._hasLLM()) return fallback('没有可用的模型配置');

    const system = buildSystemPrompt(view, this.persona);
    const user = buildTeamPrompt(view);
    let raw = '';
    try {
      raw = await this._call(system, user, opts.signal, () => this._validateTeam(view), 900);
    } catch (err) {
      if (err?.canceled || opts.signal?.aborted) return fallback(CANCEL_MESSAGE);
      this.stats.errors++;
      this.hooks.onError?.({
        seat: this.seat,
        message: err?.llmParseFail ? `${err.message},已改用确定性队伍` : (err?.message || String(err)),
      });
      return fallback(err?.llmParseFail ? '模型没给出可用的队伍' : '调用失败');
    }

    let parsed = this._parseTeam(raw, view);
    if (!parsed) return fallback('模型没给出可用的队伍');

    // 公开说法的过滤:命中就带着「你违反了哪一条」重问一次。
    let leak = checkSpeechLeak(parsed.say);
    if (leak) {
      this.stats.filtered++;
      this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 组队发言被拦(${leak.why});带着说明重试一次`);
      const retryUser = `${user}\n\n【你上一次的发言被主持人拦下了】\n`
        + `你上一次说:「${leak.bubble}」 —— ${leak.why}。\n${repairHint(leak)}\n`
        + '请重写这段发言(team 可以保持不变),只输出那个 JSON。';
      try {
        raw = await this._call(system, retryUser, opts.signal, () => this._validateTeam(view), 900);
        const again = this._parseTeam(raw, view);
        if (again) { parsed = again; leak = checkSpeechLeak(parsed.say); }
      } catch (err) {
        if (err?.canceled || opts.signal?.aborted) return fallback(CANCEL_MESSAGE);
        this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 过滤后的重试失败:${err?.message || err}`);
      }
    }
    if (leak) {
      // 队伍是决策,说法只是修辞 —— 只换说法,不推翻队伍(与投票理由同一原则)
      this.stats.fallback++;
      return {
        team: parsed.team,
        say: neutralSay(this.seat, view.round),
        thinking: parsed.thinking || '理由不方便说,先含糊过去。',
        source: 'llm',
        quality: 'low',
        filtered: leak,
      };
    }

    this.stats.llmOk++;
    return {
      team: parsed.team,
      say: parsed.say,
      thinking: parsed.thinking,
      source: 'llm',
      quality: 'ok',
      filtered: null,
    };
  }

  /**
   * 确定性队伍:按座位号从小到大凑够人数,**尽量不含队长自己**。
   *
   * 「尽量不含自己」= 用户要的「不上车」:解析失败时队长不把自己的偏好
   * 伪装成一个判断 —— 他干脆不上去,让队伍变成一个纯机械的默认值。
   */
  _deterministicTeam(view) {
    const size = Math.max(1, view.teamSize | 0);
    const others = view.seats.map((s) => s.seat).filter((s) => s !== view.seat).sort((a, b) => a - b);
    const pool = others.concat([view.seat]);
    return pool.slice(0, size).sort((a, b) => a - b);
  }

  _parseTeam(raw, view) {
    const parsed = extractJson(raw);
    if (!parsed) return null;
    const say = toBubbles(parsed.say ?? parsed.speech ?? parsed.text);
    if (!say.length || !say.some(hasHan)) return null;
    const thinking = String(parsed.thinking ?? parsed.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const rawList = Array.isArray(parsed.team) ? parsed.team : null;
    if (!rawList) return null;
    const size = view.teamSize | 0;
    const allSeats = view.seats.map((s) => s.seat);
    const team = [];
    for (const item of rawList) {
      const t = toSeat(item, allSeats);
      if (t === null) return null;
      if (team.includes(t)) return null;
      team.push(t);
    }
    if (team.length !== size) return null;
    return { team: team.sort((a, b) => a - b), say, thinking };
  }

  /* ------------------------------------------------------------ 投票 */

  /**
   * 赞成/反对票。
   *
   * @returns {Promise<{approve:boolean, thinking:string, reason:string,
   *                    source:string, invalid?:string}>}
   */
  async vote(view, opts = {}) {
    this.stats.vote++;
    const reject = (why, thinking = '') => {
      this.stats.fallback++;
      this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 投票降级为反对:${why}`);
      return {
        approve: false,
        thinking: thinking || '这一队我先不赞成,宁可换一个队长。',
        reason: '',
        source: 'fallback',
        invalid: why,
      };
    };
    if (!this._hasLLM()) return reject('没有可用的模型配置');

    const system = buildSystemPrompt(view, this.persona);
    const user = buildVotePrompt(view);
    let raw = '';
    try {
      raw = await this._call(system, user, opts.signal, () => this._validateVote(), 900);
    } catch (err) {
      if (err?.canceled || opts.signal?.aborted) return reject(CANCEL_MESSAGE);
      this.stats.errors++;
      this.hooks.onError?.({
        seat: this.seat,
        message: err?.llmParseFail ? `${err.message},这一票按反对处理` : (err?.message || String(err)),
      });
      return reject(err?.llmParseFail ? '模型没给出可用的投票' : '调用失败');
    }

    const parsed = extractJson(raw) || {};
    const thinking = String(parsed.thinking ?? parsed.reason ?? '').slice(0, 240);
    const rawVote = String(parsed.vote ?? parsed.choose ?? '').trim().toLowerCase();
    const approve = /^(approve|yes|agree|赞成|同意|通过|上车|支持)$/.test(rawVote)
      || rawVote === 'true';
    const known = /^(approve|yes|agree|reject|no|deny|赞成|同意|通过|上车|支持|反对|否决|拒绝)$/.test(rawVote);
    if (!known) return reject(`投票不在合法集合里(${rawVote || '空'})`, thinking);

    let reason = cleanBubble(parsed.reason ?? parsed.why ?? '', 25);
    // 理由泄漏**不推翻这一票**:票是动作,理由只是公开的修辞(与狼人杀同一条原则)
    const lead = checkReasonLeak(reason);
    if (lead) {
      this.stats.filtered++;
      this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 投票理由被拦(${lead.why}),换成中性理由`);
      reason = neutralReason(this.seat, view.round);
    }

    this.stats.llmOk++;
    return {
      approve,
      thinking,
      reason,
      source: 'llm',
      filtered: lead || null,
    };
  }

  /* ------------------------------------------------------------ 任务卡 */

  /**
   * 上车投卡。
   *
   * 降级 = `success`(好人的卡本来就是这个;坏人不主动送分也不自曝)。
   * @returns {Promise<{card:'success'|'fail', thinking:string, source:string, invalid?:string}>}
   */
  async playCard(view, opts = {}) {
    this.stats.card++;
    const success = (why, thinking = '') => {
      this.stats.fallback++;
      this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 投卡降级为 success:${why}`);
      return {
        card: 'success',
        thinking: thinking || '这一张先按成功出。',
        source: 'fallback',
        invalid: why,
      };
    };
    if (!this._hasLLM()) return success('没有可用的模型配置');

    const system = buildSystemPrompt(view, this.persona);
    const user = buildMissionPrompt(view);
    let raw = '';
    try {
      raw = await this._call(system, user, opts.signal, () => this._validateCard(), 700);
    } catch (err) {
      if (err?.canceled || opts.signal?.aborted) return success(CANCEL_MESSAGE);
      this.stats.errors++;
      this.hooks.onError?.({
        seat: this.seat,
        message: err?.llmParseFail ? `${err.message},这张卡按成功出` : (err?.message || String(err)),
      });
      return success(err?.llmParseFail ? '模型没给出可用的卡' : '调用失败');
    }

    const parsed = extractJson(raw) || {};
    const thinking = String(parsed.thinking ?? parsed.reason ?? '').slice(0, 240);
    const card = String(parsed.card ?? parsed.play ?? parsed.action ?? '').trim().toLowerCase();
    const isFail = /^(fail|failure|失败|破坏|坏)$/.test(card);
    const isOk = /^(success|ok|pass|成功|通过)$/.test(card);
    if (!isFail && !isOk) return success(`卡不在合法集合里(${card || '空'})`, thinking);
    // ⚠️ 好人投失败是**规则违规**:这里先拦一道(内核还会再拦,两层都判不是重复,
    //    因为玩家模式的输入也会走同一条路),而且**不重试** ——
    //    「投失败」对好人来说不是措辞问题,是这个 agent 的身份认知出了问题。
    if (isFail && view.me.side === 'good') {
      return success('好人只能投成功,模型给了失败卡', thinking);
    }

    this.stats.llmOk++;
    return { card: isFail ? 'fail' : 'success', thinking, source: 'llm' };
  }

  /* ------------------------------------------------------------ 刺杀 */

  /**
   * 刺杀。只有刺客会走到这里。
   *
   * 降级 = 座位号最小的**别人**(刺杀不能空着,必须给一个确定目标)。
   * @returns {Promise<{target:number|null, thinking:string, source:string, invalid?:string}>}
   */
  async assassinate(view, opts = {}) {
    this.stats.assassinate++;
    const fallback = (why, thinking = '') => {
      this.stats.fallback++;
      this.hooks.onDebug?.(`[${seatLabel(this.seat)}] 刺杀降级为最小座位号:${why}`);
      const pool = view.seats.map((s) => s.seat).filter((s) => s !== view.seat).sort((a, b) => a - b);
      return {
        target: pool.length ? pool[0] : null,
        thinking: thinking || '没有可靠的判断,按座位顺序刺一个。',
        source: 'fallback',
        invalid: why,
      };
    };
    if (!this._hasLLM()) return fallback('没有可用的模型配置');

    const system = buildSystemPrompt(view, this.persona);
    const user = buildAssassinPrompt(view);
    let raw = '';
    try {
      raw = await this._call(system, user, opts.signal, () => this._validateAssassinate(view), 300);
    } catch (err) {
      if (err?.canceled || opts.signal?.aborted) return fallback(CANCEL_MESSAGE);
      this.stats.errors++;
      this.hooks.onError?.({
        seat: this.seat,
        message: err?.llmParseFail ? `${err.message},改为按座位顺序刺` : (err?.message || String(err)),
      });
      return fallback(err?.llmParseFail ? '模型没给出可用的刺杀目标' : '调用失败');
    }

    const parsed = extractJson(raw) || {};
    const thinking = String(parsed.thinking ?? parsed.reason ?? '').slice(0, 240);
    const pool = view.seats.map((s) => s.seat).filter((s) => s !== view.seat);
    const target = toSeat(parsed.target ?? parsed.seat ?? parsed.vote, pool);
    if (target === null) return fallback(`目标不在合法候选里(${parsed.target})`, thinking);

    this.stats.llmOk++;
    return { target, thinking, source: 'llm' };
  }

  /* ------------------------------------------------------------ 校验 */

  _validateTeam(view) {
    const text = this._lastRaw;
    if (this.lastTruncated) return { verdict: 'truncated' };
    if (!String(text || '').trim()) return { verdict: 'empty' };
    const parsed = extractJson(text);
    if (!parsed) return { verdict: 'action' };
    const say = parsed.say ?? parsed.speech ?? parsed.text;
    const bubbles = toBubbles(say);
    if (!bubbles.length || !bubbles.some(hasHan)) return { verdict: 'action' };
    const list = parsed.team;
    if (!Array.isArray(list) || list.length !== (view.teamSize | 0)) return { verdict: 'action' };
    const allSeats = view.seats.map((s) => s.seat);
    const seen = new Set();
    for (const item of list) {
      const t = toSeat(item, allSeats);
      if (t === null || seen.has(t)) return { verdict: 'action' };
      seen.add(t);
    }
    return null;
  }

  _validateVote() {
    const text = this._lastRaw;
    if (this.lastTruncated) return { verdict: 'truncated' };
    if (!String(text || '').trim()) return { verdict: 'empty' };
    const parsed = extractJson(text);
    if (!parsed) return { verdict: 'vote' };
    const v = String(parsed.vote ?? parsed.choose ?? '').trim().toLowerCase();
    if (!v) return { verdict: 'vote' };
    if (/^(approve|yes|agree|reject|no|deny|true|false|赞成|同意|通过|上车|支持|反对|否决|拒绝)$/.test(v)) return null;
    return { verdict: 'vote' };
  }

  _validateCard() {
    const text = this._lastRaw;
    if (this.lastTruncated) return { verdict: 'truncated' };
    if (!String(text || '').trim()) return { verdict: 'empty' };
    const parsed = extractJson(text);
    if (!parsed) return { verdict: 'action' };
    const card = String(parsed.card ?? parsed.play ?? parsed.action ?? '').trim().toLowerCase();
    if (!card) return { verdict: 'action' };
    if (/^(success|fail|ok|pass|成功|失败|通过|破坏)$/.test(card)) return null;
    return { verdict: 'action' };
  }

  _validateAssassinate(view) {
    const text = this._lastRaw;
    if (this.lastTruncated) return { verdict: 'truncated' };
    if (!String(text || '').trim()) return { verdict: 'empty' };
    const parsed = extractJson(text);
    if (!parsed) return { verdict: 'action' };
    const raw = parsed.target ?? parsed.seat ?? parsed.vote;
    if (raw === null || raw === undefined) return { verdict: 'action' };
    const n = Math.round(Number(raw));
    if (!Number.isInteger(n) || n < 0 || n > view.seats.length) return { verdict: 'action' };
    return null;
  }
}
