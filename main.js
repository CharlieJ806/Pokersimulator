'use strict';
/**
 * Electron 主进程:创建窗口 + 注册配置 IPC。
 * 牌局逻辑全部在渲染进程(src/core、src/ai、src/ui),主进程只负责窗口与设置存取。
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const { registerIpc } = require('./src/main/config.cjs');

// 3D 场景需要 WebGL。有些机器(虚拟机、老显卡、远程桌面)拿不到硬件加速,
// 这里允许 Chromium 退回 SwiftShader 软件渲染 —— 帧率低一点,但画面是正常的。
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

const CONFIG_PATH = path.join(app.getPath('userData'), 'settings.json');
registerIpc(CONFIG_PATH);

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#141b22',
    title: '德州荷官 · Poker Dealer',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'ui', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  if (process.argv.includes('--devtools')) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
