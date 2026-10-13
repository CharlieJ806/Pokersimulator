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
   * 发起一次流式对话请求。
   * @param {{provider:string,kind?:string,endpoint:string,apiKey:string,model:string,
   *          system:string,user:string,temperature?:number,maxTokens?:number,timeoutMs?:number,
   *          requestId:string}} spec
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
