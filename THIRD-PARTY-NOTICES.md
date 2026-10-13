# 第三方素材与许可声明

本项目的界面素材分两部分:**程序自绘**(无第三方权利)和**预生成的开源头像**。

---

## 1. 角色头像 —— DiceBear(CC0 1.0 设计 / MIT 代码)

8 个 AI 牌手的头像由 [DiceBear](https://github.com/dicebear/dicebear) 的 `notionists` 画风生成,
生成结果已固化为自包含 SVG 存放在 `assets/avatars/`(无外链、无字体依赖),运行时完全离线。
生成脚本:`tools/genavatars.mjs`。

**画风许可(CC0 1.0,公有领域)**

```
Source: Notionists (https://heyzoish.gumroad.com/l/notionists)
Designer: Zoish
License: CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/)
```

**代码许可(MIT)**

```
MIT License
Copyright (c) DiceBear
https://github.com/dicebear/dicebear
```

CC0 素材**不需要署名**;这里列出仅为追溯来源与保留 MIT 声明。

如需重新生成或换成别的画风,注意 DiceBear 是「代码 MIT + 逐画风各自许可」:
- **CC0(零署名义务)**:`open-peeps`、`notionists`、`pixel-art`、`pixel-art-neutral`、`lorelei`、`thumbs`、`shapes`、`glass`、`identicon`
- **CC BY 4.0(需署名)**:`personas`、`adventurer`、`micah`、`big-smile`、`miniavs`、`croodles`、`fun-emoji`、`dylan`、`big-ears`、`big-ears-neutral`、`adventurer-neutral`
- **非标准表述**:`avataaars`、`bottts`、`bottts-neutral`(标注 "Free for personal and commercial use")

---

## 2. 其余界面元素 —— 全部程序自绘

| 元素 | 实现方式 | 第三方权利 |
| --- | --- | --- |
| 52 / 36 张牌面 | `src/ui/cards.js` + `styles.css`,DOM + CSS 绘制(点数、花色、pip 排布、人头牌) | 无 |
| 牌背 | CSS 渐变 + 重复线性渐变纹理 | 无 |
| 筹码 | CSS `radial-gradient` + `border-style: dashed`,按面值配色 | 无 |
| 毡布 / 牌桌 / 灯光 | CSS 径向渐变 + 重复纹理 | 无 |
| 图标(顶栏、日志) | Unicode 字符与 emoji | 见下 |

**emoji 字形**由操作系统提供(Windows 上是 Segoe UI Emoji),不属于本项目分发的素材。

---

## 3. 关于「去 GitHub 找现成素材」的调研结论

动手前调研过开源牌面、图标、头像、毡布等素材,核查了许可证。记录在此,方便你以后想替换成图片素材时参考。

### 卡牌美术(最终未使用,改为自绘)

| 仓库 | 许可(已核实) | 结论 |
| --- | --- | --- |
| [notpeter/Vector-Playing-Cards](https://github.com/notpeter/Vector-Playing-Cards) | 公有领域 / WTFPL(README 声明,原作 Byron Knoll) | 许可最宽松、单文件 SVG、命名 `AS.svg` 便于拼接;但**无牌背**、人头牌 SVG 约 1MB、点数用 `<text>` 依赖系统字体 |
| [hayeah/playing-cards-assets](https://github.com/hayeah/playing-cards-assets) | MIT(`Copyright (c) 2018 Howard Yeh`) | 与上一份同源(文件 sha 相同),另有 PNG 与 `svg-cards/simple/` 简化人头牌(约 12KB);命名是全称式 `ace_of_spades.svg`;牌背只有 PNG |
| [MattCain/svg-playing-cards](https://github.com/MattCain/svg-playing-cards) | MIT(`Copyright (c) 2015 Matt Cain`) | 纯 SVG,**牌背 `imgs/back.svg` 仅 3.9KB**,适合做矢量牌背 |
| [richardschneider/cardsJS](https://github.com/richardschneider/cardsJS) | 代码 MIT,**卡面 LGPL-3.0**(Chris Aguilar) | 唯一自带牌背与纯 path 自包含卡面;代价是必须履行 LGPL-3.0 义务 |
| NCX-Programming/open-playing-cards | 无 LICENSE 文件 | **不可用**:只有字母没有花色,且无正式授权条款 |

⚠️ 实测坑:`raw.githubusercontent.com` 与 `cdn.jsdelivr.net/gh/` 都可用,但 **jsDelivr 会对部分 PNG 再编码**
(同一个 `back@2x.png`,raw 是 17,515 B,jsDelivr 返回 63,058 B)。要原图请走 raw。

### 图标库(未使用,顶栏用 emoji 代替)

| 仓库 | 许可 | 备注 |
| --- | --- | --- |
| [tabler/tabler-icons](https://github.com/tabler/tabler-icons) | MIT(`Copyright (c) 2020-2026 Paweł Kuna`) | 有真正的 `poker-chip.svg`(692 B),`currentColor` 可直接染色;`filled/poker-chip.svg` 不存在 |
| [Templarian/MaterialDesign](https://github.com/Templarian/MaterialDesign) | Apache-2.0(图标)/ MIT(代码) | `svg/poker-chip.svg` 752 B;无 `coin.svg` |
| game-icons/icons | README 只写 `CC-BY`,**无 LICENSE 文件、无版本号**,需逐作者署名 | 许可明确度不足,未采用 |
| hfg-gmuend/openmoji | CC BY-SA 4.0(**有传染性**) | 闭源分发有合规摩擦,未采用 |
| Font Awesome Free | 图标 CC BY 4.0(**需署名**) | 且没有 `spade` / `card-club`,未采用 |

### 毡布质感(未使用,改为 CSS 渐变 + 重复纹理)

- [ambientCG Fabric034](https://ambientcg.com/a/Fabric034):**CC0 1.0**,1K JPG 包实测可下载(8.2MB)。许可原文明确允许「include the raw files in your project, for example a video game」,无需署名。
- 本项目没用它,是因为纯 CSS 的径向渐变 + 细纹理已经够用,且体积为 0。

### 没有找到可靠素材的部分

- **深色赌场牌房场景插画 / 环境光效**:GitHub 上的 casino 主题仓库绝大多数没有 LICENSE 文件;`nidorx/matcaps` 自述素材「来自各网站、无法追溯原作者」,权利链不清。→ 改用纯 CSS 光源与渐变。
- **「牌手性格 + 立绘」成套素材**:不存在。→ 用 DiceBear 按 `seed` 生成 8 个统一风格的头像。
- **彩色筹码叠放素材**:没有许可可靠的现成件。→ 单色筹码用 CSS 画,面值配色程序化生成。
