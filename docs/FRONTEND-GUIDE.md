# 前端修改指引

想改界面上的某个东西时,看这张表就能找到文件。
**没提到的文件基本都是逻辑/引擎代码,一般不需要动。**

> ⚠️ 改之前先知道一件事:这个项目的**所有中文注释都是 UTF-8**。
> 用 PowerShell 的 `Get-Content` / `Set-Content` 直接读写会把中文变成乱码(已经踩过一次,
> 不可恢复)。请用 VS Code / Notepad++ 之类的编辑器,或本工具的 read/write。

---

## 一、按「我想改什么」查

| 我想改… | 去哪个文件 | 找什么 |
|---|---|---|
| **配色 / 字体 / 圆角 / 阴影** | `src/ui/styles3d.css` | 顶部 `:root` 里的 CSS 变量 |
| 某个 UI 块的间距、大小、位置 | `src/ui/styles3d.css` | 搜对应的 class(见下面第三节) |
| **牌桌、桌布、房间、灯光** | `src/ui3d/scene.js` | `addRoom()` / `addLights()` / `PALETTE` |
| **相机视角**(高度、远近、俯角) | `src/ui3d/scene.js` | `createStage()` 里 `camera.position` / `lookAt` |
| **人物长相**(身体、头、胳膊、体型) | `src/ui3d/characters3d.js` | `createCharacter()` |
| **人物性格**(名字、说话风格、下注倾向) | `src/ai/personas.js` | `PERSONAS` 数组 |
| **椅子 / 座位圈大小 / 头顶指示器** | `src/ui3d/table3d.js` | `seatAnchors()` / `buildSeats()` / `_syncMarker()` |
| **牌面图案 / 牌背 / 筹码颜色** | `src/ui3d/cards3d.js` | `cardFaceTexture()` / `cardBackTexture()` / `CHIP_COLORS` |
| **牌和筹码的大小** | `src/ui3d/cards3d.js` | `CARD_SCALE`(牌)/ `CHIP_K`(筹码) |
| **发牌动画速度 / 弧线** | `src/ui3d/cards3d.js` | `flyCard()` 的 `dur` / `arc` |
| **结算动画**(筹码飞向赢家) | `src/ui3d/cards3d.js` + `table3d.js` | `flyChips()` / `_maybeSettleAnimation()` |
| **底池摆在桌上哪个位置** | `src/ui3d/table3d.js` | `buildSeats()` 里 `potGroup.position` |
| **顶栏有哪些按钮 / 叫什么** | `src/ui3d/sceneFull.js` | HTML 模板里的 `<header class="topbar">` |
| **手牌一览显示什么** | `src/ui3d/sceneFull.js` | `renderHandStrip()` / `renderBoardRow()` |
| **侧栏(牌局记录 / 思考记录)** | `src/ui3d/sceneFull.js` | HTML 模板里的 `<aside class="sidepanel">` |
| **玩家模式那三个按钮 / 常驻信息条** | `src/ui/playerbar.js` | `createPlayerBar()` 里的 HTML 模板 |
| **开局设置页**(滑杆、开关、厂商) | `src/ui3d/setup3d.js` | HTML 模板 |
| **主页**(模式选择卡片) | `src/ui/home.js` | `MODES` |
| **上一手回顾面板** | `src/ui/review.js` | `createReviewPanel()` |
| **AI 的提示词**(怎么想、怎么说话) | `src/ai/agent.js` | `buildSystemPrompt()` / `buildUserPrompt()` |
| **节奏**(停顿、气泡停留、连打) | `src/ui/flow.js` | `pauseBeforeAct()` / `pauseBetweenHands()` |
| **一手结束后要不要自动开下一手** | `src/ui/app.js` | 搜 `autoNextHand` |
| **桌子、牌、筹码的数据结构** | `src/core/engine.js` / `cards.js` | 不建议手改,有测试保护 |

---

## 二、文件职责一览

### 界面骨架

| 文件 | 职责 |
|---|---|
| `src/ui/index.html` | **桌面版**入口(CSP、样式表、启动脚本),19 行 |
| `web/index.html` | **浏览器版**入口(含 viewport meta,手机适配的关键) |
| `web/mobile.css` | 手机横屏 / 小屏适配(只在浏览器版加载) |
| `web/mobileLayout.js` | 手机上收起侧栏、把下注条对齐到手牌一览上沿 |
| `src/ui/boot.js` | 启动:建 `GameApp` 并 `init()` |

### 主控制器

| 文件 | 职责 |
|---|---|
| `src/ui/app.js` | **整个应用的大脑**(993 行)。游戏循环、发牌、AI 调度、渲染、玩家模式、回顾面板的串联都在这。改交互流程基本都在这里 |

### 3D 画面

