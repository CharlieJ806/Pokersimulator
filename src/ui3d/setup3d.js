/**
 * 开局设置面板 + 中途改规则抽屉(3D 版)。
 *
 * 与旧版的区别:座位预览改成「弧形排开的小圆点」,直接对应 3D 场景里的站位。
 *
 * ────────────────────────────────────────────────────────────
 * 想改什么:
 *   · 设置页有哪些项、排布怎样 → 文件里的 HTML 模板(搜 class="field")
 *   · 「牌手人数」滑杆           → id="seats" + drawPreview()
 *   · 节奏模式下拉               → id="flowMode"
 *   · 「一手结束后自动开下一手」 → id="autoNextHand"(默认关,见 app.js 的 autoNextHand)
 *   · 厂商 / 模型 / API Key      → id="provider" / "model" / "apiKey"
 *   · 性格池那一片卡片           → renderPersonas() + src/ai/personas.js
 *   · 底部那行信息汇总           → syncLabels()
 * ============================================================ */

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** 与 src/ai/personas.js 保持一致的展示用清单 */
const PERSONA_LIST = [
  ['steady', '老陈', '稳健:牌选得偏紧,不硬撑'],
  ['math', '小林', '算赔率:先算底池赔率再决定'],
  ['balanced', '阿哲', '均衡:没有明显漏洞'],
  ['curious', '小满', '好奇:起手范围宽一点'],
  ['chatty', '老周', '话多心细:爱分析,会施压'],
  ['pressing', '大鹏', '爱施压:偏进攻,中牌连开两枪'],
  ['nit', '磐石', '极紧:只玩真正的好牌'],
  ['maniac', '疯子李', '极激进:什么牌都想打'],
];

