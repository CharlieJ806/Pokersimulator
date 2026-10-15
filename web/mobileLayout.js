/**
 * 移动端初始化:在手机上把「默认展开」的重面板收起来。
 *
 * 为什么用 JS 而不是纯 CSS:
 *   侧栏/手牌一览的折叠是**有状态的**(内部记着 collapsed,宽度和布局跟着算),
 *   纯 CSS 隐藏会让内部状态和实际显示不一致 —— 点「收起」反而可能展开。
 *   所以这里调用现成的 setSidePanelOpen / setHandStripCollapsed,
 *   让状态和显示保持一致。
 *
 * 什么时候算「手机 / 小屏」:
 *   横向时看高度(手机横屏只有 390 左右),竖向时看宽度。
 *   不做设备判断(不看 UA),只看可视区 —— 桌面把窗口拖窄也会生效,这是期望行为。
 */

/** 当前是否属于「屏幕很紧」的情况 */
export function isCompactViewport() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const landscape = w > h;
  // 手机横屏:高度普遍在 320~450;平板横屏 768+ 不算
  if (landscape) return h <= 520 && w <= 1000;
  // 竖屏:按宽度判断
  return w <= 640;
}

/**
 * 按当前视口调整面板的默认开合状态。
 * @param {object} table SceneTable 实例
 * @param {{force?:boolean}} opts force=true 时无视「用户是否手动改过」
 */
export function applyMobileLayout(table, opts = {}) {
  if (!table) return { compact: false };

  const compact = isCompactViewport();

  // 用户手动开合过就不再自动干预(尊重用户选择),除非 force
  if (table.__mobileUserTouched && !opts.force) {
    return { compact, skipped: true };
  }

  try {
    if (compact) {
      // 侧栏收起:它占 260px 宽,是挤压牌桌的主因
      table.setSidePanelOpen?.(false);
      // 手牌一览保留展开态 —— 手机上牌面小,这是唯一能看清牌的地方
      // (它的高度已经被 mobile.css 压到 ~90px,不再是瓶颈)
    }
    // 桌面/大屏不强制改变状态,交给用户原来的偏好
  } catch (err) {
    console.warn('[mobile] 调整面板状态失败:', err);
  }
  return { compact };
}

/**
 * 让「下注按钮」贴在手牌一览的上沿。
 *
 * 为什么需要:
 *   桌面版把操作条固定在底部(--pbar-bottom 写死),因为桌面够高。
 *   手机上这个固定值会让按钮浮到 y=17 —— 直接压在 44px 的顶栏上(实测)。
 *   而手牌一览的高度是动态的(展开/收起、人数不同),写死一个值必然对不上。
 *
 *   所以这里量出手牌一览的实际高度,把它换算成 --pbar-bottom,
 *   再用 ResizeObserver 跟着变化走。收起手牌一览时操作条自然落到底部。
 */
function syncPlayerBarAnchor() {
  const strip = document.getElementById('handStrip');
  const root = document.documentElement;
  if (!strip) {
    root.style.removeProperty('--pbar-bottom');
    return;
  }

  // 先量底部操作条的真实高度并写进 --actionbar-h。
  // 手牌一览的 bottom 就是靠它让开操作条的(mobile.css 里是
  // calc(var(--actionbar-h) + 6px))—— 写死数字迟早会对不上,
  // 因为操作条里的按钮在手机上会被压扁、在玩家模式下还会藏掉两个。
  const ab = document.querySelector('.actionbar');
  if (ab) {
    const h = Math.round(ab.getBoundingClientRect().height);
    if (h > 0) root.style.setProperty('--actionbar-h', `${h}px`);
  }

  const compact = isCompactViewport();
  if (!compact) {
    // 大屏交回给 CSS 里的桌面值
    root.style.removeProperty('--pbar-bottom');
    return;
  }

  // ⚠️ 这里必须**量**手牌一览离底边多远,不能写死 8px。
  //    以前写死 8(因为那时 CSS 是 bottom:8px),后来手牌一览要
  //    让开操作条、bottom 变成 calc(--actionbar-h + 6px),
  //    写死的 8 就让下注条压在牌面上。
  //    (读 rect 会强制刷新布局,所以上面刚写的 --actionbar-h 已经生效。)
  const rect = strip.getBoundingClientRect();
  const viewportH = window.innerHeight;
  const stripBottomOffset = Math.max(0, viewportH - rect.bottom);
  // 手牌一览占掉的高度 = 它自己的高 + 它离底边的距离,再加一点间距
  const bottom = Math.round(rect.height + stripBottomOffset + 6);
  // 别把操作条顶到顶栏上面去(顶栏约 44px,再留 8px 呼吸)
  const maxBottom = Math.max(60, viewportH - 56 - 70);
  root.style.setProperty('--pbar-bottom', `${-Math.min(bottom, maxBottom)}px`);
}