| 文件 | 职责 |
|---|---|
| `src/ui3d/scene.js` | 渲染器 / 相机 / 灯光 / 房间 / 调色板 `PALETTE` |
| `src/ui3d/sceneFull.js` | **HUD 布局**(顶栏、侧栏、手牌一览的 DOM 结构)+ 渲染循环 + 手牌一览渲染 |
| `src/ui3d/table3d.js` | **3D 牌桌**:座位、椅子、人物摆放、头顶指示器、公共牌、底池、结算动画 |
| `src/ui3d/characters3d.js` | 程序化生成人物模型 |
| `src/ui3d/cards3d.js` | 牌的贴图与几何、筹码、**发牌动画**、**结算动画** |
| `src/ui3d/setup3d.js` | 开局设置抽屉 |
| `src/ui/styles3d.css` | **所有样式**(964 行) |

### 其余 UI

| 文件 | 职责 |
|---|---|
| `src/ui/home.js` | 主页模式选择 |
| `src/ui/playerbar.js` | 玩家模式的下注条 + 常驻信息条 |
| `src/ui/review.js` | 上一手回顾面板 |
| `src/ui/flow.js` | 节奏控制器(暂停、放行、连打) |
| `src/ui/models.js` | 给每个座位分配模型的界面 |

### 逻辑(一般不用动)

| 文件 | 职责 |
|---|---|
| `src/core/engine.js` | 扑克规则引擎(发牌、下注、边池、结算) |
| `src/core/cards.js` | 牌的数据结构与洗牌 |
| `src/core/handEval.js` | 牌型评估 |
| `src/ai/agent.js` | AI 代理(提示词、解析模型输出) |
| `src/ai/personas.js` | 8 个 AI 性格 |

---

## 三、CSS class 速查(`styles3d.css`)

改样式时搜这些 class:

| class | 是什么 |
|---|---|
| `.topbar` / `.topbar__left` / `.topbar__right` | 顶栏 |
| `.sidepanel` | 右侧栏(牌局记录 / 思考记录) |
| `.handstrip` / `.handstrip__head` / `.handstrip__body` / `.handrow` | 下方手牌一览 |
| `.actionbar` | 底部操作条(下一位 / 节奏 / 发牌) |
| `.pbar` / `.pbar__stats` / `.pbar__prompt` / `.pbar__acts` / `.pbar__raise` | 玩家模式的下注条 |
| `.pstat--chips` | 「我的筹码」那一项 |
| `.bubble` / `.bubble__text` / `.bubble--dots` | 思考气泡 |
| `.banner` | 摊牌 / 收池横幅 |
| `.setup` / `.setup__body` / `.field` | 设置抽屉 |
| `.modecard` / `.home__modes` | 主页模式卡片 |
| `.rvrow` / `.rvcard` / `.rvthink` | 回顾面板 |

**配色改这里**(文件顶部)。整体是明亮的画廊风格:暖白纸底 + 磨砂面板 + 墨色主按钮 + 黄铜点缀。

```css
:root {
  --bg: #f3eee6;          /* 页面底色 */
  --paper / --panel;      /* 实色卡片 / 磨砂面板 */
  --ink: #2a251f;         /* 主按钮、开关 */
  --gold: #9c7636;        /* 点缀色(标题、强调数字) */
  --line / --line-2;      /* 边框 */
  --text / --text-dim;    /* 正文 / 次要文字 */
}
```

3D 场景的配色在 `src/ui3d/scene.js` 的 `PALETTE`;**后墙挂画**的尺寸、高度、画框在同文件的 `PAINTING`。
换画:把新图放进 `assets/Background/`,跑 `node_modules/.bin/electron tools/prepdecor.mjs` 生成 `assets/decor/painting.jpg`(主页头图用的也是它)。

---

## 四、容易踩的坑

1. **不要用 PowerShell 读写这些文件** —— 中文会变乱码,不可恢复。
2. **`src/ui/index.html`(桌面)和 `web/index.html`(浏览器)是两个入口**,
   改标题/样式表要两个都看一眼。业务代码共用,只有 HTML 壳不同。
3. **CSP 禁止内联脚本**(`script-src 'self'`)—— 往 HTML 里加 `<script>` 内联代码会被浏览器拦掉,
   必须放外部 `.js` 文件。已经踩过两次。
4. **手上的 UI 位置是 JS 算的,不是纯 CSS**:
   - 下注条整组的位置靠 `--pbar-bottom`(`sceneFull.js` 的 `layoutPlayerBar()`);
     它有多高靠 `--pbar-stats-h` / `--pbar-prompt-h`(同处回写)。
   - 改这些块的高度后不用手调偏移,JS 每帧会重新量。
   - 但**改 CSS 里的 margin 会影响它们之间的堆叠关系**,改完看一眼截图。
5. **手机上不是简单的等比缩小** —— 有一套独立的 `web/mobile.css`,
   改完用真机或开发者工具的手机模拟看一下横屏占屏比。
6. **改完自己跑一遍**:`npm start` 打两手,确认改动没弄坏别的地方。
   (仓库里只保留了运行与发布用的脚本,开发期的测试脚本没有随仓库分发。)

---

## 五、想加一个新厂商 / 新模型?

改 `src/shared/providers.mjs`(唯一真源,前端 / Worker / 桌面端共用这一份)。
加完之后 **Worker 的转发白名单会自动包含它的域名**,不用另外配。
