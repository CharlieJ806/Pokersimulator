/**
 * 道具层契约 —— 「新游戏怎么往桌上摆自己的东西」。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么要有这一层
 *
 * 一期只有扑克的时候,3D 场景是「房间 + 桌子 + 座位 + 牌 + 筹码」长在一起的一大坨。
 * 想加第二个桌游,要么整份复制,要么把扑克删掉 —— 两条路都很贵。
 *
 * 所以拆成两半:
 *   · `sceneCore/`  —— 房间、桌椅、座位、立绘、相机、气泡。**通用**,
 *     不许出现扑克那套英文词(词表写在 tools/refactortest.mjs 里 ——
 *     这里**不重复列**,否则这条规则会命中它自己),
 *     也不许 import `props/`(同样有两条断言盯着)。
 *   · `props/<游戏>/` —— 那个游戏摆在桌上的东西(牌面、筹码、公共牌区、底池…)。
 *
 * 两边只有一个接口:`Table3D#addPropLayer(layer)`。
 *
 * ────────────────────────────────────────────────────────────
 * 新游戏加道具的完整步骤(照抄这五步)
 *
 *   1. 建 `src/ui3d/props/<游戏>/` 目录,写一个道具层对象(见下面的 GamePropLayer);
 *   2. 在道具层里 import `three` 和**自己目录**里的模型文件,
 *      几何/贴图都放这儿 —— 不要回头改 sceneCore 里的桌子(那是通用资产);
 *   3. 由游戏的 `mount(root, ctx)` 里调用 `scene.table.addPropLayer(new YourProps())`
 *      (扑克就是这么做的,见 src/games/poker/ui/screen.js);
 *   4. 每帧/每次状态变化时,sceneCore 会调你的 `sync(view, ctx, host)`,
 *      按引擎给的 view 摆放道具就行 —— 你不碰座位、不碰相机、不碰 DOM;
 *   5. 跑 `node tools/refactortest.mjs`(它会扫 sceneCore 的用词与 import)
 *      和 `node tools/registrytest.mjs`(契约)。
 *
 * ⚠️ 三条纪律(踩过才知道为什么):
 *   · **道具层不许改座位/桌椅**:那是 sceneCore 的地盘。要新的通用能力,
 *     改 sceneCore 并在 host 上暴露(而不是从 host 偷 THREE 对象自己动手);
 *   · **position 一律用 host.feltPoint(angle, inset)**:它是「毡布上正对某个座位、
 *     离边缘 inset 的那一点」。按「座位坐标 × 比例」摆的老写法,座位一外扩
 *     道具就跑到桌子外面去了(9 人桌时底牌落在地毯上,用户反馈过);
 *   · **重建时要自己清干净**:sceneCore 只在 buildSeats 时清它自己的东西,
 *     你的道具留在 root 上就会在换人数之后变成鬼影。
 */

/** 道具层可以实现的全部方法(全部可选,只实现用得到的)。 */
export const PROP_METHODS = ['build', 'sync', 'layout', 'animate', 'stop', 'animAlive', 'destroy', 'setLastResult', '__settleInfo'];

/**
 * @typedef {object} GamePropLayer
 * @property {string} id                              唯一标识(例如 'poker')
 * @property {(host:object)=>void} [build]            座位重建后调用:建自己的 mesh / 清掉旧的
 * @property {(view:object, ctx:object, host:object)=>void} [sync]  按局面摆放道具
 * @property {(host:object)=>void} [layout]           视口 / 人数变了
 * @property {(now:number)=>void} [animate]           自己的动画推进(不实现就不动)
 * @property {()=>void} [stop]                        立刻停掉动画(退出本局 / 重开)
 * @property {()=>number} [animAlive]                 还有没有动画在跑(测试等「动画真的结束」用)
 * @property {()=>void} [destroy]                     彻底拆掉
 * @property {(result:object)=>void} [setLastResult]  引擎的结算数据(扑克:主池/边池)
 * @property {()=>object|null} [__settleInfo]         最近一次结算动画的信息(测试用)
 */

/**
 * 检查一个道具层是否像样,返回**问题清单**(空数组 = 合格)。
 *
 * 为什么要有它:`addPropLayer` 是运行时唯一的接入点,一旦传错东西
 * (忘了 id、sync 写成属性而不是函数),表现是「道具就是不出现」——
 * 一句错误都没有,只能靠猜。所以这里在**挂载时**就把它说出来。
 * @param {object} layer
 * @returns {string[]}
 */
export function checkPropLayer(layer) {
  const out = [];
  if (!layer || typeof layer !== 'object') return ['道具层不是一个对象'];
  if (typeof layer.id !== 'string' || !layer.id) out.push('缺少 id(道具层的唯一标识,例如 "poker")');
  for (const k of PROP_METHODS) {
    if (layer[k] !== undefined && typeof layer[k] !== 'function') {
      out.push(`${k} 要么是函数、要么不写(收到 ${typeof layer[k]})`);
    }
  }
  if (typeof layer.sync !== 'function' && typeof layer.build !== 'function') {
    out.push('build 和 sync 至少要有一个,否则这一层什么都不会发生');
  }
  return out;
}

/**
 * 道具层「该摆在哪」—— 所有道具都要用的那两个数。
 *
 * 单独抽出来是为了让「中央区域随桌子变窄而内收」这件事只有一份算法:
 * 竖屏时桌子会收窄,底池/烧牌堆如果还按固定坐标摆,就会落到桌子外面。
 * @param {object} host
 * @returns {{feltA:number, feltB:number}}
 */
export function feltSize(host) {
  const a = host?.feltAxes?.() || {};
  return { feltA: a.a || 0, feltB: a.b || 0 };
}
