# 浏览器版部署(Cloudflare)

桌面版(Electron)之外的第二种用法:**部署到 Cloudflare,手机浏览器直接打开**。
同一套牌局逻辑、同一个 3D 场景,只是把 Electron 外壳换成了浏览器 + 一个转发 Worker。

---

## 一、架构

```
浏览器(手机/电脑)
   │  静态页面:index.html / src/ / vendor/three.module.js
   │  模型请求:POST /api/llm  {url, headers, body}
   ▼
Cloudflare Worker(单文件,同时干两件事)
   ├─ 非 /api/llm  → 交给静态资源(Workers assets)
   └─ POST /api/llm → 原样转发给厂商,SSE 流式回传
   ▼
各家 LLM API(DeepSeek / Groq / OpenRouter / …)
```

**为什么必须有 Worker**:浏览器的同源策略不允许前端直接调各家 LLM API
(实测 Groq、DeepSeek 都会拦),必须有一层允许跨域的转发。

**为什么合成一个 Worker**:分开部署会有两个麻烦 —— 跨域、以及前端得知道
Worker 的地址(多一个要填的配置)。合成之后同源、零配置、一次 deploy 搞定。

---

## 二、部署(3 步)

> 📖 **想看照做就行的完整步骤(含绑定自己的域名、排错、自动部署)**,
> 见 **[DEPLOY-WORKER.md](DEPLOY-WORKER.md)**。
> 下面是最短的路径。

```bash
# 1. 构建前端 → web/dist
npm run web:build

# 2. 构建 Worker → worker/dist(会自动校验 assets 路径)
npm run worker:build

# 3. 部署
npm run worker:deploy        # 等价于 cd worker/dist && npx wrangler deploy
```

首次部署 `wrangler` 会要求登录 Cloudflare 账号(浏览器授权一次即可)。

部署完成后你会拿到一个地址,形如 `https://poker-dealer.<你的子域>.workers.dev`。
手机浏览器打开它就能玩。

> **想绑自己的域名**:在 Cloudflare 控制台给这个 Worker 加一条 Custom Domain 即可,
> 不需要改任何代码(前端默认请求同源的 `/api/llm`)。

---

## 三、本地预览(部署前先看看)

需要两个终端 —— 前端静态服务器 + Worker 的本地运行时:

```bash
# 终端 1:前端
npm run web:build
npm run web:serve            # http://127.0.0.1:5173

# 终端 2:Worker(需要 npx,会下载 wrangler)
npm run worker:build
npm run worker:dev           # 默认 http://127.0.0.1:8787
```

`wrangler dev` 起来后,直接访问它给的地址(它同时提供静态页面和 `/api/llm`)。

> ⚠️ 不要用 `file://` 直接双击 `index.html` —— ES 模块在 `file://` 下会被
> CORS 拦掉,必须经 http 服务器。

---

## 四、配置

### 4.1 API Key(必填才能用真实模型)

打开网页 → 首页选模式 → 牌局设置页 → 填 **API Key**。

Key 的存放(这是刻意的设计):

| | |
|---|---|
| 存在哪里 | **你自己的浏览器 localStorage**(`poker-dealer/config/v1`) |
| 发给谁 | 只发给你自己部署的 Worker,由它转发给厂商 |
| Worker 存不存 | **不存**。不落盘、不记录、无 KV/D1/R2 绑定 |
| 换设备 | 要重新填(因为没存在服务端) |
| 公用电脑 | 建议别勾保存;同源页面理论上能读到 localStorage |

**不填 Key 也能玩** —— 每个角色都有内置的本地策略兜底,只是不会有大模型那种思考文本。

### 4.2 Worker 环境变量(可选)

在 `worker/wrangler.toml` 或 Cloudflare 控制台里改:

| 变量 | 默认 | 说明 |
|---|---|---|
| `ALLOWED_ORIGINS` | 空(不限) | 允许哪些站点跨域调用。同源部署用不到;前端放别的域名才需要填 |
| `EXTRA_ALLOWED_HOSTS` | 空 | 额外允许转发的域名。内置的 7 个云端厂商自动允许;用**自建中转站**时填这里 |

改完要重新 `npm run worker:deploy`。

### 4.3 本地模型(Ollama / LM Studio)

浏览器版**不走 Worker 转发本地地址** —— 从公网 Worker 转发到 `127.0.0.1`
指向的是 Worker 自己的回环,没有意义。要连本机模型,得让浏览器直连,
并给模型服务开跨域:

```bash
# Ollama:允许来自任意来源(或写具体域名)
OLLAMA_ORIGINS=* ollama serve

# LM Studio:在 Server 设置里勾选 "Enable CORS"
```

---

## 五、手机上怎么样

已针对**手机横屏**做了适配,实测数据(iPhone 15 Pro 横屏 852×393):

