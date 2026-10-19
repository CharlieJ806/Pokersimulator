# 桌游模拟器 · Tabletop Simulator

**桌上每个座位都是一个独立的大语言模型。** 它们互相看不到牌,会记人、会诈唬、会算赔率,
也会因为怕被淘汰而弃掉边缘牌。每一步的中文思考都直接显示在牌桌上。

两种玩法:

| 模式 | 你是 | 说明 |
| --- | --- | --- |
| **荷官模式** | 发牌的人 | 你发牌、控节奏、看牌。桌上 2~9 个 AI 互相博弈,想看清谁在想什么就停下来点「下一位」 |
| **玩家模式** | 上桌的人 | 你自己打。牌局进行中看不到别人的底牌和思考,这一手结束后可以回顾所有人当时在想什么 |

每个座位的人物立绘由**这个座位用的是哪个模型**决定(Claude 座位就是 Claude 娘,DeepSeek 座位就是 DeepSeek 娘……);
同一个模型被多个座位用到时,用不同色调和脚下的光圈区分。

桌面版(Electron)与浏览器版(手机横屏可玩)。

---

## 它和一般的扑克 AI 有什么不一样

- **真的互相看不到牌。** 每个 AI 的提示词里只有它自己的底牌和公开信息(谁下了多少、
  谁弃牌、摊牌亮过什么),没有任何人的底牌字段。这条有测试守着。
- **有记性。** 跨手记住桌上每个人怎么打,每 3 手整理一次「读人笔记」并累积下来 ——
  所以它会从「倾向不明,先按常规应对」慢慢变成「他一加注通常真有牌,别跟他硬碰」。
  笔记是它私有的,每个 AI 的读法会分歧,跟真人一样。
- **知道自己离出局多远。** 提示词里给出大盲数、全场筹码排名、自己是短码还是深码,
  以及「谁筹码厚是威胁、谁筹码浅是目标」。
- **怕不怕输因人而异。** 8 个角色各有自己的风险偏好。同样的短码处境,
  惜命的会弃掉边缘牌,敢赌的会直接全下。
- **诈唬是核心技能**,而且给了具体判断条件(对手示弱 / 干燥牌面 / 你在最后位 / 转河发出吓人的牌),
  不是空泛地说一句「可以诈唬」。

## 快速开始

**桌面版**

```bash
npm install
npm start
```

**浏览器版 / 手机**

```bash
npm run web:build
npm run web:serve        # 打开 http://127.0.0.1:5173
```

**部署到 Cloudflare(可选)**

```bash
npm run worker:build
npm run worker:deploy    # 前端 + LLM 转发层合成一个 Worker,同源、零配置
```

详见 [docs/DEPLOY-WEB.md](docs/DEPLOY-WEB.md)。

## 模型配置

在设置页选厂商、填 API Key 即可。**Key 只保存在你自己的配置文件(桌面版)或浏览器
localStorage(网页版),不会进仓库。** 每个座位可以单独指定模型 —— 比如让两个座位用便宜的
快模型、一个座位用贵的好模型。

支持的厂商:DeepSeek · OpenAI · Claude · Gemini · Kimi · 智谱 · 通义 · OpenRouter · Groq ·
本地 Ollama / LM Studio。

请求默认从主进程发(桌面版)或经同源 Worker 转发(网页版),所以 Key 不会出现在页面里,
也不受浏览器跨域限制。

## 牌局规则

- 标准 52 张 / **短牌 36 张**(三条 > 顺子、同花 > 葫芦;A-6-7-8-9 是最小顺子,A-2-3-4-5 不算)
- 2~9 人;无限注;**21 档升盲**(默认每 20 手升一档,周期在设置里可改;0 = 不按档位升盲);大盲前注可选
- 主池 / 边池自动分割;单挑;全下;严格的最小加注规则
- 筹码归零即出局,最后剩一个人赢下全场

## 项目结构

```
main.js                  Electron 主进程(窗口 + LLM 流式代理)
preload.js               contextBridge 暴露的最小接口
src/
  core/                  规则引擎:牌、牌型评估、下注轮次、边池、升盲
  ai/
    personas.js          8 种性格模板(含风险偏好)
    agent.js             独立 AI 代理:提示词、读人笔记、流式调用、本地兜底
  ui/                    主控制器、节奏控制、主页、下注条、回顾面板
  ui3d/                  3D 场景:牌桌、角色、牌与筹码、渲染循环、设置面板
web/                     浏览器版入口(HTML + 手机适配)
worker/                  Cloudflare Worker(静态资源 + /api/llm 转发)
vendor/three.module.js   three.js r169(MIT,单文件,离线)
```

## 已知限制

- 3D 是**程序化生成的卡通风格**,不是手工建模:角色由基础几何体拼成,**没有骨骼动画**。
- 软件渲染(无 GPU 的机器)帧率较低,功能都正常但画面会有点顿。
- 每次决策是一次独立的流式请求(DeepSeek 约 1~5 秒),9 人桌一手大约 20~60 秒。
  嫌慢可以把「行动前停顿」调到 0、切「自动」,或给部分座位换成更快的模型。
- 只在 2~9 人、无限注、无 straddle 的常规规则下测试过。

## 素材与许可

- **3D 引擎**:[three.js](https://github.com/mrdoob/three.js) r169(MIT),已内置在
  `vendor/three.module.js`,离线可用。
- **牌桌、牌面、筹码、房间**:全部**程序化生成**(基础几何体 + Canvas 贴图),
  无外部模型文件、无字体依赖。
- 配色参考 [nice-color-palettes](https://github.com/Jam3/nice-color-palettes)(MIT,只取色值)。
- **座位上的 2D 立绘**:取自开源项目 [CrossPet](https://github.com/lokicorvus/crosspet),
  许可是 **CC BY-NC-SA 4.0**(署名 — **非商业性使用** — 相同方式共享),
  **与代码的 MIT 不同、而且更严格**。

> ⚠️ **关于立绘的许可**:这 25 张立绘按 CC BY-NC-SA 4.0 发布,所以
> 1. 必须保留署名(见 [assets/portraits/SOURCES.md](assets/portraits/SOURCES.md));
> 2. **本项目的这类版本不得用于商业目的**;
> 3. 基于它做的衍生作品也要以 CC BY-NC-SA 4.0 发布。
>
> 座位显示哪套立绘由该座位使用的**模型**决定;认不出的模型用本项目自绘的通用占位立绘。
> 完整条款与逐作者署名见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 第 0 节。

- 调研过的第三方素材及其许可证核查结论见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 文档

| 文件 | 内容 |
| --- | --- |
| [docs/DEPLOY-WORKER.md](docs/DEPLOY-WORKER.md) | **完整的 Worker 部署指南**:从零到绑定自己的域名(含排错) |
| [docs/DEPLOY-WEB.md](docs/DEPLOY-WEB.md) | 浏览器版架构原理、配置项、移动端适配、常见问题 |
| [docs/FRONTEND-GUIDE.md](docs/FRONTEND-GUIDE.md) | 想改界面上的什么 → 去哪个文件、找哪个函数 |
| [docs/GAME-LOGIC-AUDIT.md](docs/GAME-LOGIC-AUDIT.md) | 游戏逻辑审查报告(历史快照,问题均已修复) |
