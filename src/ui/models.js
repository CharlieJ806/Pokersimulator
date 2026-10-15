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
import { RELAY_PROTOCOLS, normalizeProtocol } from '../shared/llmStream.mjs';
// 连通性测试的判定逻辑放在共享模块里,不写在这儿 —— 那部分要能被
// `node tools/relayprobe.mjs` 纯 Node 直接跑(见 shared/llmProbe.mjs 的头注释)
import { runProbe, describeProbe, seatProbeSpec, keyProbeSpec } from '../shared/llmProbe.mjs';

/** 拼进 innerHTML 的用户输入(模型名、Key 显示名)一律转义 —— 引号还会截断 value 属性 */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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
            一个地址 + 多个 Key。地址填到 <b>/v1</b> 为止(例如
            <b>https://cf.api.fan/v1</b>),程序会按每个 Key 选的**协议**自动补上
            后面的路径;填完整路径也能认。
            <br>⚠️ <b>协议要按令牌分组选,不是按中转站选</b> —— 同一个中转站里,
            不同分组的令牌协议不同。以 PackyAPI 为例(模型卡片上有协议标签):
            <br>· Claude 系(<b>CC</b> 等分组)标 <b>ANTHROPIC</b> → 选「Anthropic」
            <br>· <b>Codex / gpt-officially</b> 分组、<b>Kimi-sale</b> 的 kimi-k3 标
            <b>OPENAI-RESPONSE</b> → 选「OpenAI Responses」
            <br>· 没标或标 <b>OPENAI</b> 的(deepseek / gemini-flash / glm-flash / qwen-flash 等)
            → 选「OpenAI 兼容」
            <br>· Gemini 的**原生**格式分组(中转站标 <b>GOOGLE</b>、走
            <b>…/models/{模型}:streamGenerateContent</b> 那种口,或直连
            generativelanguage.googleapis.com)→ 选「Google (Gemini)」。这个协议不用把路径填全:
            地址填到域名或 <b>/v1</b> 都行,程序会自己补路径,
            并把思考预算压到最低档(牌桌不需要长考,默认开满思考会等到超时)
            <br>选错的典型报错是 <b>protocol_not_supported</b>(模型不支持 chat completions 协议);
            <b>model_not_found / 无可用渠道</b> 则是令牌分组不对,要去中转站控制台换分组。
            <br>⚠️ 用网页版(Worker 转发)时,还要把中转站域名加到 Worker 的
            <b>EXTRA_ALLOWED_HOSTS</b>,否则会被白名单拦掉;桌面版没有这个限制。
          </p>
          <label class="field">
            <span>接口地址</span>
            <input type="text" id="customEndpoint" spellcheck="false"
                   placeholder="https://你的中转站/v1/chat/completions">
          </label>
          <label class="field">
            <span>推理档位</span>
            <select id="reasoningLevel">
              <option value="low">最低(默认 · 保留推理但压到最小)</option>
              <option value="default">厂商默认(不设防)</option>
              <option value="off">完全关闭(不推荐)</option>
            </select>
          </label>
          <p class="models__hint">
            默认<b>最低</b>:保留推理但压到最小 —— 别选关闭,除非你确定这个模型不需要推理。
            <br>推理 token 和正式回答<b>共用同一个额度</b>:不压的话,模型会先想很久
            (实测有一次等了 78 秒直接超时),或者把额度全用在推理上、
            正式那一个 JSON 一个字都没吐出来(界面会报「模型没有给出可识别的动作」)。
            <br>· <b>最低</b> = 四条协议各自发自己的最低档字段(OpenAI 的 reasoning_effort、
            Gemini 的 thinkingBudget、Anthropic 的 budget_tokens、Responses 的 reasoning.effort)。
            <br>· <b>完全关闭</b> = 一个字段都不发,模型连草稿都不打 —— 难题上会降智。
            <br>· <b>厂商默认</b> = 什么都不配,由上游自己决定(推理型模型会想很久)。
          </p>
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
          <input type="text" class="ckey__label" data-ckey-label="${esc(k.id)}" value="${esc(k.label || `Key ${i + 1}`)}"
                 placeholder="用处(例如 Claude / 便宜模型)" spellcheck="false">
          <button class="btn btn--ghost btn--tiny" data-ckey-del="${esc(k.id)}" type="button">删除</button>
        </div>
        <label class="ckey__proto">
          <span>协议</span>
          <select data-ckey-proto="${esc(k.id)}">${protocolOptions(k.protocol)}</select>
        </label>
        <input type="password" data-ckey="${esc(k.id)}" value="${esc(k.key || '')}" placeholder="sk-..." autocomplete="off" spellcheck="false">
        <div class="keyrow__foot">
          <button class="btn btn--ghost btn--tiny" data-ckey-test="${esc(k.id)}" type="button"
                  title="测这个 Key 的地址 + 协议 + 密钥通不通(模型名用便宜的占位)">测试</button>
          <span class="probetx" data-ckey-probe="${esc(k.id)}" role="status" aria-live="polite"></span>
        </div>
      `;
      list.appendChild(row);
    });
    for (const btn of list.querySelectorAll('[data-ckey-test]')) {
      btn.addEventListener('click', (e) => {
        // 先把 currentTarget 拿出来:下面 await 之后事件对象的 currentTarget 会被清空
        testCustomKey(e.currentTarget.dataset.ckeyTest, e.currentTarget);
      });
    }
    for (const btn of list.querySelectorAll('[data-ckey-del]')) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.ckeyDel;
        // 先收一遍当前输入再删,免得把别的行刚打的字丢了
        state.customKeys = collectCustomKeys().filter((k) => k.id !== id);
        keepSeatEdits();
        renderCustomKeys();
        renderSeats();
      });
    }
  }

  /**
   * 协议下拉。选项来自共享模块的 RELAY_PROTOCOLS —— 界面能选的值和
   * 底层 buildRequest 认的 kind 是同一份清单,不会对不上。
   */
  function protocolOptions(selected) {
    const cur = normalizeProtocol(selected);
    return RELAY_PROTOCOLS.map((p) => {
      const label = `${p.name}(${p.hint})`;
      return `<option value="${esc(p.id)}"${p.id === cur ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('');
  }

  /** 只读当前 DOM 里的 Key 行(新增/删除时用,避免覆盖用户刚输入的内容) */
  function collectCustomKeys() {
    const out = [];
    for (const row of wrap.querySelectorAll('#customKeyList .keyrow')) {
      const labelEl = row.querySelector('[data-ckey-label]');
      const keyEl = row.querySelector('[data-ckey]');
      if (!keyEl) continue;
      const id = keyEl.dataset.ckey;
      const protoEl = row.querySelector('[data-ckey-proto]');
      out.push({
        id,
        label: (labelEl?.value || '').trim(),
        key: keyEl.value.trim(),
        // 缺省 openai:老配置没有这个字段,按最常见的形态处理
        protocol: normalizeProtocol(protoEl?.value),
      });
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
      out.push(`<option value="${esc(k.id)}"${k.id === selected ? ' selected' : ''}>${esc(label)}</option>`);
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
          <span class="seatsetting__name">${esc(shown)}</span>
          <span class="seatsetting__tag">${persona.tag || ''}</span>
        </div>
        <select data-seat-provider="${seat}">${providerOptions(true)}</select>
        <input type="text" data-seat-model="${seat}" placeholder="模型(跟随默认)" spellcheck="false">
        <select data-seat-ckey="${seat}" title="中转站的哪个 Key(每个 Key 能调的模型可能不同)">${customKeyOptions(state.seatCustomKeys?.[seat] || '')}</select>
        <select data-seat-persona="${seat}" title="这个座位的性格(决定打法,不影响名字和立绘)">
          ${personaOptions(state.seatPersonas?.[seat] || '')}
        </select>
      `;
      // 「测试」按钮 + 结果:单独占满一行(grid-column: 1/-1,见 CSS)。
      // 为什么不挤进上面那一行:手机上面板很窄,5 个控件已经要换行,
      // 再塞一个按钮就把模型名输入框压成一条缝了。
      const testBox = el('div', 'seatsetting__test');
      testBox.innerHTML = `
        <button class="btn btn--ghost btn--tiny" data-seat-test="${seat}" type="button"
                title="测这个座位的接口地址 + Key + 协议 + 模型名 —— 不用开局就能知道配置能不能调通">测试</button>
        <span class="probetx" data-seat-probe="${seat}" role="status" aria-live="polite"></span>
      `;
      row.appendChild(testBox);
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
      testBox.querySelector('[data-seat-test]').addEventListener('click', (e) => {
        testSeat(seat, e.currentTarget);
      });
    }
  }

  /**
   * 把座位行里**还没保存**的修改收进 state。
   * renderSeats() 只按 state 画,增删中转站 Key 时要重画座位行 ——
   * 不先收一遍的话,刚改的厂商 / 模型名 / 性格会被恢复原样。
   */
  function keepSeatEdits() {
    if (!wrap.querySelector('[data-seat-provider]')) return;
    const c = collect();
    state.seatProviders = c.seatProviders;
    state.seatModels = c.seatModels;
    state.seatPersonas = c.seatPersonas;
    state.seatCustomKeys = c.seatCustomKeys;
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
    // 座位选的 Key 如果被丢掉了(没填密钥),别存一个悬空的 id ——
    // 运行时会悄悄换成第一个 Key,配着别的 Key 的模型名去调,多半 403/404
    const keptIds = new Set(customKeys.map((k) => k.id));
    for (const seat of Object.keys(seatCustomKeys)) {
      if (seatCustomKeys[seat] && !keptIds.has(seatCustomKeys[seat])) seatCustomKeys[seat] = null;
    }
    return {
      defaultProvider: q('defProvider').value,
      model: q('defModel').value.trim(),
      keys,
      seatProviders,
      seatModels,
      seatPersonas,
      seatCustomKeys,
      customEndpoint: q('customEndpoint')?.value.trim() || '',
      // 推理档位:与接口地址同一个区块、同一条「界面 → 配置」的路。
      // 认不出的值一律回落到最低档(见 llmStream.mjs 的 normalizeReasoningLevel)——
      // 少了这个兜底,老配置(没有这个字段)会让下拉显示空白,用户以为档位丢了。
      reasoningLevel: q('reasoningLevel')?.value || 'low',
      customKeys,
    };
  }

  /* ---------------- 连通性测试 ----------------
   *
   * 目的:不用开局就能知道「这个座位/这个 Key 到底能不能调通」。
   * 三件必须做到的事(都是踩过坑总结的):
   *   ① 走 window.pokerAPI.llmChat —— 网页版只有 Worker 转发这条路,
   *      自己 fetch 目标地址会因 CORS/白名单失败,把能用的配置判成不通;
   *   ② 测的是**面板里此刻**的配置(含还没保存的改动),不是上次保存的旧配置;
   *   ③ 失败时把上游原文照登 —— 用户排查靠的就是 protocol_not_supported /
   *      model_not_found 这几个词,写「调用失败」等于没写。
   */

  /**
   * 组装「测试用」的配置快照。
   * 复用 collect():它读的就是 DOM 里的现值,顺手也把中转站地址/各 Key 的协议算好了。
   */
  function testCfgSnapshot() {
    const c = collect();
    return { ...c, providerList: providers, game: { seats: state.seats } };
  }

  /** 写结果文本(三种状态:测试中… / ✅ / ❌) */
  function setProbeText(node, view, result) {
    if (!node) return;
    // ⚠️ 一律用 textContent 拼。这里是**上游返回的原文**,走 innerHTML
    //    就是一个现成的注入口子(中转站的错误体里放一段标签就能打进页面)。
    node.textContent = '';
    node.classList.remove('probetx--run', 'probetx--ok', 'probetx--err');
    node.classList.add(`probetx--${view.tone}`);
    node.appendChild(document.createTextNode(view.main || ''));
    if (view.detail) node.appendChild(el('div', 'probetx__sub', view.detail));
    if (result?.error) {
      // 界面上按窄屏需要截断了,全文另外留一份:鼠标悬停能看到,
      // 排障时也能直接从 DOM 里把一字不改的原文捞出来
      node.title = result.error;
      node.dataset.probeRaw = result.error;
    } else {
      node.removeAttribute('title');
      delete node.dataset.probeRaw;
    }
  }

  /**
   * 跑一次测试,结果内联在按钮旁边。
   * @param {HTMLButtonElement} btn 用来禁用防连点
   * @param {{spec?:object,error?:string}} built 请求(或「配置缺项」的说明,连请求都不发)
   */
  async function runTest(btn, built) {
    const node = btn.parentElement?.querySelector('.probetx');
    btn.disabled = true;                    // 防连点:测试要花钱,连点就是连花
    const prev = btn.textContent;
    btn.textContent = '…';
    setProbeText(node, { tone: 'run', main: '测试中…' }, null);
    try {
      const r = await runProbe(built);
      setProbeText(node, describeProbe(r), r);
    } catch (err) {
      // runProbe 把所有异常都收成失败结果了;能走到这里说明是它自己出 bug。
      // 也必须显示出来 —— 否则按钮永远停在「测试中…」,用户只能重开面板。
      setProbeText(node, { tone: 'err', main: `❌ 测试本身出错:${err?.message || err}` }, null);
    } finally {
      btn.disabled = false;
      btn.textContent = prev || '测试';
    }
  }

  /** 座位测试:地址 + 该座位选的 Key + 该 Key 的协议 + 模型名 */
  async function testSeat(seat, btn) {
    let built;
    try {
      // 配置组装交给 app.js 的 agentCfg(见 createModelsPanel 的 testSpec 回调)——
      // 「座位该用哪个厂商/Key/模型」的规则只有那一份,这里绝不重算一遍
      built = opts.testSpec
        ? seatProbeSpec(opts.testSpec(testCfgSnapshot(), seat))
        : { error: '面板没有接到座位配置的组装函数(内部错误)' };
    } catch (err) {
      built = { error: `组装座位配置时出错:${err?.message || err}` };
    }
    await runTest(btn, built);
  }

  /** Key 测试:地址 + 协议 + 密钥(模型名用便宜的占位,见 shared/llmProbe.mjs) */
  async function testCustomKey(id, btn) {
    const row = [...wrap.querySelectorAll('#customKeyList .keyrow')]
      .find((r) => r.querySelector('[data-ckey]')?.dataset.ckey === id);
    await runTest(btn, keyProbeSpec({
      endpoint: q('customEndpoint')?.value || '',
      apiKey: row?.querySelector('[data-ckey]')?.value || '',
      protocol: row?.querySelector('[data-ckey-proto]')?.value,
    }));
  }

  function fill(cfg) {
    providers = cfg.providerList || providers;
    let customKeys = Array.isArray(cfg.customKeys) ? cfg.customKeys.filter((k) => k && k.key) : [];
    // 老配置没有 protocol 字段 → 补 'openai'(最常见形态)。
    // 不补的话下拉会显示空白,用户以为协议丢了。
    customKeys = customKeys.map((k) => ({ ...k, protocol: normalizeProtocol(k.protocol) }));
    // 一个 Key 都没有时先给一行空的,免得用户找不到入口
    if (!customKeys.length) customKeys = [{ id: 'k1', label: 'Key 1', key: '', protocol: 'openai' }];
    state = {
      defaultProvider: cfg.defaultProvider || 'deepseek',
      seatProviders: cfg.seatProviders || {},
      seatModels: cfg.seatModels || {},
      seatPersonas: cfg.seatPersonas || {},
      seatNames: state.seatNames || {},
      customEndpoint: cfg.customEndpoint || '',
      reasoningLevel: cfg.reasoningLevel || 'low',
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
    if (q('reasoningLevel')) q('reasoningLevel').value = state.reasoningLevel || 'low';
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
    state.customKeys = [...cur, { id, label: `Key ${n}`, key: '', protocol: 'openai' }];
    keepSeatEdits();
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
