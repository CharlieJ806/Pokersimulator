/**
 * 模型分配面板:给每个座位单独选厂商与模型。
 *
 * 三层结构:
 *   1. 全局密钥:每个厂商一个 Key(填一次,所有座位共用);
 *   2. 默认模型:没单独指定的座位用它;
 *   3. 逐座位覆盖:想让某个人用别的模型就单独选。
 */

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function createModelsPanel(root, opts = {}) {
  const wrap = el('div', 'setup setup--drawer models');
  root.appendChild(wrap);

  let providers = [];
  let state = {
    defaultProvider: 'deepseek',
    seatProviders: {},
    seatModels: {},
    keys: {},
    seats: 6,
  };
  let personas = new Map();

  const q = (id) => wrap.querySelector('#' + id);

  wrap.innerHTML = `
    <div class="setup__card setup__card--wide">
      <div class="setup__head">
        <div>
          <h1>给每个 AI 分配模型</h1>
          <p class="setup__sub">
            每个座位都是独立的 AI 代理,可以分别用不同的厂商和模型 —— 比如让爱施压的那位用快模型,
            让算赔率的那位用聪明一点的模型。没有 Key 的座位会自动退回内置的本地策略,牌局照样打得下去。
          </p>
        </div>
        <button class="btn btn--ghost" id="mdlClose">✕ 关闭</button>
      </div>

      <div class="setup__body setup__body--models">
        <section class="setup__col">
          <h3>1 · 填写厂商密钥</h3>
          <p class="models__hint">Key 只保存在你这台机器上。本地模型(Ollama / LM Studio)不需要 Key。</p>
          <div class="keylist" id="keyList"></div>
        </section>

        <section class="setup__col">
          <h3>2 · 默认模型</h3>
          <label class="field">
            <span>默认厂商</span>
            <select id="defProvider"></select>
          </label>
          <label class="field">
            <span>默认模型</span>
            <input type="text" id="defModel" spellcheck="false" list="defModelList">
            <datalist id="defModelList"></datalist>
          </label>
          <p class="models__hint" id="defNote"></p>

          <h3 style="margin-top:18px">3 · 逐座位分配</h3>
          <p class="models__hint">留空 = 跟随默认。当前这手牌结束后生效(改模型不需要重开牌局)。</p>
          <div class="seatsettings" id="seatSettings"></div>
        </section>
      </div>

      <div class="setup__foot">
        <div class="setup__footInfo" id="mdlInfo"></div>
        <div class="setup__footBtns">
          <button class="btn btn--ghost" id="mdlLocal">全部改用本地策略</button>
          <button class="btn btn--primary btn--big" id="mdlSave">保存并应用</button>
        </div>
      </div>
    </div>
  `;

  /* ---------------- 厂商与密钥 ---------------- */

  function providerOptions(includeInherit) {
    const out = includeInherit ? ['<option value="">(跟随默认)</option>'] : [];
    for (const p of providers) {
      out.push(`<option value="${p.id}">${p.name}${p.noKey ? '(免 Key)' : ''}</option>`);
    }
    out.push('<option value="local">本地策略(不调用模型)</option>');
    return out.join('');
  }

  function renderKeys() {
    const list = q('keyList');
    list.innerHTML = '';
    for (const p of providers) {
      if (p.id === 'custom') continue;
      const row = el('div', 'keyrow');
      const has = !!(state.keys?.[p.id] || '').trim();
      row.innerHTML = `
        <div class="keyrow__head">
          <b>${p.name}</b>
          ${p.noKey ? '<span class="tag tag--ok">免 Key</span>' : (has ? '<span class="tag tag--ok">已填</span>' : '<span class="tag">未填</span>')}
          ${p.signup ? `<a href="${p.signup}" target="_blank" rel="noreferrer" class="keyrow__link">获取 Key</a>` : ''}
        </div>
        ${p.noKey ? '' : `<input type="password" data-key="${p.id}" placeholder="${p.keyHint || 'sk-...'}" autocomplete="off" spellcheck="false">`}
        <div class="keyrow__note">${p.note || ''}</div>
      `;
      list.appendChild(row);
    }
  }

  function renderDefault() {
    const sel = q('defProvider');
    sel.innerHTML = providerOptions(false);
    sel.value = state.defaultProvider || 'deepseek';
    syncDefaultModel(true);
  }

  function currentProvider() {
    const id = q('defProvider').value;
    return providers.find((p) => p.id === id) || providers[0];
  }

  function syncDefaultModel(reset) {
    const p = currentProvider();
    const list = q('defModelList');
    list.innerHTML = (p.models || []).map((m) => `<option value="${m}"></option>`).join('');
    if (reset) q('defModel').value = p.defaultModel || '';
    q('defNote').textContent = p.note || '';
    q('defNote').classList.toggle('is-warn', !!(p.noKey === false && !(state.keys?.[p.id] || '').trim() && p.id !== 'custom'));
  }

  /* ---------------- 逐座位 ---------------- */

  function renderSeats() {
    const box = q('seatSettings');
    box.innerHTML = '';
    for (let seat = 0; seat < state.seats; seat++) {
      const persona = personas.get(seat) || {};
      const row = el('div', 'seatsetting');
      const av = persona.avatarSvg
        ? `background-image:url("data:image/svg+xml;utf8,${encodeURIComponent(persona.avatarSvg)}")`
        : '';
      row.innerHTML = `
        <div class="seatsetting__who">
          <span class="seatsetting__avatar" style="${av}">${persona.avatarSvg ? '' : (persona.emoji || '🙂')}</span>
          <span class="seatsetting__name">${persona.name || `座位 ${seat + 1}`}</span>
          <span class="seatsetting__tag">${persona.tag || ''}</span>
        </div>
        <select data-seat-provider="${seat}">${providerOptions(true)}</select>
        <input type="text" data-seat-model="${seat}" placeholder="模型(跟随默认)" spellcheck="false">
      `;
      box.appendChild(row);
      const ps = row.querySelector(`[data-seat-provider="${seat}"]`);
      const ms = row.querySelector(`[data-seat-model="${seat}"]`);
      ps.value = state.seatProviders?.[seat] || '';
      ms.value = state.seatModels?.[seat] || '';
      ps.addEventListener('change', () => {
        // 换了厂商,把模型留空让用户重新选(避免厂商与模型不匹配)
        ms.value = '';
        ms.placeholder = ps.value ? `模型(默认 ${(providers.find((p) => p.id === ps.value)?.defaultModel) || '—'})` : '模型(跟随默认)';
      });
    }
  }

  function collect() {
    const keys = { ...(state.keys || {}) };
    for (const input of wrap.querySelectorAll('input[data-key]')) {
      const id = input.dataset.key;
      const v = input.value.trim();
      if (v) keys[id] = v;             // 留空表示不改
    }
    const seatProviders = {};
    const seatModels = {};
    for (let seat = 0; seat < state.seats; seat++) {
      const p = wrap.querySelector(`[data-seat-provider="${seat}"]`)?.value || '';
      const m = wrap.querySelector(`[data-seat-model="${seat}"]`)?.value.trim() || '';
      if (p) seatProviders[seat] = p;
      if (m) seatModels[seat] = m;
    }
    return {
      defaultProvider: q('defProvider').value,
      model: q('defModel').value.trim(),
      keys,
      seatProviders,
      seatModels,
    };
  }

  function fill(cfg) {
    providers = cfg.providerList || providers;
    state = {
      defaultProvider: cfg.defaultProvider || 'deepseek',
      seatProviders: cfg.seatProviders || {},
      seatModels: cfg.seatModels || {},
      keys: cfg.keys || {},
      seats: cfg.game?.seats ?? state.seats,
    };
    // 兼容老配置:只有 endpoint/apiKey/model 时,迁移成 deepseek 的 key
    if (!Object.keys(state.keys).length && cfg.apiKey) state.keys = { deepseek: cfg.apiKey };
    if (!q('keyList')) return;
    renderKeys();
    renderDefault();
    renderSeats();
    updateInfo();
  }

  function setSeats(n, personaMap) {
    state.seats = n;
    personas = personaMap || new Map();
    if (q('seatSettings')) { renderSeats(); updateInfo(); }
  }

  function updateInfo() {
    const c = collect();
    const usable = providers.filter((p) => p.id !== 'custom' && (p.noKey || (c.keys[p.id] || '').trim())).length;
    q('mdlInfo').textContent = `${state.seats} 个座位 · 已配置 ${usable} 家厂商的密钥 · 默认 ${c.defaultProvider}/${c.model || '默认模型'}`;
  }

  q('defProvider').addEventListener('change', () => { syncDefaultModel(true); updateInfo(); });
  q('defModel').addEventListener('input', updateInfo);
  q('mdlClose').addEventListener('click', () => hide());
  q('mdlLocal').addEventListener('click', () => {
    state.seatProviders = {};
    state.seatModels = {};
    for (let seat = 0; seat < state.seats; seat++) state.seatProviders[seat] = 'local';
    q('defProvider').value = 'local';
    renderSeats();
    updateInfo();
  });
  q('mdlSave').addEventListener('click', () => {
    const patch = collect();
    opts.onSave?.(patch);
    hide();
  });

  function show() { wrap.classList.add('is-open'); }
  function hide() { wrap.classList.remove('is-open'); }
  function isOpen() { return wrap.classList.contains('is-open'); }

  return { show, hide, isOpen, fill, setSeats, collect, el: wrap };
}
