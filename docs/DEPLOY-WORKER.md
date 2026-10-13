# Worker 部署完整指南(从零到自定义域名)

目标:把浏览器版部署到 Cloudflare Workers,并绑定你自己的域名 `pokedriver.me`。
全程**只需要一个 Worker**,它同时提供网页和模型转发 —— 同源、零配置。

> 已经有 `docs/DEPLOY-WEB.md` 讲架构与原理;这份是**照着做就行**的操作手册。
> 两条路径的关系:这份 = 部署流程,那份 = 为什么要这么设计 + 移动端适配 + 常见问题。

---

## 目录

- [零、先看清楚你要做的事](#零先看清楚你要做的事)
- [一、前置条件](#一前置条件)
- [二、登录 Cloudflare](#二登录-cloudflare)
- [三、构建](#三构建)
- [四、首次部署(先用 workers.dev 验证)](#四首次部署先用-workersdev-验证)
- [五、验证](#五验证)
- [六、绑定 pokedriver.me](#六绑定-pokedriverme)
- [七、以后怎么更新](#七以后怎么更新)
- [八、环境变量](#八环境变量)
- [九、排错](#九排错)
- [十、可选:推代码自动部署](#十可选推代码自动部署)

---

## 零、先看清楚你要做的事

```
pokedriver.me
   ├─ GET  /            → 静态页面(web/dist 里的 index.html + src/ + vendor/)
   └─ POST /api/llm     → 原样转发给 LLM 厂商,SSE 流式回传
```

**一个 Worker 干两件事**。前端代码里写死了「请求同源的 `/api/llm`」
(`web/pokerApi.js` 的 `resolveWorkerUrl()`),所以绑上域名之后**一行代码都不用改**。

API Key 不经过 Worker 落盘:浏览器把 Key 放在请求体里发给你的 Worker,Worker 转发给厂商,
**不存、不记、无 KV/D1/R2 绑定**。

---

## 一、前置条件

| 需要 | 怎么确认 |
|---|---|
| Node.js ≥ 18 | `node -v` |
| 已克隆仓库 | `git clone https://github.com/CharlieJ806/Pokersimulator.git` |
| Cloudflare 账号 | 免费账号即可,不需要付费计划 |
| `pokedriver.me` 已托管在 **同一个** Cloudflare 账号 | 见下面「域名前提」 |

### 域名前提(很重要,先检查)

要让 `pokedriver.me` 指向 Worker,这个域名必须**已经接入 Cloudflare**:

1. 登录 [dash.cloudflare.com](https://dash.cloudflare.com) → 左侧看有没有 `pokedriver.me`
2. 点进去,Overview 页顶部应显示 **Active**
3. 如果它不在列表里:先 **Add a site** → 输入 `pokedriver.me` → 选 Free 计划 →
   Cloudflare 会给你两个 NS(名称服务器)→ **去你的域名注册商把 NS 改成这两个** →
   等生效(通常几分钟到几小时,最长 24 小时)

> 如果域名 NS 不由 Cloudflare 接管,自定义域名会一直停在「等待」状态。

### ⚠️ 检查有没有冲突的 DNS 记录

如果 `pokedriver.me`(以及你打算用的子域,比如 `www`)**已经有一条 A / AAAA / CNAME 记录**
(例如原来指向某台服务器、或某个 Pages 项目),**先删掉那条记录**再绑 Worker,
否则会冲突。

在 Cloudflare 控制台 → 你的域名 → **DNS** → **Records** 里检查并删除。

---

## 二、登录 Cloudflare

在仓库根目录执行:

```bash
npx wrangler login
```

会打开浏览器让你授权(点 Allow)。授权一次就够了,凭据存在本机。

确认登录成功:

```bash
npx wrangler whoami
```

应该打印出你的账号邮箱与 Account ID。

> **不想用浏览器授权**(比如服务器上)?改成用 API Token:
> 1. Cloudflare 控制台 → 右上头像 → **My Profile** → **API Tokens** → **Create Token**
> 2. 用模板 **Edit Cloudflare Workers**,或自定义权限:
>    `Account → Workers Scripts → Edit` + `Zone → Workers Routes → Edit` + `Zone → DNS → Edit`
> 3. 然后设环境变量:
>    ```bash
>    # PowerShell
>    $env:CLOUDFLARE_API_TOKEN = "你的token"
>    # bash
>    export CLOUDFLARE_API_TOKEN="你的token"
>    ```

---

## 三、构建

**顺序不能反** —— `worker:build` 会校验前端产物在不在。

```bash
npm install          # 只需要一次(装 Electron,桌面版用;构建脚本本身只用 Node 内置模块)
npm run web:build    # 前端 → web/dist
npm run worker:build # Worker → worker/dist
```

`worker:build` 的输出应该是这样的,重点看这几行 `ok`:

```
构建 Cloudflare Worker → worker/dist
[1] shared/ 已复制 4 个文件
[2] 入口已改写 N 处 shared import
[3] wrangler.toml 已复制(assets 路径已按产物深度修正)
  ok  assets 目录有效 → web/dist (含 index.html)
[4] 校验
  ok  所有相对 import 都能解析到文件
  ok  没有 require / node: / process.env
  ok  入口会把非 API 请求交给 assets(静态站点 + 转发合体)
  ok  转发的路由是 /api/llm(与前端默认值一致)
  ok  显式设置了 text/event-stream(流式不会被缓冲)
  ok  转发白名单由共享厂商表推导(改厂商表会自动同步)

构建完成,无警告。
```

**如果出现 `!` 警告,先解决再部署** —— 尤其是:

| 警告 | 含义 |
|---|---|
| `assets 目录不存在` | 忘了跑 `npm run web:build`,或者顺序反了 |
| `assets 目录存在但没有 index.html` | `web:build` 没跑完 / 失败 |
| `入口里没有 /api/llm 路由` | Worker 源码被改坏了,前端会调不通 |
| `入口没有设置 text/event-stream` | 流式思考会变成「憋半天一次性蹦出来」 |

---

## 四、首次部署(先用 workers.dev 验证)

```bash
npm run worker:deploy
```

等价于:

```bash
cd worker/dist
npx wrangler deploy
```

首次会下载 wrangler(几十秒)。成功的话输出里有:

```
Uploaded poker-dealer (x.xx sec)
Deployed poker-dealer triggers (x.xx sec)
  https://poker-dealer.<你的账号子域>.workers.dev
```

**先记下这个地址** —— 它能用之后再绑域名。

> 这个时候**还没有**自定义域名,所以 `pokedriver.me` 暂时打不开,这是正常的。

---

## 五、验证

### 5.1 页面能开

浏览器打开 `https://poker-dealer.<你的账号子域>.workers.dev`,应该看到主页
(「扑克模拟器 · POKER SIMULATOR」+ 两张模式卡)。

命令行也能快速确认:

```bash
curl -I https://poker-dealer.<你的账号子域>.workers.dev
# 期望:HTTP/2 200,content-type: text/html
```

### 5.2 转发接口存在

```bash
curl -s -X POST https://poker-dealer.<你的账号子域>.workers.dev/api/llm \
  -H "Content-Type: application/json" \
  -d '{"url":"https://api.deepseek.com/chat/completions","headers":{},"body":{}}'
```

期望返回一段 **JSON 错误**(比如厂商报参数不对 / 401),**而不是 404**。
返回 404 说明路由没生效,回去看构建校验那几行。

### 5.3 真的能打一局

1. 页面选「荷官模式」→ 设置页
2. 选厂商、填 **API Key**(没填也能开局,但走的是本地策略,看不到模型思考)
3. 开始 → 观察 AI 是否**逐字**显示思考(逐字 = 流式正常;整段蹦出 = 见排错)
4. 打开 DevTools → Network,过滤 `llm`,确认状态 200 且响应是 `text/event-stream`

---

## 六、绑定 pokedriver.me

有两种方式,**任选一种,不要两个都做**。

### 方式 A:控制台点几下(推荐,最不容易出错)

1. Cloudflare 控制台 → **Workers & Pages** → 点进 `poker-dealer`
2. **Settings** → **Domains & Routes** → **Add** → **Custom Domain**
3. 填 `pokedriver.me` → **Add domain**
4. 等状态从「Initializing」变成 **Active**(通常几十秒;证书签发偶尔要几分钟)

想同时用 `www.pokedriver.me`,再加一条 Custom Domain 填 `www.pokedriver.me`。

> 如果提示域名已被占用 / 无法添加:多半是那条 DNS 记录还在(见
> [一、域名前提](#-检查有没有冲突的-dns-记录)),删掉再试。

### 方式 B:写进 wrangler.toml(可复制、适合以后自动化)

编辑 `worker/wrangler.toml`,把 `routes` 加到文件**顶部**(`name`/`main` 那一块附近):

```toml
# 自定义域名:确认 pokedriver.me 已在同一个 Cloudflare 账号下、且没有冲突的 DNS 记录
routes = [
  { pattern = "pokedriver.me", custom_domain = true }
]
# 想连 www 一起绑就再加一行:
# { pattern = "www.pokedriver.me", custom_domain = true }
```

然后重新构建 + 部署(改了 `wrangler.toml` 必须重新 build,因为它会被复制进产物):

```bash
npm run worker:build && npm run worker:deploy
```

> ⚠️ **如果域名还没接入 Cloudflare,这一步会让 `wrangler deploy` 直接报错失败。**
> 所以建议:第一次部署**先用方式 A** 拿到能跑的环境,确认域名前提都满足之后,
> 再决定要不要写进配置文件。

### 6.3 验证域名生效

```bash
curl -I https://pokedriver.me
# 期望:HTTP/2 200 + content-type: text/html
```

然后手机浏览器打开 `https://pokedriver.me`,**横屏**,开局打两手。

**不需要改任何代码** —— 前端默认请求同源的 `/api/llm`,绑上域名之后自动就走
`https://pokedriver.me/api/llm` 了。

---

## 七、以后怎么更新

改了代码(或拉了新版本)之后:

```bash
git pull
npm run web:build && npm run worker:build && npm run worker:deploy
```

三条命令连起来。**前端和 Worker 要一起重新构建** —— 因为 Worker 的静态资源就是
`web/dist`,只部署 Worker 不重建前端的话,页面还是旧的。

只改了 `worker/wrangler.toml`(比如加环境变量)也一样:`worker:build` → `worker:deploy`。

### 本地先预览再上线

```bash
# 终端 1
npm run web:build && npm run worker:build
npm run worker:dev        # 默认 http://127.0.0.1:8787
```

`wrangler dev` 同时提供静态页面和 `/api/llm`,是完全等价的本地环境。
先在这里确认没问题再 deploy。

> 另一个更轻的预览方式(只测前端静态资源):
> `npm run web:build && npm run web:serve` → `http://127.0.0.1:5173`。
> 但这种方式**没有 `/api/llm`**,模型会调不通,只适合看界面。

---

## 八、环境变量

都在 `worker/wrangler.toml` 里改,改完必须重新 build + deploy。

### `ALLOWED_ORIGINS`

**同源部署(本指南的做法)留空就行。**

| 值 | 行为 |
|---|---|
| 空(默认) | 返回 `Access-Control-Allow-Origin: *` |
| `https://a.com,https://b.com` | 只允许列表里的来源;不在列表里的会拿到列表第一项 |

绑了 `pokedriver.me` 之后其实是同源请求,浏览器根本不检查 CORS,所以留空没问题。

> **想收紧一点**:既然只有你自己的域名会用,可以填上自己:
> ```toml
> ALLOWED_ORIGINS = "https://pokedriver.me"
> ```
> 这样别人就算知道了你的 Worker 地址,从他的网页上也调不动。
> (不过要记住:API Key 是你自己在浏览器里填的,存在 localStorage,
> 别人拿到你的 Worker 地址也没有你的 Key。)

### `EXTRA_ALLOWED_HOSTS`

**只有用「自建中转站」或自定义厂商时才需要填。** 内置的云端厂商域名
(DeepSeek / OpenAI / Claude / Gemini / Kimi / 智谱 / 通义 / OpenRouter / Groq)
是从 `src/shared/providers.mjs` 自动推导的 —— 加厂商会自动同步,不用手工维护。

```toml
EXTRA_ALLOWED_HOSTS = "api.my-proxy.com,llm.internal.corp"
```

不在白名单里的域名会被拒绝(报「目标域名不在白名单里」),这是防止 Worker 被当成
开放代理。

---

## 九、排错

### 域名相关

**`pokedriver.me` 打不开 / 一直转圈**

按顺序查:

1. `npx wrangler whoami` 确认登录的是对的账号
2. 控制台 → 你的域名 → Overview 顶部是不是 **Active**(NS 没生效就绑不上)
3. 控制台 → Workers → `poker-dealer` → Settings → Domains & Routes,
   自定义域名状态是不是 **Active**;卡在 Initializing 就等几分钟
4. `curl -I https://pokedriver.me` 看具体返回码:
   - `522` / 连接超时 → DNS 记录指向不对
   - `404` → 域名绑到了别的 Worker/Pages,或者静态资源没上传
   - 证书错误 → 证书还在签发,等几分钟

**提示域名已被其它项目占用**

那条 DNS 记录还在。控制台 → 域名 → DNS → Records,删掉 `pokedriver.me` 的
A/AAAA/CNAME,然后再添加 Custom Domain。

**部署时报 `custom_domain` 相关错误**

你的 `wrangler.toml` 里写了 `routes` 但域名前提没满足(不在同一账号 / NS 未生效)。
先把 `routes` 注释掉,用控制台方式绑。

### 构建 / 部署相关

**`assets directory not found`**

先跑 `npm run web:build`。顺序是 `web:build` → `worker:build` → `worker:deploy`。

**`npm run worker:deploy` 在 Windows 上报 `&&` 相关错误**

脚本内容是 `cd worker/dist && npx wrangler deploy`,npm 默认用 `cmd.exe` 执行所以没问题。
如果你改了 shell 配置导致它走 PowerShell 5,手动执行等价命令:

```powershell
cd worker\dist
npx wrangler deploy
```

**部署成功但页面是旧的**

只跑了 `worker:deploy`,没重新 `web:build`。静态资源就是 `web/dist`,必须一起重建。

### 页面 / 模型相关

**打开是空白页,控制台报 CSP 错误**

内联 `<script>` 被 CSP(`script-src 'self'`)拦了。启动脚本必须在外部文件里
(`web/main.js`),不要往 `index.html` 里塞内联脚本。

**思考气泡不逐字出现,等半天一次性蹦出来**

转发层没设 `text/event-stream`。当前 `worker/src/index.js` 已显式设置并禁用缓冲;
如果你改过它,注意别把这两个响应头删掉。

**报「目标域名不在白名单里」**

你要连的厂商不在内置表里。把域名加进 `EXTRA_ALLOWED_HOSTS`,重新 build + deploy。

**填了 Key 还说 401 / 403**

- `401` → Key 不对或已过期(去厂商控制台确认)
- `403` → 看 Worker 实时日志:`npx wrangler tail`

---

## 十、可选:推代码自动部署

想做到「推到 GitHub 就自动上线」,用 GitHub Actions。

### 10.1 准备三个 Secret

GitHub 仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Secret | 从哪来 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 见 [二、登录 Cloudflare](#二登录-cloudflare) 里创建 Token 的步骤 |
| `CLOUDFLARE_ACCOUNT_ID` | `npx wrangler whoami` 输出里的 Account ID |

> 用了 `routes`(方式 B 绑域名)的话,Token 还需要
> `Zone → Workers Routes → Edit` 和 `Zone → DNS → Edit` 权限。

### 10.2 加工作流文件

新建 `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Cloudflare Workers

on:
  push:
    branches: [main]
  workflow_dispatch:      # 也允许在 Actions 页面手动点一次

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      # 构建脚本只用 Node 内置模块,所以不需要 npm ci(能省掉下载 Electron 的几十秒)
      - name: Build
        run: npm run web:build && npm run worker:build

      - name: Deploy
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: worker/dist
          command: deploy
```

推上去之后,Actions 页面能看到构建日志,失败会直接报在哪一步。

---

## 附:一次性命令速查

```bash
# 首次
npx wrangler login
npm install
npm run web:build && npm run worker:build
npm run worker:deploy
# → 拿到 https://poker-dealer.<子域>.workers.dev,验证 OK
# → 控制台 Add Custom Domain: pokedriver.me

# 以后更新
git pull
npm run web:build && npm run worker:build && npm run worker:deploy

# 本地预览(等价环境)
npm run web:build && npm run worker:build && npm run worker:dev

# 看实时日志 / 排查
npx wrangler tail
npx wrangler whoami
```