/** 安装:首次同步 + 监听手牌一览尺寸变化 */
export function installPlayerBarAnchor() {
  const strip = document.getElementById('handStrip');
  let ro = null;
  if (window.ResizeObserver && strip) {
    ro = new ResizeObserver(() => syncPlayerBarAnchor());
    ro.observe(strip);
  }
  const onResize = () => syncPlayerBarAnchor();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  // 手牌一览的展开/收起也要重新对齐
  const btn = document.getElementById('btnHandStrip');
  // 具名函数:卸载时要能摘掉(以前绑的是匿名函数,卸载时摘的却是 onResize,永远摘不掉)
  const onStripToggle = () => setTimeout(syncPlayerBarAnchor, 60);
  btn?.addEventListener('click', onStripToggle);

  syncPlayerBarAnchor();
  // 首次布局可能还没稳定,补一帧
  requestAnimationFrame(() => requestAnimationFrame(syncPlayerBarAnchor));

  return () => {
    ro?.disconnect();
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    btn?.removeEventListener('click', onStripToggle);
    document.documentElement.style.removeProperty('--pbar-bottom');
  };
}

/**
 * 安装移动端适配。返回一个卸载函数(便于测试)。
 */
export function installMobileLayout(table) {
  const onResize = () => {
    // 防抖:旋转屏幕会连发多次 resize
    clearTimeout(installMobileLayout._t);
    installMobileLayout._t = setTimeout(() => {
      applyMobileLayout(table);
      syncPlayerBarAnchor();
    }, 180);
  };

  // 判断「用户手动改过」:监听侧栏开关按钮
  const markTouched = () => { table.__mobileUserTouched = true; };
  const btnLog = document.getElementById('btnLog');       // 侧栏开关
  const btnStrip = document.getElementById('btnHandStrip'); // 手牌一览开关
  btnLog?.addEventListener('click', markTouched);
  btnStrip?.addEventListener('click', markTouched);

  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  const uninstallAnchor = installPlayerBarAnchor();

  // 首次应用(等一帧,确保 3D 场景已经建好)
  requestAnimationFrame(() => {
    applyMobileLayout(table, { force: true });
    syncPlayerBarAnchor();
  });

  // 竖屏手机:能玩,但牌桌只有屏幕中间一小块。进牌桌时提示一次横屏
  // (只在真正进入牌桌后提示,主页 / 设置页竖着看没问题)
  let rotateHinted = false;
  const maybeHintRotate = () => {
    if (rotateHinted || !window.__poker?.engine) return;
    if (window.innerWidth < window.innerHeight && window.innerWidth <= 640) {
      rotateHinted = true;
      clearInterval(hintTimer);
      table.toast?.('横过来玩更舒服:牌桌和按钮都会大一些', 'info', 4200);
    }
  };
  const hintTimer = setInterval(maybeHintRotate, 1500);

  return () => {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    btnLog?.removeEventListener('click', markTouched);
    btnStrip?.removeEventListener('click', markTouched);
    clearTimeout(installMobileLayout._t);
    clearInterval(hintTimer);
    uninstallAnchor();
  };
}
