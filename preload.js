'use strict';
/**
 * preload:用 contextBridge 暴露最小接口。
 * 渲染进程不开 nodeIntegration,牌局逻辑通过相对路径加载(纯 ES 模块,不依赖 Node API)。
 *
 * LLM 调用走主进程代理(src/main/config.cjs 的 llm:chat):
 *   · 绕开各家 API 的 CORS 限制;
 *   · API Key 不进入页面上下文;
 *   · 流式增量通过 llm:chunk 回推,界面才能实时显示「思考」。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pokerAPI', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  clearKey: () => ipcRenderer.invoke('config:clearKey'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  openConfigFolder: () => ipcRenderer.invoke('shell:openConfigFolder'),
  llmPing: () => ipcRenderer.invoke('llm:ping'),

  /**
   * 对局快照(续玩)。
   *
   * 与网页版 web/pokerApi.js 里同名的几个方法**逐条对齐**:
   *   · 返回原样的快照对象 / { ok, error? },版本校验不在这里做
   *     (两端共同的逻辑在 src/core/gameStore.js,只有一份);
   *   · 桌面版落在 userData/game.json,网页版落在 localStorage —— 位置不同、行为相同。
   *
   * ⚠️ Sync 那几个是**给「页面即将被回收」用的**(visibilitychange→hidden / pagehide):
   *    那一刻之后的异步回调不保证还会执行,所以必须 sendSync 同步写完。
   *    sendSync 会阻塞渲染进程,常规保存一律走上面的异步版本。
   */
  getGame: () => ipcRenderer.invoke('game:get'),
  setGame: (snap) => ipcRenderer.invoke('game:set', snap),
  clearGame: () => ipcRenderer.invoke('game:clear'),
  getGameSync: () => ipcRenderer.sendSync('game:getSync'),
  setGameSync: (snap) => ipcRenderer.sendSync('game:setSync', snap),
  clearGameSync: () => ipcRenderer.sendSync('game:clearSync'),

  /**
   * 发起一次流式对话请求。
   * @param {{provider:string,kind?:string,endpoint:string,apiKey:string,model:string,
   *          system:string,user:string,temperature?:number,maxTokens?:number,timeoutMs?:number,
   *          reasoningLevel?:'off'|'low'|'default',omit?:string[],requestExtra?:object,
   *          requestId:string}} spec
   *   reasoningLevel 与 omit 都是**主进程侧 buildRequest 要用的字段**:
   *   前者决定四条协议各自发什么思考参数,后者是参数降级重试要摘掉的字段名。
   *   IPC 只是原样转发 spec,所以这里少列一个字段不会报错,只会静默变成死字段 ——
   *   加新字段时记得同步这份注释(它是调用方唯一能看到的接口说明)。
   * @param {{onDelta?:(delta:string, full:string, thinking:boolean)=>void, onReset?:()=>void}} hooks
   *   onDelta 的 thinking=true 表示这是「推理阶段」的增量(界面可弱化显示);
   *   onReset 在推理结束、正式回答开始时触发一次。
   * @returns {Promise<{ok:boolean,status:number,text?:string,error?:string,chunks?:number}>}
   */
  llmChat: async (spec, hooks = {}) => {
    const onChunk = (_e, payload) => {
      if (!payload || payload.requestId !== spec.requestId) return;
      try {
        if (payload.reset) { hooks.onReset?.(); return; }
        hooks.onDelta?.(payload.delta, payload.full, !!payload.thinking);
      } catch { /* 渲染层出错不影响主流程 */ }
    };
    ipcRenderer.on('llm:chunk', onChunk);
    try {
      return await ipcRenderer.invoke('llm:chat', spec);
    } finally {
      ipcRenderer.removeListener('llm:chunk', onChunk);
    }
  },

  llmAbort: (requestId) => ipcRenderer.invoke('llm:abort', requestId),
});