| | 适配前 | 适配后 |
|---|---|---|
| 3D 牌桌可视高度 | **21px(5%)** | **~200px(50%)** |
| 顶栏 | 85px,文字被挤成**竖排** | 44px 一行放下 |
| 侧栏 | 占 260px(右半屏) | 默认收起(点「牌局记录」展开) |
| 下注按钮 | 浮到顶栏上、与牌面重叠 | 贴在手牌一览上沿,84×44 可点 |

做法:

- **加 viewport meta** —— 之前没有,手机按 980px 虚拟视口渲染再缩小,
  导致所有按钮小到点不准(实测 21 个按钮里 13 个高度 < 44px)
- **侧栏默认收起** —— 它是挤压牌桌的主因,而只有看记录时才需要
- **顶栏压缩 + 横向滚动** —— 顶栏按钮总宽超屏,不处理会竖排
  (按钮数从六个减到五个:「💭 气泡 开/关」已删,手机上少占约 46px —— 见下)
- **下注条动态对齐** —— 手牌一览高度是变化的,写死位置必然对不上,
  所以用 `ResizeObserver` 跟着量(见 `web/mobileLayout.js`)
- **触控目标兜底 40~44px**

**已知不足**:手机竖屏下 3D 牌桌仍偏小(屏幕太窄),建议横屏使用。
另外 3D 相机是按桌面视野调的,手机上牌桌下沿的玩家会被手牌一览挡住一部分。

**顶栏横向溢出仍然是「已知不足」**:删掉「💭 气泡」按钮后少占约 46px
(手机横屏 852×393 实测:按钮 41.97px + 按钮间距 4px;竖屏 412×915 是 49px,
因为那边的 `gap` 是 7px)。把左侧文案拉到最长(开了升盲 + 大盲前注)时,
852×393 的顶栏内容宽从溢出 87px 降到溢出 41px —— **有帮助,但没根治**。
复量:`node tools/topbarwidth.mjs`(用 Chrome headless,不开 Electron 窗口);
顶栏完整体检仍是 `node_modules/.bin/electron tools/topbarmeasure.mjs`。

---

## 六、常见问题

**打开是空白页 / 控制台报 CSP 错误**
内联 `<script>` 被 CSP(`script-src 'self'`)拦了。启动脚本必须在外部文件里
(`web/main.js`),不要往 `index.html` 里塞内联脚本。

**报错 "目标域名不在白名单里"**
你要连的厂商不在内置表里。把域名加到 Worker 的 `EXTRA_ALLOWED_HOSTS`。

**思考气泡不逐字出现,而是等半天一次性蹦出来**
转发层没设置 `text/event-stream`。当前 `worker/src/index.js` 已显式设置并禁用缓冲;
如果你自己改过,注意别把这两个响应头删掉。

**部署报 "assets directory not found"**
先跑 `npm run web:build`。构建脚本会校验这个路径并给出提示。

**手机上按钮还是很小**
确认 `web/index.html` 里的 viewport meta 没被删掉 —— 删了之后
浏览器会按 980px 虚拟视口渲染,所有东西都会缩小。

---

## 七、相关文件

| 路径 | 作用 |
|---|---|
| `web/index.html` | 浏览器版入口(含 viewport meta 与 CSP) |
| `web/main.js` | 启动脚本(必须先装 pokerAPI 再启动应用) |
| `web/pokerApi.js` | `window.pokerAPI` 的浏览器实现(对齐 Electron preload 的接口) |
| `web/mobile.css` | 移动端布局 |
| `web/mobileLayout.js` | 手机上收起侧栏、动态对齐下注条 |
| `worker/src/index.js` | Worker:静态资源 + LLM 转发 |
| `worker/wrangler.toml` | Cloudflare 配置 |
| `src/shared/providers.mjs` | 厂商表(**唯一真源**,前端/Worker/桌面端共用) |
| `src/shared/llmStream.mjs` | 请求构造 + SSE 解析(**唯一真源**) |
| `tools/buildweb.mjs` | 构建前端(复制 + 校验路径) |
| `tools/buildworker.mjs` | 构建 Worker(复制共享模块 + 校验) |
| `tools/webserve.mjs` | 本地静态服务器(仅开发用) |

---

## 八、验证

```bash
npm run web:build && npm run worker:build
npm run web:serve         # 另开一个终端,浏览器打开 http://127.0.0.1:5173
```

在页面上走一遍:选模式 → 填 Key → 开局 → 看 AI 是否正常出牌与显示思考。
部署之后把地址发到手机上,确认横屏能正常操作。

> 如果模型这条链路有问题,先看浏览器的 Network 面板里 `/api/llm` 的返回 ——
> 最常见的两种是 **Key 没填**(401)和 **Worker 没配 ALLOWED_ORIGINS**(403)。
