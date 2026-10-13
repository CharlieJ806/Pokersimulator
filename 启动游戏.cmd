@echo off
chcp 65001 >nul
title 德州荷官 Poker Dealer
cd /d "%~dp0"

rem 某些 IDE / 终端会设置 ELECTRON_RUN_AS_NODE,那样 Electron 会被当成普通 Node 启动
set ELECTRON_RUN_AS_NODE=

if not exist "node_modules\electron\dist\electron.exe" (
  echo [!] 还没安装依赖,正在执行 npm install ...
  call npm install
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [x] Electron 没装好。请手动执行:
  echo       npm install
  echo       node node_modules\electron\install.js
  pause
  exit /b 1
)

echo 正在启动「德州荷官」...
start "" "node_modules\electron\dist\electron.exe" .
