/**
 * 玩家模式的下注操作条(紧凑版)。
 *
 * 默认只显示三个按钮:弃牌 / 跟注(或过牌) / 加注 —— 尽量不占画面。
 * 点「加注」才展开一行:常用尺度快捷键 + 金额输入框 + 确认。
 *
 * 尺度按钮按场景给:
 *   翻前 → 按大盲倍数(2BB / 2.5BB / 3BB / 4BB)
 *   翻后 → 按底池比例(1/3 池 / 半池 / 3/4 池 / 满池)
 *   两种情况都给「全下」和「最小」。
 *
 * 组件只负责「收集一个动作」,合法性由引擎的 normalizeAction 兜底。
 *
 * ────────────────────────────────────────────────────────────
 * 想改什么:
 *   · 常驻信息条显示哪些项   → 下面 HTML 模板里的 <div class="pbar__stats">
 *     (我的筹码 / 位置 / 底池 / 本轮已投 / 本手结果)
 *   · 提示行的文案           → updatePrompt();文案内容由 app.js 的 updatePlayerBar() 传进来
 *   · 筹码数字的滚动动画     → animateChips()
 *   · 三个按钮的文字         → update() 里改 call.textContent 那几行
 *   · 快捷尺度有哪些         → sizeOptions()
 *   · 键盘快捷键             → onKey()
 *   · 样式                   → src/ui/styles3d.css 搜 .pbar / .pstat
 * ============================================================ */
