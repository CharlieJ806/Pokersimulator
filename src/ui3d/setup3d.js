/**
 * 开局设置面板 + 中途改规则抽屉(3D 版)。
 *
 * 与旧版的区别:座位预览改成「弧形排开的小圆点」,直接对应 3D 场景里的站位。
 *
 * ────────────────────────────────────────────────────────────
 * 想改什么:
 *   · 设置页有哪些项、排布怎样 → 文件里的 HTML 模板(搜 class="field")
 *   · 「牌手人数」滑杆           → id="seats" + drawPreview()
 *   · 升盲模式 + 升盲周期        → id="blindLevelUp" / id="blindLevelHands"(0 = 不按档位升盲)
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

export function createSetup(root, { onStart, onSaveAI, onExitHome, onBack, onModels, onBlindLevelHands, mode = 'lobby' } = {}) {
  const wrap = el('div', `setup setup--${mode}`);
  wrap.innerHTML = `
    <div class="setup__card">
      <div class="setup__head">
        <div>
          <h1>德州扑克模拟器 <span class="setup__ver">Poker Simulator</span></h1>
          <p class="setup__sub" id="setupSub"></p>
        </div>
        ${mode === 'drawer' ? '<button class="btn btn--ghost" id="setupClose">✕ 关闭</button>' : ''}
        ${mode === 'lobby' ? '<button class="btn btn--ghost" id="setupBack" title="回到主页重新选模式">← 返回主页</button>' : ''}
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
              <span><b>升盲模式</b>:每过多少手牌按固定档位上升一档(100/200 → … → 50,000/100,000)</span>
            </label>
            <!-- ★ 升盲周期:以前是引擎里写死的常量,界面上只能看到顶栏那句「本档 0/10 回合」,改不了。
                  ⚠️ 单位踩过一次坑:这个间隔原来按「个人回合」(orbit = 按钮位转一圈 = 人数手)算,
                     9 人桌设 3 就变成每 27 手才升一档 —— 用户想的是「一手」,于是反馈「设了没生效」。
                     现在按**手**算、与人数无关:填 3 就是第 3 手打完、第 4 手开始用新盲注。
                  放在这个开关**正下方**(同一个 .setup__toggles 分组),而不是另起一块规则:
                  它和上面的复选框说的是同一件事(「每隔多久升一档」),分开摆会被当成两条独立设置。
                  沿用 #blindUpEvery 当年那套行内写法(一行 label + 小号说明文字),样式不用加新的。
                  语义:
                    · N = 多少**手**升一档(与人数无关;顶栏会显示「本档 i/N 手」);
                    · 0 = 永不按档位升盲(与旧版「每 N 手翻倍」的 0 同一套直觉);
                    · 留空 / 负数 / abc / 小数都夹成合法值,超大值夹到 9999(≈ 这一局几乎不升档);
                    · 默认 20 手:旧的默认是 10 个 orbit,换算成手数会跟人数走(6 人桌 60 手),
                      手数只有一个数可用,20 是「与人数无关、400 手到顶档」的那个整数档;
                    · 填了就算没勾上面的开关也不报错,只是等勾上才生效(见 collect())。
                  ⚠️ 「每 N 手盲注翻倍」(blindUpEvery)的用户入口**已按用户要求撤掉**;
                     引擎里那条能力仍然保留(配置默认 0 = 不升盲),这里不再暴露它的输入框。 -->
            <label>
              <span class="setup__inlineLabel">每</span>
              <input type="number" id="blindLevelHands" min="0" max="9999" step="1" value="20"
                     title="每多少手牌上升一档;0 = 永不按档位升盲。牌局进行中改也立即生效(从当前这一手重新起算,不会马上升档)" />
              <span class="setup__inlineLabel">手升一档(0 = 不按档位升盲)</span>
            </label>
          </div>
        </section>

        <section class="setup__col">
          <h3>AI 与节奏</h3>
          <label class="field">
            <span class="field__labelRow">AI 默认用哪家模型
              <!-- 开局前就能逐座位配:以前只能进了牌桌再从顶栏改 -->
              <button type="button" class="btn btn--ghost btn--tiny" id="btnSeatModels">🤖 逐座位分配模型 / 中转站</button>
            </span>
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

          <!-- ⚠️ 这里原来是「显示思考气泡」开关(#showThinking + #thinkToggleRow)。
               已经删掉了,和顶栏那个「💭 气泡」按钮一起:
               它控制的只是**气泡里要不要显示思考文字**,而这个行为现在固定为开
               (见 app.js 里 stepOnce 的 onThink / thinkingText)。留着会变成一个
               「点了没反应」的死开关 ——
               本仓库已经在 blindUpEvery 上踩过这个坑(界面入口撤了、字段还在)。
               玩家模式那边本来就用 setPlayerMode 把它藏起来,现在整行不存在了。 -->

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
    // 升盲周期。⚠️ 这里以前写死过值(同一个坑我们在 blindUpEvery 上踩过一次:
    //    界面写死 → 配置项永远被 collect() 覆盖回那个常数 = 死字段)。
    //    g.blindLevelHands 缺省时给 20 —— 与引擎的默认值 BLIND_LEVEL_HANDS 一致,
    //    不然老配置文件打开面板会显示成 0(0 = 不按档位升盲),一保存就把用户的档位升盲关掉了。
    const cfgHands = Math.floor(Number(g.blindLevelHands));
    q('blindLevelHands').value = Number.isFinite(cfgHands) && cfgHands >= 0 ? cfgHands : 20;
    q('bigBlindAnte').checked = !!g.bigBlindAnte;
    q('blindLevelUp').checked = !!g.blindLevelUp;
    renderProviders();
    q('provider').value = values.defaultProvider || 'deepseek';
    // 「默认模型」存在 values.model(模型面板里的「默认」也是它);留空时 syncModels 补厂商默认
    q('model').value = values.model || '';
    q('thinkDelayMs').value = ((ui.thinkDelayMs ?? 900) / 1000).toFixed(1);
    q('flowMode').value = ui.flowMode || 'manual';
    q('autoNextHand').checked = !!ui.autoNextHand;   // 默认关:结算画面要看清
    // AI 记性默认开:关掉的话 AI 每手都从零开始,打法不会有变化
    q('rememberPlayers').checked = ui.rememberPlayers !== false;
    q('notesEvery').value = (ui.notesEvery === undefined ? 3 : ui.notesEvery);
    // 老配置里的 ui.showThinking 不再读了(开关已删,思考文字恒为显示);
    // 键本身由 config.cjs / web/pokerApi.js 的 stripLegacyKeys 清掉。
    // 保留已保存的模型名(以前传 false,每次打开设置都被重置成厂商默认,用户的选择被冲掉)
    syncModels(true);
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
    // 升盲周期要是也跟着报:两条路径互不依赖,汇总里只写「每 20 手升盲」
    // 会让人以为刚填的数字没生效(实测这类「设了没反应」的反馈最难查)。
    // 读的是**输入框当前值**(不是配置),所以还没保存、刚敲进去的数字也会出现在汇总里。
    // ⚠️ 单位写「手」而不是「人回合」—— 这个字错了会让用户按错误的单位填数(就是本次改动的原因)。
    const handsRaw = Math.floor(Number(q('blindLevelHands').value));
    const hands = Number.isFinite(handsRaw) && handsRaw >= 0 ? Math.min(9999, handsRaw) : 20;
    if (q('blindLevelUp').checked) extras.push(`每 ${hands} 手升一档`);
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

  /**
   * 把输入框里的数整理成合法值,并**写回输入框**(让人看得到被改成了什么)。
   * 不校验的话:小盲 > 大盲时最小加注额比跟注额还低;大盲清空成 0 时底部显示
   * 「Infinity 个大盲」;初始筹码 0 / 负数时每次发牌都抛「至少需要 2 名有筹码的玩家」。
   */
  function sanitizeNumbers() {
    const int = (id, min, dflt) => {
      const v = Math.floor(Number(q(id).value));
      return Number.isFinite(v) && v >= min ? v : dflt;
    };
    const bigBlind = int('bigBlind', 2, 20);
    const smallBlind = Math.min(int('smallBlind', 1, Math.max(1, Math.floor(bigBlind / 2))), bigBlind);
    const startingStack = Math.max(int('startingStack', 1, 2000), bigBlind * 2);
    const ante = Math.min(int('ante', 0, 0), startingStack);
    // 升盲周期:0 = 不按档位升盲;负数 / 空白 / 小数都夹成合法值。
    // ⚠️ 空白 / 非数字回落的是**默认 20**,不是 0 —— 与引擎的 clampBlindLevelHands 同一套语义:
    //    0 本身是个合法值(「永不按档位升盲」),所以空白不能理解成 0,
    //    否则用户把这一格清空再保存,会以为「没填就是不改」,实际却把档位升盲整个关掉了。
    //    ⚠️ 这里必须显式判空串:Number('') === 0,只判 isFinite 会把空白当成合法的 0。
    //    负数 / abc 同样回落到 20(那两种输入显然不是「我想关掉」的意思)。
    // 引擎那边还会再夹一次,这里夹是为了**回写到输入框**让人看见自己填的 abc / -5 变成了什么。
    const handsTxt = String(q('blindLevelHands').value).trim();
    const handsRaw = Math.floor(Number(handsTxt));
    const blindLevelHands = (handsTxt !== '' && Number.isFinite(handsRaw) && handsRaw >= 0)
      ? Math.min(9999, handsRaw)
      : 20;
    q('bigBlind').value = bigBlind;
    q('smallBlind').value = smallBlind;
    q('startingStack').value = startingStack;
    q('ante').value = ante;
    q('blindLevelHands').value = blindLevelHands;
    return { bigBlind, smallBlind, startingStack, ante, blindLevelHands };
  }

  function collect() {
    const nums = sanitizeNumbers();
    // ⚠️ blindUpEvery(「每 N 手翻倍」)在这个面板里**已经没有入口了**(用户要求只留档位升盲),
    //    但绝不能像以前那样在这里把它写死 0 —— 那会把用户配置里已有的值冲掉(这个仓库
    //    反复出现的「死字段 / 写死值」坑)。这里的规矩是:**不读取、但也不覆盖**,
    //    原样保留 cfg 里那份值(没有就给 0 = 不升盲,引擎的默认值)。
    const keepBlindUpEvery = Math.max(0, Math.floor(Number(cfg?.game?.blindUpEvery) || 0));
    const game = {
      seats: Number(q('seats').value),
      shortDeck: q('shortDeck').value === 'true',
      startingStack: nums.startingStack,
      smallBlind: nums.smallBlind,
      bigBlind: nums.bigBlind,
      ante: nums.ante,
      bigBlindAnte: q('bigBlindAnte').checked,
      blindLevelUp: q('blindLevelUp').checked,
      // ★ 「每 N 手升一档」—— 这条链路必须完整:输入框 → collect().game →
      //   app.js 的 buildEngine → new PokerEngine({ blindLevelHands }) → 引擎读 state 里的值。
      //   (引擎支持、界面没有、或者传丢了一环,就是这个仓库最常见的「死字段」。)
      blindLevelHands: nums.blindLevelHands,
      // 已撤掉界面入口的旧字段:保留配置里原有的值,不读取、也不覆盖(见上面 keepBlindUpEvery)。
      blindUpEvery: keepBlindUpEvery,
    };
    const providerId = q('provider').value;
    const ai = { defaultProvider: providerId, model: q('model').value.trim() };
    const key = q('apiKey').value.trim();
    if (key) ai.keys = { [providerId]: key };
    const ui = {
      thinkDelayMs: Math.round(Math.max(0, Math.min(5, Number(q('thinkDelayMs').value) || 0)) * 1000),
      flowMode: q('flowMode').value,
      // 与 flowMode 独立:节奏模式管「AI 之间怎么推进」,
      // 这个管「一手打完要不要自动开下一手」。默认 false。
      autoNextHand: q('autoNextHand').checked,
      // AI 记性:开启后每个 AI 会跨手累积对对手(含你)的判断。
      // notesEvery = 每几手整理一次;0 等于关掉(不额外花调用)。
      rememberPlayers: q('rememberPlayers').checked,
      notesEvery: Math.max(0, Math.min(20, Math.floor(Number(q('notesEvery').value) || 0))),
      // ⚠️ 这里原来还有 showThinking: q('showThinking').checked。
      //    那个开关和顶栏的「💭 气泡」按钮一起删了 —— 思考文字在气泡里恒为显示,
      //    没有可写的值。**不要再把它写回来**,哪怕是写死 true:
      //    配置里留一个没人读的键就是这个仓库反复出现的「死字段」。
    };
    return { game, ai, ui };
  }

  for (const id of ['seats', 'smallBlind', 'bigBlind', 'startingStack', 'ante']) {
    q(id).addEventListener('input', syncLabels);
  }
  for (const id of ['bigBlindAnte', 'blindLevelUp', 'autoNextHand', 'rememberPlayers', 'notesEvery']) {
    q(id).addEventListener('change', syncLabels);
  }
  // 升盲周期:改完就地生效,不用等「应用 / 开始」重开一局。
  // 这个参数只决定「这一手打完要不要升档」,不参与任何一注的计算,
  // 所以局中改它是安全的(见 engine.js 的 setBlindLevelHands)。
  // 同时把夹取后的值写回输入框 —— 填 -5 / 空 / abc 的时候人得看到它变成了什么。
  q('blindLevelHands').addEventListener('change', () => {
    const txt = String(q('blindLevelHands').value).trim();
    const raw = Math.floor(Number(txt));
    const v = (txt !== '' && Number.isFinite(raw) && raw >= 0) ? Math.min(9999, raw) : 20;
    q('blindLevelHands').value = v;
    onBlindLevelHands?.(v);
    syncLabels();
  });
  q('blindLevelHands').addEventListener('input', syncLabels);
  q('flowMode').addEventListener('change', syncLabels);
  // 换厂商时模型名换成新厂商的默认 —— 保留旧的会出现「OpenAI + deepseek-flash」这种对不上的组合
  q('provider').addEventListener('change', () => syncModels(false));
  q('apiKey').addEventListener('input', refreshNote);
  q('bigBlind').addEventListener('change', () => {
    const sb = Number(q('smallBlind').value) || 10;
    if (Number(q('bigBlind').value) < sb) q('bigBlind').value = sb * 2;
    syncLabels();
  });
  // 小盲那边以前没有检查:大盲 20、小盲改成 50 也能开局
  for (const id of ['smallBlind', 'startingStack', 'ante']) {
    q(id).addEventListener('change', () => { sanitizeNumbers(); syncLabels(); });
  }

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
  // 开局设置页以前没有任何返回入口,选错模式只能刷新页面
  q('setupBack')?.addEventListener('click', () => { hide(); onBack?.(); });
  // 把**当前滑杆上的人数**带过去:还没开局,配置里的人数可能还是上次的
  q('btnSeatModels')?.addEventListener('click', () => onModels?.(Number(q('seats').value) || 6));

  /**
   * 模型面板保存之后,只同步「默认厂商 / 默认模型」这两格。
   * 不能整份 fill():那会把用户在这一页改了但还没保存的人数、盲注等冲掉;
   * 也不能不同步:开局时 collect() 会把这里的旧值写回配置,刚在模型面板改的默认厂商就被覆盖了。
   */
  function syncAI(values) {
    if (!values) return;
    cfg = { ...(cfg || {}), ...values };
    if (values.defaultProvider) q('provider').value = values.defaultProvider;
    q('model').value = values.model || '';
    syncModels(true);
  }

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

  /** 玩家模式下藏掉荷官专属的设置项(目前只剩标题说明随模式变;「显示思考气泡」开关已删) */
  function setPlayerMode(on) {
    isPlayerMode = !!on;
    // 标题说明随模式变:玩家模式下不该出现「你是荷官」这种说法
    const sub = q('setupSub');
    if (sub) {
      sub.innerHTML = on
        ? '你自己上桌打。<b>牌局进行中看不到别家的牌与思考</b>,'
          + '这一手结束后可以在「上一手记录」里回看。'
        : '你是荷官:坐在桌边发牌、控节奏、看每个人的想法。'
          + '<b>你自己不参与下注也没有手牌</b>,桌上全是独立的大模型牌手。';
    }
    const start = q('btnStart');
    if (start && mode === 'lobby') start.textContent = on ? '开始牌局' : '开始';
    // 底部汇总里的「+ 你(荷官)/ 你(上桌打)」也跟着变(以前要等改了某个输入才刷新)
    syncLabels();
  }

  /**
   * 只同步「升盲周期」这一格。
   *
   * 为什么要单独开一个口子:这个设置**牌局进行中在抽屉里改会立刻生效**,
   * 而主页那个设置页是另一份 DOM、只在启动时 fill 过一次。不同步的话会出现
   * 「抽屉里显示每 5 手升一档、回主页打开设置却显示 20」,而这时候一点「开始」,
   * collect() 就把 20 写回配置 —— 刚调好的节奏被悄悄撤掉了。
   * 不能图省事用整份 fill():那会把用户在设置页改了还没保存的人数、盲注全冲掉
   * (见 syncAI 上面那段注释,同一个坑)。
   */
  function setBlindLevelHands(n) {
    const txt = String(n ?? '').trim();
    const raw = Math.floor(Number(txt));
    const v = (txt !== '' && Number.isFinite(raw) && raw >= 0) ? Math.min(9999, raw) : 20;
    q('blindLevelHands').value = v;
    syncLabels();
    return v;
  }

  return { show, hide, destroy, fill, collect, setApiNote, setPlayerMode, syncAI, setBlindLevelHands, el: wrap };
}