export function createSetup(root, { onStart, onSaveAI, onExitHome, mode = 'lobby' } = {}) {
  const wrap = el('div', `setup setup--${mode}`);
  wrap.innerHTML = `
    <div class="setup__card">
      <div class="setup__head">
        <div>
          <h1>德州扑克模拟器 <span class="setup__ver">Poker Simulator</span></h1>
          <p class="setup__sub" id="setupSub"></p>
        </div>
        ${mode === 'drawer' ? '<button class="btn btn--ghost" id="setupClose">✕ 关闭</button>' : ''}
      </div>

      <div class="setup__body">
        <section class="setup__col">
          <h3>牌桌规则</h3>
          <label class="field">
            <span>牌手人数 <b id="seatsVal">6</b> 人</span>
            <input type="range" id="seats" min="2" max="9" step="1" value="6">
          </label>
          <div class="seatpreview" id="seatPreview"></div>

          <label class="field field--row">
            <span>牌堆</span>
            <select id="shortDeck">
              <option value="false">标准 52 张</option>
              <option value="true">短牌 36 张(去 2~5,三条&gt;顺子、同花&gt;葫芦)</option>
            </select>
          </label>

          <label class="field">
            <span>初始筹码</span>
            <input type="number" id="startingStack" min="100" step="100" value="2000">
          </label>

          <div class="field field--grid">
            <label><span>小盲</span><input type="number" id="smallBlind" min="1" step="1" value="10"></label>
            <label><span>大盲</span><input type="number" id="bigBlind" min="2" step="1" value="20"></label>
          </div>

          <label class="field">
            <span>前注(每人每手,和下面的「大盲前注」二选一)</span>
            <input type="number" id="ante" min="0" step="1" value="0">
          </label>

          <div class="setup__toggles">
            <label class="switch"><input type="checkbox" id="bigBlindAnte"><i></i>
              <span><b>大盲前注</b>:大盲位额外拿出「一个当前大盲」当前注,其他位置不用出</span>
            </label>
            <label class="switch"><input type="checkbox" id="blindLevelUp"><i></i>
              <span><b>升盲模式</b>:每过 <b>10 个人回合</b>,盲注按固定档位上升一档(100/200 → … → 50,000/100,000)</span>
            </label>
          </div>

          <input type="hidden" id="blindUpEvery" value="0">
        </section>

        <section class="setup__col">
          <h3>AI 与节奏</h3>
          <label class="field">
            <span>AI 用哪家模型 <i class="hint-inline">想逐个角色分配,进牌桌后用顶栏「🤖 模型」</i></span>
            <select id="provider"></select>
          </label>
          <label class="field field--grid2">
            <span>模型 / API Key</span>
            <input type="text" id="model" spellcheck="false" list="modelList" placeholder="模型名">
            <input type="password" id="apiKey" placeholder="API Key(可留空用本地策略)" spellcheck="false" autocomplete="off">
          </label>
          <datalist id="modelList"></datalist>

          <div class="field field--grid">
            <label><span>节奏模式</span>
              <select id="flowMode">
                <option value="manual">手动:点「下一位」才继续(默认)</option>
                <option value="manualNext">手动 + 连打:不用反复点「下一位」</option>
                <option value="auto">自动:气泡至少停留 5 秒</option>
              </select>
            </label>
            <label><span>行动前停顿(秒)</span>
              <input type="number" id="thinkDelayMs" min="0" max="5" step="0.1" value="0.9">
            </label>
          </div>

          <!-- 节奏模式只决定「AI 之间怎么推进」;
               「一手打完后要不要自动开下一手」是**另一件事**,单独一个开关。
               默认关闭 —— 否则结算画面(摊牌横幅、筹码飞向赢家)会一闪而过。 -->
          <div class="setup__toggles" id="handFlowRow">
            <label class="switch"><input type="checkbox" id="autoNextHand"><i></i><span>一手结束后自动开下一手</span></label>
          </div>

          <!-- AI 记性:让每个 AI 跨手记住对手(含你)的打法并写自己的读人笔记。
               默认每 3 手写一次 —— 每手都写会让调用次数明显变多(短手牌尤其明显)。 -->
          <div class="setup__toggles" id="memoryRow">
            <label class="switch"><input type="checkbox" id="rememberPlayers" checked><i></i><span>AI 记住对手打法(跨手累积)</span></label>
            <label><span class="setup__inlineLabel">每几手整理一次</span>
              <input type="number" id="notesEvery" min="0" max="20" step="1" value="3">
            </label>
          </div>

          <!-- 玩家模式下看不到别人的思考,这个开关就没意义了(由 setMode 隐藏) -->
          <div class="setup__toggles" id="thinkToggleRow">
            <label class="switch"><input type="checkbox" id="showThinking" checked><i></i><span>显示思考气泡</span></label>
          </div>

          <div class="personas" id="personaList"></div>
          <p class="setup__note" id="apiNote"></p>
        </section>
      </div>

      <div class="setup__foot">
        <div class="setup__footInfo" id="footInfo"></div>
        <div class="setup__footBtns">
          ${mode === 'drawer' ? '<button class="btn btn--ghost btn--danger" id="btnExitHome" title="结束当前牌局,回到主页重新选模式">↩ 退出本局,回主页</button>' : ''}
          ${mode === 'lobby' ? '<button class="btn btn--ghost" id="btnLocal">用本地策略试玩</button>' : ''}
          <button class="btn btn--ghost" id="btnSave">保存设置</button>
          <button class="btn btn--primary btn--big" id="btnStart">${mode === 'lobby' ? '开始' : '应用'}</button>
        </div>
      </div>
    </div>
  `;

  root.appendChild(wrap);

  const q = (id) => wrap.querySelector('#' + id);
  const preview = q('seatPreview');
  const note = q('apiNote');

  q('personaList').innerHTML = '<h4>AI 性格池(每局随机分配,大多是正常牌手略偏一门)</h4>'
    + PERSONA_LIST.map(([, name, desc], i) =>
      `<div class="persona-chip" data-i="${i}"><span class="persona-chip__face pc${i % 8}"></span>
       <span class="persona-chip__txt"><b>${name}</b><span>${desc}</span></span></div>`).join('');

  /** 座位预览:弧线排开的小圆点(和你看到的 3D 站位一致) */
  function drawPreview(count) {
    const n = Math.max(1, Math.min(9, count | 0));
    const W = 240, H = 74;
    let dots = '';
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const a = Math.PI * (0.06 + 0.88 * t);
      const x = W / 2 - Math.cos(a) * (W / 2 - 16);
      const y = 12 + Math.sin(a) * (H - 30);
      dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6.5" class="pv-seat"/>
               <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" class="pv-face"/>`;
    }
    preview.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="pv" aria-label="${n} 人座位预览">
        <ellipse cx="${W / 2}" cy="${H - 12}" rx="${W / 2 - 26}" ry="30" class="pv-felt"/>
        <circle cx="${W / 2}" cy="${H - 14}" r="7" class="pv-you"/>
        <text x="${W / 2}" y="${H - 10}" class="pv-you-label">你</text>
        ${dots}
      </svg>`;
  }

  function renderProviders() {
    const sel = q('provider');
    sel.innerHTML = providers.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  }

  function syncModels(keepCurrent) {
    const p = providers.find((x) => x.id === q('provider').value);
    if (!p) return;
    const list = q('modelList');
    list.innerHTML = p.models.map((m) => `<option value="${m}"></option>`).join('');
    if (!keepCurrent || !q('model').value.trim()) q('model').value = p.defaultModel || '';
    q('apiKey').placeholder = p.noKey ? '本地模型' : (cfg?.hasKey ? '已保存' : p.keyHint || 'API Key');    refreshNote();
  }

  function refreshNote() {
    const p = providers.find((x) => x.id === q('provider').value);
    const has = p?.noKey || (currentKeys[p?.id] || '').trim() || (q('apiKey')?.value || '').trim();
    // 只报「配没配上」,不再解释一大堆规则
    note.textContent = p?.noKey
      ? '✅ 本地模型'
      : has
        ? `✅ ${p?.name} 已配置`
        : `⚠️ 未配置 ${p?.name || ''} —— 用本地策略`;
    const plan = p?.note;
    if (plan) note.textContent += ' · ' + plan;
  }

  let providers = [];
  let currentKeys = {};
  let cfg = null;
  // 当前是不是玩家模式 —— 底部汇总与副标题都要跟着变(玩家模式下
  // 写「+ 你(荷官)」「你是荷官」都是自相矛盾的,实测被用户指出来过)
  let isPlayerMode = false;

  function fill(values) {
    cfg = values;
    providers = values.providerList || providers;
    currentKeys = values.keys || {};
    const g = values.game || {};
    const ui = values.ui || {};
    q('seats').value = g.seats ?? 6;
    q('shortDeck').value = String(!!g.shortDeck);
    q('startingStack').value = g.startingStack ?? 2000;
    q('smallBlind').value = g.smallBlind ?? 10;
    q('bigBlind').value = g.bigBlind ?? 20;
    q('ante').value = g.ante ?? 0;
    q('blindUpEvery').value = 0;
    q('bigBlindAnte').checked = !!g.bigBlindAnte;
    q('blindLevelUp').checked = !!g.blindLevelUp;
    renderProviders();
    q('provider').value = values.defaultProvider || 'deepseek';
    q('model').value = values.seatModels?.[0] || '';
    q('thinkDelayMs').value = ((ui.thinkDelayMs ?? 900) / 1000).toFixed(1);
    q('flowMode').value = ui.flowMode || 'manual';
    q('autoNextHand').checked = !!ui.autoNextHand;   // 默认关:结算画面要看清
    // AI 记性默认开:关掉的话 AI 每手都从零开始,打法不会有变化
    q('rememberPlayers').checked = ui.rememberPlayers !== false;
    q('notesEvery').value = (ui.notesEvery === undefined ? 3 : ui.notesEvery);
    q('showThinking').checked = ui.showThinking !== false;
    syncModels(false);
    syncLabels();
  }

  function syncLabels() {
    q('seatsVal').textContent = q('seats').value;
    drawPreview(Number(q('seats').value));
    const sb = Number(q('smallBlind').value) || 10;
    const bb = Number(q('bigBlind').value) || 20;
    const stack = Number(q('startingStack').value) || 2000;
    const mode = { manual: '手动', manualNext: '手动+连打', auto: '自动' }[q('flowMode').value] || '手动';
    const extras = [];
    if (q('bigBlindAnte').checked) extras.push(`大盲前注 ${bb}`);
    else {
      const ante = Number(q('ante').value) || 0;
      if (ante > 0) extras.push(`前注 ${ante}`);
    }
    if (q('blindLevelUp').checked) extras.push('每 10 人回合升盲');
    // AI 记性状态也报一下 —— 这个开关会明显影响调用次数与打法,得让人看得见
    const memOn = q('rememberPlayers').checked;
    const memEvery = Math.max(0, Number(q('notesEvery').value) || 0);
    const memText = (memOn && memEvery > 0)
      ? `AI 每 ${memEvery} 手记住你的打法`
      : 'AI 不记忆(每手从零开始)';
    // 「你」在两种模式里的身份不同,底部这行汇总也得跟着变 ——
    // 玩家模式下写「+ 你(荷官)」是自相矛盾的。
    const meText = isPlayerMode ? '+ 你(上桌打)' : '+ 你(荷官)';
    q('footInfo').textContent =
      `${q('seats').value} 位 AI 牌手 ${meText} · 起始 ${stack} 筹码 = ${(stack / bb).toFixed(0)} 个大盲 · `
      + `盲注 ${sb}/${bb}${extras.length ? ' · ' + extras.join(' · ') : ''} · ${mode} · ${memText}`;
  }

  function collect() {
    const game = {
      seats: Number(q('seats').value),
      shortDeck: q('shortDeck').value === 'true',
      startingStack: Number(q('startingStack').value),
      smallBlind: Number(q('smallBlind').value),
      bigBlind: Number(q('bigBlind').value),
      ante: Number(q('ante').value),
      bigBlindAnte: q('bigBlindAnte').checked,
      blindLevelUp: q('blindLevelUp').checked,
      blindUpEvery: 0,
    };
    const providerId = q('provider').value;
    const ai = { defaultProvider: providerId, model: q('model').value.trim() };
    const key = q('apiKey').value.trim();
    if (key) ai.keys = { [providerId]: key };
    const ui = {
      thinkDelayMs: Math.round((Number(q('thinkDelayMs').value) || 0) * 1000),
      flowMode: q('flowMode').value,
      // 与 flowMode 独立:节奏模式管「AI 之间怎么推进」,
      // 这个管「一手打完要不要自动开下一手」。默认 false。
      autoNextHand: q('autoNextHand').checked,
      // AI 记性:开启后每个 AI 会跨手累积对对手(含你)的判断。
      // notesEvery = 每几手整理一次;0 等于关掉(不额外花调用)。
      rememberPlayers: q('rememberPlayers').checked,
      notesEvery: Math.max(0, Number(q('notesEvery').value) || 0),
      showThinking: q('showThinking').checked,
    };
    return { game, ai, ui };
  }

  for (const id of ['seats', 'smallBlind', 'bigBlind', 'startingStack', 'ante']) {
    q(id).addEventListener('input', syncLabels);
  }
  for (const id of ['bigBlindAnte', 'blindLevelUp', 'autoNextHand', 'rememberPlayers', 'notesEvery']) {
    q(id).addEventListener('change', syncLabels);
  }
  q('flowMode').addEventListener('change', syncLabels);
  q('provider').addEventListener('change', () => syncModels(true));
  q('apiKey').addEventListener('input', refreshNote);
  q('bigBlind').addEventListener('change', () => {
    const sb = Number(q('smallBlind').value) || 10;
    if (Number(q('bigBlind').value) < sb) q('bigBlind').value = sb * 2;
    syncLabels();
  });

  function setApiNote(hasKey) {
    if (cfg) cfg.hasKey = hasKey;
    refreshNote();
  }

  q('btnSave').addEventListener('click', async () => {
    const { ai, ui, game } = collect();
    const res = await onSaveAI({ ...ai, ui, game });
    setApiNote(!!res?.hasKey);
    q('apiKey').value = '';
    q('apiKey').placeholder = '已保存';
    note.textContent = '✅ 已保存';
  });

  q('btnStart').addEventListener('click', async () => {
    const values = collect();
    const res = await onSaveAI({ ...values.ai, ui: values.ui, game: values.game });
    setApiNote(!!res?.hasKey);
    q('apiKey').value = '';
    onStart(values, {});
  });

  q('btnLocal')?.addEventListener('click', () => {
    const values = collect();
    onSaveAI({ ...values.ai, ui: values.ui, game: values.game });
    onStart(values, { forceLocal: true });
  });

  q('setupClose')?.addEventListener('click', () => hide());

  q('btnExitHome')?.addEventListener('click', () => {
    // 先保存当前设置(下次进来还是这套),再退出
    const values = collect();
    onSaveAI({ ...values.ai, ui: values.ui, game: values.game });
    hide();
    onExitHome?.();
  });

  function show() { wrap.classList.add('is-open'); }
  function hide() { wrap.classList.remove('is-open'); }
  function destroy() { wrap.remove(); }

  /** 玩家模式下藏掉「显示思考气泡」(看不到别家的思考,这个开关没意义) */
  function setPlayerMode(on) {
    isPlayerMode = !!on;
    const row = q('thinkToggleRow');
    if (row) row.hidden = !!on;
    // 标题说明随模式变:玩家模式下不该出现「你是荷官」这种说法
    const sub = q('setupSub');
    if (sub) {
      sub.innerHTML = on
        ? '你自己上桌打。<b style="color:#e9c46a">牌局进行中看不到别家的牌与思考</b>,'
          + '这一手结束后可以在「上一手记录」里回看。'
        : '你是荷官:坐在桌边发牌、控节奏、看每个人的想法。'
          + '<b style="color:#e9c46a">你自己不参与下注也没有手牌</b>,桌上全是独立的大模型牌手。';
    }
    const start = q('btnStart');
    if (start && mode === 'lobby') start.textContent = on ? '开始牌局' : '开始';
  }

  return { show, hide, destroy, fill, collect, setApiNote, setPlayerMode, el: wrap };
}