export function createPlayerBar(root, { onAct, onReview, onOpenChange } = {}) {
  const el = document.createElement('div');
  el.className = 'pbar';
  el.innerHTML = `
    <!-- 常驻信息条:我的筹码 / 位置 / 底池 / 这一手的输赢。
         之前这些只在「轮到我」时才在别处显示,导致玩家随时都不知道自己还有多少筹码、
         上一手是赚是亏 —— 所以这里做成**一直显示**。 -->
    <div class="pbar__stats" id="pbStats">
      <span class="pstat pstat--chips">
        <span class="pstat__label">我的筹码</span>
        <b class="pstat__value" id="pbChips">—</b>
        <i class="pstat__delta" id="pbDelta"></i>
      </span>
      <span class="pstat" id="pbPosWrap"><span class="pstat__label">位置</span><b class="pstat__value" id="pbPos">—</b></span>
      <span class="pstat"><span class="pstat__label">底池</span><b class="pstat__value" id="pbPot">0</b></span>
      <span class="pstat" id="pbBetWrap" hidden><span class="pstat__label">本轮已投</span><b class="pstat__value" id="pbBet">0</b></span>
      <span class="pstat pstat--result" id="pbResult" hidden></span>
    </div>

    <!-- 提示行:现在该谁、该做什么 -->
    <div class="pbar__prompt" id="pbPrompt" hidden></div>

    <!-- 默认状态:只有三个按钮。加注浮层放在按钮行**内部**,
         用 bottom:100% 挂在按钮上方 —— 这样按钮多高都不用算,永远不会挡到按钮。 -->
    <div class="pbar__acts" id="pbActs">
      <div class="pbar__raise" id="pbRaiseRow" hidden>
        <div class="pbar__sizes" id="pbSizes"></div>
        <div class="pbar__inputRow">
          <input type="number" id="pbAmount" class="pbar__num" step="1">
          <input type="range" id="pbSlider" class="pbar__slider" min="0" max="100" value="0">
          <button class="btn btn--primary" id="pbConfirm">确认</button>
          <button class="btn btn--ghost btn--tiny" id="pbCancel">取消</button>
        </div>
        <div class="pbar__warn" id="pbWarn"></div>
      </div>
      <button class="btn pbtn pbtn--fold" id="pbFold">弃牌</button>
      <button class="btn pbtn pbtn--call" id="pbCallBtn">跟注</button>
      <button class="btn pbtn pbtn--raise" id="pbRaise">加注</button>
    </div>
  `;
  // 注意:「第 N 手记录」按钮**不在这里**。
  // 它曾经是这个容器里的一个绝对定位块(bottom:0 + margin-bottom),
  // 结果压在提示行上、窄屏下文字还被截断 —— 因为这个容器里的每个块
  // 位置都是按实际高度算出来的,硬塞会互相打架。
  // 现在它挂到手牌一览的公共牌行上(见 sceneFull.js 的 setReviewEnabled)。
  root.appendChild(el);

  const q = (id) => el.querySelector('#' + id);
  let cur = null;            // 当前合法动作信息
  let raiseOpen = false;
  let mySeat = null;

  /* ---------------------------------------------------------- 加注尺度 */

  /**
   * 按当前局面算出该给哪些快捷键。
   * @returns {Array<{key:string,label:string,value:number}>}
   */
  function sizeOptions() {
    if (!cur) return [];
    const { minRaiseTo, maxRaiseTo, pot, toCall, currentBet, bigBlind } = cur;
    const bb = bigBlind || 20;
    const preflop = !cur.hasBoard;
    const clamp = (v) => Math.max(minRaiseTo, Math.min(maxRaiseTo, Math.round(v)));
    const out = [];

    if (preflop) {
      // 翻前:以「加注到多少个大盲」为准
      for (const n of [2, 2.5, 3, 4]) {
        out.push({ key: `bb${n}`, label: `${n}BB`, value: clamp(bb * n) });
      }
    } else {
      // 翻后:以底池比例为准。加注到 = 跟注额 + (底池 + 跟注额) × 比例
      const fracs = [[0.33, '1/3池'], [0.5, '半池'], [0.75, '3/4池'], [1, '满池']];
      for (const [f, label] of fracs) {
        out.push({ key: `pot${f}`, label, value: clamp(cur.betThisRound + toCall + (pot + toCall) * f) });
      }
    }
    out.push({ key: 'min', label: '最小', value: minRaiseTo });
    out.push({ key: 'allin', label: '全下', value: maxRaiseTo });
    void currentBet;

    // 去重(不同尺度可能算出同一个值),并去掉超出范围的
    const seen = new Set();
    return out.filter((o) => {
      if (o.value < minRaiseTo || o.value > maxRaiseTo) return false;
      if (seen.has(o.value)) return false;
      seen.add(o.value);
      return true;
    });
  }

  function renderSizes() {
    const opts = sizeOptions();
    q('pbSizes').innerHTML = opts
      .map((o) => `<button class="sizebtn" data-val="${o.value}">${o.label}</button>`)
      .join('');
    q('pbSizes').querySelectorAll('.sizebtn').forEach((b) => {
      b.addEventListener('click', () => {
        setAmount(Number(b.dataset.val));
        q('pbSizes').querySelectorAll('.sizebtn').forEach((x) => x.classList.remove('is-on'));
        b.classList.add('is-on');
      });
    });
    return opts;
  }

  function setAmount(v) {
    if (!cur) return;
    const { minRaiseTo, maxRaiseTo } = cur;
    const n = Math.max(minRaiseTo, Math.min(maxRaiseTo, Math.round(v) || minRaiseTo));
    q('pbAmount').value = String(n);
    const span = Math.max(1, maxRaiseTo - minRaiseTo);
    q('pbSlider').value = String(Math.round(((n - minRaiseTo) / span) * 100));
    updateWarn(n);
  }

  function updateWarn(n) {
    const warn = q('pbWarn');
    if (!cur) { warn.textContent = ''; return; }
    if (n >= cur.maxRaiseTo) {
      warn.textContent = `全下 ${n}`;
      warn.className = 'pbar__warn is-warn';
    } else {
      warn.textContent = `${n}(最小 ${cur.minRaiseTo} · 最多 ${cur.maxRaiseTo})`;
      warn.className = 'pbar__warn';
    }
  }

  /* ---------------------------------------------------------- 显示 / 更新 */

  const fmt = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)))
    ? '—' : Math.round(Number(n)).toLocaleString('zh-CN');

  /** 筹码数字滚动动画:从旧值数到新值,让「筹码变了」这件事被看见 */
  let chipsShown = null;
  let chipsAnim = null;
  function animateChips(to) {
    const target = Number(to);
    if (!Number.isFinite(target)) return;
    if (chipsShown === null) { chipsShown = target; q('pbChips').textContent = fmt(target); return; }
    if (chipsShown === target) return;
    const from = chipsShown;
    const dur = Math.min(700, 200 + Math.abs(target - from) * 2);
    const t0 = performance.now();
    cancelAnimationFrame(chipsAnim);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      // ease-out,末尾慢下来更容易看清
      const e = 1 - Math.pow(1 - k, 3);
      const v = Math.round(from + (target - from) * e);
      chipsShown = v;
      q('pbChips').textContent = fmt(v);
      q('pbChips').classList.toggle('is-up', target > from);
      q('pbChips').classList.toggle('is-down', target < from);
      if (k < 1) chipsAnim = requestAnimationFrame(step);
      else {
        chipsShown = target;
        q('pbChips').textContent = fmt(target);
        q('pbChips').classList.remove('is-up', 'is-down');
      }
    };
    chipsAnim = requestAnimationFrame(step);
  }

  /**
   * 常驻信息条 —— **无论轮不轮到我都会更新**。
   * 这是「随时知道我有多少筹码、这一手赚了还是亏了」的关键。
   */
  function updateStats(info) {
    animateChips(info.stack);
    q('pbPos').textContent = info.position || '—';
    q('pbPosWrap').hidden = !info.position;
    if (info.pot !== undefined && info.pot !== null) q('pbPot').textContent = fmt(info.pot);

    // 本轮已投:只有真投了才显示,免得平时多一行没用的信息
    const bet = Number(info.betThisRound) || 0;
    q('pbBetWrap').hidden = bet <= 0;
    q('pbBet').textContent = fmt(bet);

    // 这一手的结果(只在手牌结束时显示)
    const res = info.result;
    const box = q('pbResult');
    if (res && Number.isFinite(Number(res.delta))) {
      const d = Math.round(Number(res.delta));
      box.hidden = false;
      box.className = 'pstat pstat--result ' + (d > 0 ? 'is-win' : d < 0 ? 'is-lose' : 'is-even');
      const label = res.label ? `${res.label} ` : '';
      box.textContent = d > 0 ? `${label}+${fmt(d)}` : d < 0 ? `${label}${fmt(d)}` : `${label}±0`;
    } else {
      box.hidden = true;
    }
  }

  /**
   * 提示行:告诉玩家现在是什么状态。
   * 之前轮到自己以外的时段界面上没有任何提示,不知道是在等 AI 还是卡住了。
   */
  function updatePrompt(info) {
    const p = q('pbPrompt');
    let text = '';
    if (info.handOver) text = info.resultText || '本手结束';
    else if (info.myTurn) text = info.promptText || '轮到你行动';
    else if (info.actingName) text = `等待 ${info.actingName} 行动…`;
    else text = info.promptText || '等待中…';
    p.hidden = !text;
    p.textContent = text;
    p.classList.toggle('is-my-turn', !!info.myTurn);
    p.classList.toggle('is-over', !!info.handOver);
  }

  /**
   * @param {object} info { myTurn, seat, stack, betThisRound, bigBlind, legal, hasBoard,
   *                        position, pot, result, actingName, handOver, promptText, resultText }
   */
  function update(info) {
    mySeat = info.seat;

    // 信息条与提示行**永远**更新(这是玩家随时了解局势的主要来源)
    updateStats(info);
    updatePrompt(info);

    const myTurn = !!info.myTurn && !!info.legal;
    el.classList.toggle('is-my-turn', myTurn);

    if (!myTurn) {
      // 不是我的回合:把三个按钮整个藏起来(界面干净),加注面板也收掉
      raiseOpen = false;
      cur = null;
      q('pbRaiseRow').hidden = true;
      q('pbActs').hidden = true;
      return;
    }

    cur = {
      ...info.legal, betThisRound: info.betThisRound || 0,
      bigBlind: info.bigBlind || 0, hasBoard: !!info.hasBoard,
    };
    q('pbActs').hidden = false;

    const call = q('pbCallBtn');
    const raise = q('pbRaise');
    // 三个按钮:弃牌 / 跟注或过牌 / 加注。需跟多少直接写在按钮上,不另外占一行。
    call.textContent = cur.canCheck ? '过牌' : `跟注 ${cur.callAmount}`;
    call.dataset.kind = cur.canCheck ? 'check' : 'call';
    raise.hidden = !cur.canRaise;
    raise.textContent = cur.currentBet > 0 ? '加注' : '下注';

    if (cur.canRaise) {
      renderSizes();
      setAmount(Number(q('pbAmount').value) || cur.minRaiseTo);
      if (raiseOpen) q('pbRaiseRow').hidden = false;
    } else {
      q('pbRaiseRow').hidden = true;
    }
  }

  // 「第 N 手记录」按钮已经移出手牌一览(公共牌行)那边了,这里不再处理。
  // 保留这个方法只为了让老调用点不报错(它现在是空操作)。
  function setReviewEnabled() { /* 按钮已移交 sceneFull 的 setReviewEnabled */ }

  function show() {
    if (el.classList.contains('is-open')) return;
    el.classList.add('is-open');
    onOpenChange?.(true);
  }
  function hide() {
    if (!el.classList.contains('is-open')) return;
    el.classList.remove('is-open');
    onOpenChange?.(false);
  }
  void onOpenChange;

  /* ---------------------------------------------------------- 事件 */

  q('pbFold').addEventListener('click', () => act({ type: 'fold' }));
  q('pbCallBtn').addEventListener('click', () => {
    act({ type: q('pbCallBtn').dataset.kind === 'check' ? 'check' : 'call' });
  });
  q('pbRaise').addEventListener('click', () => {
    if (!cur?.canRaise) return;
    raiseOpen = true;
    q('pbRaiseRow').hidden = false;
    el.classList.add('is-expanded');
    setAmount(Number(q('pbAmount').value) || cur.minRaiseTo);
  });
  q('pbCancel').addEventListener('click', () => {
    raiseOpen = false;
    q('pbRaiseRow').hidden = true;
    el.classList.remove('is-expanded');
  });
  q('pbConfirm').addEventListener('click', () => {
    act({ type: 'raise', amount: Number(q('pbAmount').value) });
  });
  q('pbSlider').addEventListener('input', () => {
    if (!cur) return;
    const span = cur.maxRaiseTo - cur.minRaiseTo;
    setAmount(cur.minRaiseTo + Math.round((Number(q('pbSlider').value) / 100) * span));
  });
  q('pbAmount').addEventListener('input', () => setAmount(Number(q('pbAmount').value)));
  // (原来这里绑 pbReview —— 那个按钮已经移到手牌一览的公共牌行,由 sceneFull 负责)

  function act(action) {
    if (!cur && action.type !== 'fold') return;
    raiseOpen = false;
    q('pbRaiseRow').hidden = true;
    el.classList.remove('is-expanded');
    el.classList.add('is-busy');
    Promise.resolve(onAct?.(action)).finally(() => {
      setTimeout(() => el.classList.remove('is-busy'), 200);
    });
  }

  /** 轮到我时用键盘快捷键:F 弃牌 / C 过牌或跟注 / R 加注 / 回车确认 */
  function onKey(e) {
    if (!el.classList.contains('is-my-turn') || el.classList.contains('is-busy')) return;
    if (e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === 'f') act({ type: 'fold' });
    else if (k === 'c') act({ type: cur?.canCheck ? 'check' : 'call' });
    else if (k === 'r' && cur?.canRaise) {
      raiseOpen = true;
      q('pbRaiseRow').hidden = false;
      el.classList.add('is-expanded');
      setAmount(Number(q('pbAmount').value) || cur.minRaiseTo);
    } else if (k === 'enter' && raiseOpen) act({ type: 'raise', amount: Number(q('pbAmount').value) });
    else return;
    e.preventDefault();
  }
  window.addEventListener('keydown', onKey);

  return {
    el, update, show, hide, setReviewEnabled,
    setWaitText: () => {},
    isRaiseOpen: () => raiseOpen,
    /** 加注浮层的高度(外部用它算位置) */
    raiseHeight: () => (q('pbRaiseRow').hidden ? 0 : q('pbRaiseRow').offsetHeight + 10),
    /**
     * 单独刷新常驻信息条(不依赖「轮到我」)。
     * 手牌结束、别人行动导致筹码变化时都用它,这样信息条始终是准的。
     */
    updateStats,
    /** 只播一次「筹码变化」的高亮动画(手牌结算时用,视觉上把注意力引到数字上) */
    pulseChips: () => {
      const c = q('pbChips');
      c.classList.remove('is-pulse');
      // 强制回流,否则连续两次加同一个类不会重播动画
      void c.offsetWidth;
      c.classList.add('is-pulse');
      setTimeout(() => c.classList.remove('is-pulse'), 1100);
    },
    destroy: () => {
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(chipsAnim);
      el.remove();
    },
    /** 测试用 */
    debug: () => ({ mySeat, cur, raiseOpen, sizes: sizeOptions(), chipsShown }),
  };
}
