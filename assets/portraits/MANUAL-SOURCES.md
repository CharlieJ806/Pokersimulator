# 手工加入的立绘 —— 来源与授权

本文件对应的素材由**项目使用者自行提供**,与 `SOURCES.md` 里那批(crosspet,
CC BY-NC-SA 4.0)**不是同一个来源**,授权状态需要使用者自行确认。

> ⚠️ 这里不做任何授权声明。如果要公开分发或商用,请先确认每个角色的原作者与许可。

## 取用清单

| 角色 | 本地文件 | 原始文件 | 尺寸(裁切后) |
| --- | --- | --- | --- |
| Grok | `assets/portraits/grok/idle.webp` | `fbc7df732a46f48f3851212183e60619.jpg` | 609×606 |
| Kimi | `assets/portraits/kimi/idle.webp` | `0a9867af-cbac-4fef-8143-e957160d53de.png` | 387×668 |
| MiMo | `assets/portraits/mimo/idle.webp` | `e3c79e60-e3e2-4fa9-87f7-a4dd803eda60.png` | 258×415 |
| Qwen | `assets/portraits/qwen/idle.webp` | `69eff6768c11ef68f179d9ac3f9101f3.jpg` | 693×760 |

## 处理方式

原图是**白底 JPG(无透明通道)**。若直接使用,牌桌上会出现白色方块;
而简单地「把白色像素抠掉」也不行 —— Qwen 的裙子本身是白的,一刀切会在衣服上开洞。
所以用**从画面四边 flood fill** 的方式:只有与边界连通的白才被当作背景。
照片随即裁掉四周全透明的边、导出 WebP(与 crosspet 那批格式一致)。

处理脚本:`tools/prepmanualportraits.mjs`(跑在 Electron 里,零依赖)。
每个角色只有一张图,所以**所有状态都复用这一张**;
缺状态时的回退逻辑见 `src/ui3d/portraits2d.js` 的 `stateMeta()`。
