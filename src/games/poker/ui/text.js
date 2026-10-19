/**
 * 扑克专用的界面文案与「一手结束时那张横幅」的组装。
 *
 * 为什么这几行要单独搬出平台壳(src/ui/app.js):
 *   棚子里的话 —— 「翻牌前 / 翻牌 / 转牌 / 河牌」、「加注到 520」、「摊牌:
 *   谁赢了多少钱」—— 全是扑克的词。平台壳现在要能同时养第二个游戏
 *   (狼人杀/谁是卧底),这些话不该长在它身上:加一个游戏就要回去改壳里
 *   的 if/else,迟早和游戏自己说的不是一套。
 *
 * ⚠️ 这里只产出**文案**,不碰 DOM:横幅怎么飘、多久消失、飞行动画什么时候收尾
 *    都还在壳里(那是「一手结束」这个流程的事,与具体游戏无关)。
 */

import { fmt } from '../../../shared/format.mjs';

/** 街道名 → 中文(顶栏显示用) */
export const STREET_TEXT = {
  idle: '等待开局', preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌',
};

/** 把动作译成中文(思考记录 / 动作气泡里显示用) */
export function actionLabel(a, amount) {
  const t = { fold: '弃牌', check: '看牌', call: '跟注', raise: '加注', allin: '全下' }[a] || a || '—';
  if (a === 'raise' && amount) return `加注到 ${amount}`;
  return t;
}

/**
 * 一手结束时的横幅文案。
 *
 * @param {object} result 引擎的 lastResult
 * @param {(seat:number)=>string} seatName 座位名(由壳交进来 —— 名字的规则在壳里:
 *   「跟着模型走、同桌不重名」,不属于扑克)
 * @returns {{title:string, sub:string, ms:number}|null} null = 不弹横幅
 */
export function settlementBanner(result, seatName) {
  if (!result) return null;
  if (result.type === 'showdown') {
    const winNames = (result.winners || [])
      .map((w) => `${seatName(w.seat)} +${fmt(w.amount)}`)
      .join(' ');
    return { title: '摊牌', sub: winNames, ms: 2600 };
  }
  if (result.type === 'fold-win') {
    const w = (result.winners || [])[0];
    if (w) return { title: '收池', sub: `${seatName(w.seat)} +${fmt(w.amount)}(其他人弃牌)`, ms: 2200 };
  }
  return null;
}

/**
 * 牌局彻底结束(只剩一个人)时的横幅文案。
 * @param {object} champ 唯一的存活者(可能为 undefined)
 * @param {(seat:number)=>string} seatName
 */
export function championBanner(champ, seatName) {
  return {
    title: '牌局结束',
    sub: `${champ ? seatName(champ.seat) : '?'} 赢下全场`,
    ms: 6000,
  };
}
