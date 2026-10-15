/**
 * 模型分配面板:给每个座位单独选厂商、模型与性格。
 *
 * 三层结构:
 *   1. 全局密钥:每个厂商一个 Key(填一次,所有座位共用);
 *   2. 默认模型:没单独指定的座位用它;
 *   3. 逐座位覆盖:想让某个人用别的模型就单独选。
 *
 * 名字与性格是**分开**的:
 *   · 座位显示名由**模型**决定(相同模型自动加序号),见 ai/portraits.js;
 *   · 性格只决定打法(松紧、激进度、风险偏好),可以逐座位指定,默认随机。
 */

import { PERSONAS } from '../ai/personas.js';

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
    seatPersonas: {},
    seatNames: {},
    customEndpoint: '',
    customKeys: [],
    seatCustomKeys: {},
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

          <h3 style="margin-top:16px">自定义中转站</h3>
          <p class="models__hint">
            一个地址 + 多个 Key(每个 Key 能调的模型可能不同)。地址填 OpenAI 兼容的
            <b>/chat/completions</b> 完整地址;座位那里选 Key、填模型名即可。
            <br>⚠️ 用网页版(Worker 转发)时,还要把中转站域名加到 Worker 的
            <b>EXTRA_ALLOWED_HOSTS</b>,否则会被白名单拦掉;桌面版没有这个限制。
          </p>
          <label class="field">
            <span>接口地址</span>
            <input type="text" id="customEndpoint" spellcheck="false"
                   placeholder="https://你的中转站/v1/chat/completions">
          </label>
          <div class="keylist" id="customKeyList"></div>
          <button class="btn btn--ghost btn--tiny" id="customKeyAdd" type="button">+ 添加 Key</button>
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

  /**
   * 中转站的多个 Key。每个 Key 一个显示名 + 一个密钥。
   *
   * 为什么要多个:中转站常见「一个地址、多个 Key,每个 Key 能调的模型不一样」。
   * 所以座位那边要先选 Key,再填模型名。
   */
  function renderCustomKeys() {
    const list = q('customKeyList');
    if (!list) return;
    list.innerHTML = '';
    const keys = state.customKeys || [];
    if (!keys.length) {
      list.innerHTML = '<div class="keyrow__note">还没有 Key —— 点下面的「添加 Key」。</div>';
      return;
    }
    keys.forEach((k, i) => {
      const row = el('div', 'keyrow');
      row.innerHTML = `
        <div class="keyrow__head">
          <input type="text" class="ckey__label" data-ckey-label="${k.id}" value="${k.label || `Key ${i + 1}`}"
                 placeholder="用处(例如 便宜模型)" spellcheck="false">
          <button class="btn btn--ghost btn--tiny" data-ckey-del="${k.id}" type="button">删除</button>
        </div>
        <input type="password" data-ckey="${k.id}" value="${k.key || ''}" placeholder="sk-..." autocomplete="off" spellcheck="false">
      `;
      list.appendChild(row);
    });
    for (const btn of list.querySelectorAll('[data-ckey-del]')) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.ckeyDel;
        // 先收一遍当前输入再删,免得把别的行刚打的字丢了
        state.customKeys = collectCustomKeys().filter((k) => k.id !== id);
        renderCustomKeys();
        renderSeats();
      });
    }
  }

  /** 只读当前 DOM 里的 Key 行(新增/删除时用,避免覆盖用户刚输入的内容) */
  function collectCustomKeys() {
    const out = [];
    for (const row of wrap.querySelectorAll('#customKeyList .keyrow')) {
      const labelEl = row.querySelector('[data-ckey-label]');
      const keyEl = row.querySelector('[data-ckey]');
      if (!keyEl) continue;
      const id = keyEl.dataset.ckey;
      out.push({ id, label: (labelEl?.value || '').trim(), key: keyEl.value.trim() });
    }
    return out;
  }

  /**
   * 座位级的中转站 Key 下拉。
   * 只有一个 Key 时也照样给一个选项 —— 保持每行结构一致,列不会错位。
   */
  function customKeyOptions(selected) {
    // ⚠️ 这里**不能**按「Key 已填」过滤。用户是先点「添加 Key」再输入密钥的,
    //    过滤会让刚加的空行不出现在座位下拉里 —— 座位就永远选不到它,
    //    表现是「填了 Key,座位却选不了」(实测踩过)。
    //    真正丢弃空行是在保存时做的(collect 里 filter)。
    const keys = state.customKeys || [];
    const out = [];
    for (const k of keys) {
      const label = (k.label || '').trim() || k.id;
      out.push(`<option value="${k.id}"${k.id === selected ? ' selected' : ''}>${label}</option>`);
    }
    if (!out.length) out.push('<option value="">(中转站未配)</option>');
    return out.join('');
  }

  function renderKeys() {    const list = q('keyList');
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
    renderCustomKeys();
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

  /** 性格下拉的选项:随机 + 所有性格 */
  function personaOptions(selected) {
    const list = (PERSONAS || []).map((p) =>
      `<option value="${p.id}"${p.id === selected ? ' selected' : ''}>${p.name} · ${p.tag || ''}</option>`).join('');
    return `<option value=""${selected ? '' : ' selected'}>随机性格</option>${list}`;
  }

  function renderSeats() {
    const box = q('seatSettings');
    box.innerHTML = '';
    for (let seat = 0; seat < state.seats; seat++) {
      const persona = personas.get(seat) || {};
      const row = el('div', 'seatsetting');
      const av = persona.avatarSvg
        ? `background-image:url("data:image/svg+xml;utf8,${encodeURIComponent(persona.avatarSvg)}")`
        : '';
      // 展示名跟着**模型**走(相同模型自动加序号),性格只决定打法 ——
      // 所以这里显示 seatNames(模型名),性格单独一个下拉。
      const shown = state.seatNames?.[seat] || persona.name || `座位 ${seat + 1}`;
      row.innerHTML = `
        <div class="seatsetting__who">
          <span class="seatsetting__avatar" style="${av}">${persona.avatarSvg ? '' : (persona.emoji || '🙂')}</span>
          <span class="seatsetting__name">${shown}</span>
          <span class="seatsetting__tag">${persona.tag || ''}</span>
        </div>
        <select data-seat-provider="${seat}">${providerOptions(true)}</select>
        <input type="text" data-seat-model="${seat}" placeholder="模型(跟随默认)" spellcheck="false">
        <select data-seat-ckey="${seat}" title="中转站的哪个 Key(每个 Key 能调的模型可能不同)">${customKeyOptions(state.seatCustomKeys?.[seat] || '')}</select>
        <select data-seat-persona="${seat}" title="这个座位的性格(决定打法,不影响名字和立绘)">
          ${personaOptions(state.seatPersonas?.[seat] || '')}
        </select>
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
    const seatPersonas = {};
    const seatCustomKeys = {};
    for (let seat = 0; seat < state.seats; seat++) {
      const p = wrap.querySelector(`[data-seat-provider="${seat}"]`)?.value || '';
      const m = wrap.querySelector(`[data-seat-model="${seat}"]`)?.value.trim() || '';
      const pe = wrap.querySelector(`[data-seat-persona="${seat}"]`)?.value || '';
      const ck = wrap.querySelector(`[data-seat-ckey="${seat}"]`)?.value || '';
      if (p) seatProviders[seat] = p; else seatProviders[seat] = null;
      if (m) seatModels[seat] = m; else seatModels[seat] = null;
      // 空 = 「随机性格」。必须显式写 null 把它删掉,
      // 否则深合并会保留上一次的指定,用户再也回不到随机(见 config.cjs 的 deepMerge)。
      seatPersonas[seat] = pe || null;
      seatCustomKeys[seat] = ck || null;
    }
    // 中转站的 Key:只留填了密钥的行(显示名可留空)
    const customKeys = collectCustomKeys().filter((k) => k.key);
    return {
      defaultProvider: q('defProvider').value,
      model: q('defModel').value.trim(),
      keys,
      seatProviders,
      seatModels,
      seatPersonas,
      seatCustomKeys,
      customEndpoint: q('customEndpoint')?.value.trim() || '',
      customKeys,
    };
  }

  function fill(cfg) {
    providers = cfg.providerList || providers;
    let customKeys = Array.isArray(cfg.customKeys) ? cfg.customKeys.filter((k) => k && k.key) : [];
    // 一个 Key 都没有时先给一行空的,免得用户找不到入口
    if (!customKeys.length) customKeys = [{ id: 'k1', label: 'Key 1', key: '' }];
    state = {
      defaultProvider: cfg.defaultProvider || 'deepseek',
      seatProviders: cfg.seatProviders || {},
      seatModels: cfg.seatModels || {},
      seatPersonas: cfg.seatPersonas || {},
      seatNames: state.seatNames || {},
      customEndpoint: cfg.customEndpoint || '',
      customKeys,
      seatCustomKeys: cfg.seatCustomKeys || {},
      keys: cfg.keys || {},
      seats: cfg.game?.seats ?? state.seats,
    };
    // 兼容老配置:只有 endpoint/apiKey/model 时,迁移成 deepseek 的 key
    if (!Object.keys(state.keys).length && cfg.apiKey) state.keys = { deepseek: cfg.apiKey };
    if (!q('keyList')) return;
    renderKeys();
    if (q('customEndpoint')) q('customEndpoint').value = state.customEndpoint || '';
    renderDefault();
    renderSeats();
    updateInfo();
  }

  /**
   * 刷新座位行。
   * @param {number} n 座位数
   * @param {Map} personaMap 座位 → 性格(用来显示头像与打法标签)
   * @param {object} [seatNames] 座位 → 显示名(模型名;由 app.js 算好)
   */
  function setSeats(n, personaMap, seatNames) {
    state.seats = n;
    personas = personaMap || new Map();
    if (seatNames) state.seatNames = seatNames;
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
  // 添加一个中转站 Key。先把当前几行收下来(免得丢掉刚输入的内容),再加一行。
  q('customKeyAdd')?.addEventListener('click', () => {
    const cur = collectCustomKeys();
    const used = new Set(cur.map((k) => k.id));
    let n = cur.length + 1;
    let id = `k${n}`;
    while (used.has(id)) { n++; id = `k${n}`; }
    state.customKeys = [...cur, { id, label: `Key ${n}`, key: '' }];
    renderCustomKeys();
    renderSeats();
  });
  q('customEndpoint')?.addEventListener('input', updateInfo);
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
