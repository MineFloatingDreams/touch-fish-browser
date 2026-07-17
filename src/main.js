"use strict";

const {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  Tray,
  WebContentsView,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  clamp,
  constrainBounds,
  createBossSnapshot,
  detectImageType,
  getBossWindowBounds,
  getBossRestoreAction,
  isAllowedRemoteUrl,
  MAX_CUSTOM_AD_IMAGES,
  MAX_BOOKMARK_FILE_BYTES,
  MAX_TABS,
  MIN_BOSS_WINDOW_HEIGHT,
  MIN_BOSS_WINDOW_WIDTH,
  normalizeAccelerator,
  normalizeUrl,
  parseBookmarkHtml,
  sanitizeAdWindowSize,
  sanitizeSettings,
} = require("./core");
const { SettingsStore } = require("./settings-store");

const APP_ID = "com.codex.floatingminibrowser";
const REMOTE_PARTITION = "persist:floating-mini-browser";
const TITLEBAR_HEIGHT = 42;
const BROWSER_CONTROLS_HEIGHT = 42;
const MOUSE_RELEASE_KEY = "Alt+Shift+M";
const IS_SMOKE_TEST = process.env.FMB_SMOKE === "1";

if (IS_SMOKE_TEST && process.env.FMB_SMOKE_USER_DATA) {
  app.setPath("userData", process.env.FMB_SMOKE_USER_DATA);
}

app.setAppUserModelId(APP_ID);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let mainWindow = null;
let browserSession = null;
let tray = null;
let settingsStore = null;
let settings = sanitizeSettings({});
let quitting = false;
let appMode = "web";
let settingsOverlayOpen = false;
let bossSnapshot = null;
let activeBossKey = "";
let bossKeyRegistered = false;
let mouseReleaseRegistered = false;
let saveBoundsTimer = null;
let mouseTransparencyTimer = null;
let mouseLeaveOpacitySnapshot = null;
let smokeStarted = false;
let nextTabId = 1;
let activeTabId = null;
const tabs = [];
const childWindows = new Set();

function hasUsableMainWindow() {
  return Boolean(mainWindow && !mainWindow.isDestroyed());
}

function isTrustedRenderer(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender.id === mainWindow.webContents.id);
}

function assertTrustedRenderer(event) {
  if (!isTrustedRenderer(event)) throw new Error("拒绝来自未知渲染进程的请求");
}

function isPathInside(parentDirectory, candidatePath) {
  if (!candidatePath) return false;
  const relative = path.relative(path.resolve(parentDirectory), path.resolve(candidatePath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function getIconPath() {
  return path.join(__dirname, "..", "build", "icon.png");
}

function sendToUi(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function getActiveTab() {
  return tabs.find((tab) => tab.id === activeTabId) || null;
}

function getTabUrl(tab) {
  if (!tab || tab.view.webContents.isDestroyed()) return "";
  const url = tab.view.webContents.getURL();
  return url && url !== "about:blank" && isAllowedRemoteUrl(url) ? url : tab.url;
}

function getTabSummaries() {
  return tabs.map((tab) => ({
    id: tab.id,
    title: tab.title || "新标签页",
    url: getTabUrl(tab),
    loading: tab.loading,
    active: tab.id === activeTabId,
  }));
}

function getBrowserState() {
  const tab = getActiveTab();
  if (!tab || tab.view.webContents.isDestroyed()) {
    return {
      url: settings.lastUrl,
      title: "新标签页",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: "",
      activeTabId,
      tabs: getTabSummaries(),
      maxTabs: MAX_TABS,
      mouseCaptured: false,
      mouseReleaseKey: MOUSE_RELEASE_KEY,
      mouseReleaseRegistered,
    };
  }
  const contents = tab.view.webContents;
  const history = contents.navigationHistory;
  return {
    url: contents.getURL() === "about:blank" ? "" : contents.getURL(),
    title: tab.title || contents.getTitle() || "新标签页",
    loading: tab.loading,
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
    error: tab.error,
    activeTabId,
    tabs: getTabSummaries(),
    maxTabs: MAX_TABS,
    mouseCaptured: tab.mouseCaptured,
    mouseReleaseKey: MOUSE_RELEASE_KEY,
    mouseReleaseRegistered,
  };
}

function getSafeCustomImagePaths() {
  const userDataPath = app.getPath("userData");
  return settings.adConfig.customImagePaths.filter((imagePath) => isPathInside(userDataPath, imagePath));
}

async function readAdImageDataUrls() {
  const results = await Promise.all(getSafeCustomImagePaths().map(async (imagePath) => {
    try {
      const buffer = await fs.readFile(imagePath);
      const imageType = detectImageType(buffer);
      return imageType ? `data:${imageType.mime};base64,${buffer.toString("base64")}` : "";
    } catch {
      return "";
    }
  }));
  return results.filter(Boolean);
}

function getPublicSettings() {
  return {
    opacity: settings.opacity,
    alwaysOnTop: settings.alwaysOnTop,
    transparentWhenMouseOutside: settings.transparentWhenMouseOutside,
    controlsHidden: settings.controlsHidden,
    closeBehavior: settings.closeBehavior,
    adWindowSize: settings.adWindowSize,
    bossKey: settings.bossKey,
    bossKeyAction: settings.bossKeyAction,
    autoStart: settings.autoStart,
    lastUrl: settings.lastUrl,
    bookmarks: settings.bookmarks,
    adConfig: {
      mode: settings.adConfig.mode,
      hasCustomImage: getSafeCustomImagePaths().length > 0,
      customImageCount: getSafeCustomImagePaths().length,
    },
  };
}

async function getAppState() {
  return {
    settings: getPublicSettings(),
    browser: getBrowserState(),
    mode: appMode,
    settingsOverlayOpen,
    shortcutRegistered: bossKeyRegistered,
    adImageDataUrls: await readAdImageDataUrls(),
    autoStartSupported: app.isPackaged,
  };
}

async function broadcastAppState() {
  sendToUi("app:state", await getAppState());
}

function broadcastBrowserState() {
  sendToUi("browser:state", getBrowserState());
}

function getInitialWindowBounds() {
  const saved = settings.windowBounds;
  const display = Number.isFinite(saved.x) && Number.isFinite(saved.y)
    ? screen.getDisplayMatching({ x: saved.x, y: saved.y, width: saved.width, height: saved.height })
    : screen.getPrimaryDisplay();
  return constrainBounds(saved, display.workArea);
}

function layoutBrowserViews() {
  if (!hasUsableMainWindow()) return;
  const [width, height] = mainWindow.getContentSize();
  const browserTop = TITLEBAR_HEIGHT + (settings.controlsHidden ? 0 : BROWSER_CONTROLS_HEIGHT);
  for (const tab of tabs) {
    tab.view.setBounds({
      x: 0,
      y: browserTop,
      width: Math.max(1, width),
      height: Math.max(1, height - browserTop),
    });
  }
}

function updateBrowserViewsVisibility() {
  if (!hasUsableMainWindow()) return;
  for (const tab of tabs) {
    const url = tab.view.webContents.isDestroyed() ? "" : tab.view.webContents.getURL();
    const hasRemotePage = Boolean(url && url !== "about:blank");
    const visible =
      tab.id === activeTabId &&
      appMode === "web" &&
      !settingsOverlayOpen &&
      mainWindow.isVisible() &&
      !mainWindow.isMinimized() &&
      hasRemotePage;
    tab.view.setVisible(visible);
  }
}

function scheduleBoundsSave() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized() || appMode !== "web") return;
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed() || appMode !== "web") return;
    settings.windowBounds = mainWindow.getNormalBounds();
    void settingsStore.save(settings).then((saved) => {
      settings = saved;
    });
  }, 250);
}

function showMainWindow({ focus = true } = {}) {
  if (!hasUsableMainWindow()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  if (focus) mainWindow.focus();
  updateBrowserViewsVisibility();
  rebuildTrayMenu();
  return true;
}

function hideMainWindow() {
  if (!hasUsableMainWindow()) return false;
  void releaseMouseCapture({ focusUi: false, notice: false });
  restoreMouseLeaveOpacity();
  mainWindow.hide();
  updateBrowserViewsVisibility();
  rebuildTrayMenu();
  return true;
}

function closeMainWindow() {
  if (settings.closeBehavior === "quit") {
    quitting = true;
    app.quit();
    return "quit";
  }
  hideMainWindow();
  return "tray";
}

function getIntendedWindowOpacity() {
  return mouseLeaveOpacitySnapshot ?? (hasUsableMainWindow() ? mainWindow.getOpacity() : settings.opacity / 100);
}

function setManagedWindowOpacity(value) {
  const opacity = clamp(Number(value), 0, 1);
  if (mouseLeaveOpacitySnapshot !== null) {
    mouseLeaveOpacitySnapshot = opacity;
    if (hasUsableMainWindow()) mainWindow.setOpacity(0);
    return;
  }
  if (hasUsableMainWindow()) mainWindow.setOpacity(opacity);
}

function restoreMouseLeaveOpacity() {
  if (mouseLeaveOpacitySnapshot === null) return;
  const opacity = mouseLeaveOpacitySnapshot;
  mouseLeaveOpacitySnapshot = null;
  if (hasUsableMainWindow()) mainWindow.setOpacity(opacity);
}

function updateMouseLeaveTransparency(cursorPoint = screen.getCursorScreenPoint()) {
  if (appMode === "ad") {
    restoreMouseLeaveOpacity();
    return;
  }
  if (
    !settings.transparentWhenMouseOutside ||
    !mainWindow ||
    mainWindow.isDestroyed() ||
    !mainWindow.isVisible() ||
    mainWindow.isMinimized()
  ) return;
  const bounds = mainWindow.getBounds();
  const inside =
    cursorPoint.x >= bounds.x && cursorPoint.x < bounds.x + bounds.width &&
    cursorPoint.y >= bounds.y && cursorPoint.y < bounds.y + bounds.height;
  if (!inside && mouseLeaveOpacitySnapshot === null) {
    mouseLeaveOpacitySnapshot = mainWindow.getOpacity();
    mainWindow.setOpacity(0);
  } else if (inside) {
    restoreMouseLeaveOpacity();
  }
}

function syncMouseTransparencyTracking() {
  clearInterval(mouseTransparencyTimer);
  mouseTransparencyTimer = null;
  if (!settings.transparentWhenMouseOutside) {
    restoreMouseLeaveOpacity();
    return;
  }
  mouseTransparencyTimer = setInterval(updateMouseLeaveTransparency, 100);
  updateMouseLeaveTransparency();
}

function setAlwaysOnTop(value) {
  settings.alwaysOnTop = settings.transparentWhenMouseOutside || Boolean(value);
  if (hasUsableMainWindow()) {
    mainWindow.setAlwaysOnTop(appMode === "ad" ? false : settings.alwaysOnTop, "floating");
  }
  rebuildTrayMenu();
}

function setAutoStart(value) {
  settings.autoStart = Boolean(value);
  if (!app.isPackaged || IS_SMOKE_TEST) return false;
  const executablePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  app.setLoginItemSettings({ openAtLogin: settings.autoStart, path: executablePath });
  return true;
}

function registerInitialBossKey() {
  if (IS_SMOKE_TEST) {
    bossKeyRegistered = true;
    activeBossKey = settings.bossKey;
    return;
  }
  activeBossKey = settings.bossKey;
  bossKeyRegistered = globalShortcut.register(activeBossKey, toggleBossMode);
}

function registerMouseReleaseKey() {
  if (IS_SMOKE_TEST) {
    mouseReleaseRegistered = true;
    return;
  }
  mouseReleaseRegistered = globalShortcut.register(MOUSE_RELEASE_KEY, () => {
    void releaseMouseCapture({ focusUi: true, notice: true });
  });
}

async function releaseMouseCapture({ focusUi = true, notice = true } = {}) {
  let released = false;
  for (const tab of tabs) {
    if (tab.view.webContents.isDestroyed()) continue;
    try {
      const pageReleased = await tab.view.webContents.executeJavaScript(`(() => {
        let changed = false;
        if (document.pointerLockElement) {
          document.exitPointerLock();
          changed = true;
        }
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
          changed = true;
        }
        return changed;
      })()`, true);
      released = released || pageReleased || tab.mouseCaptured;
    } catch {
      released = released || tab.mouseCaptured;
    }
    tab.mouseCaptured = false;
  }
  if (focusUi && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.focus();
  }
  broadcastTabState();
  if (notice) {
    sendToUi("app:notice", {
      message: released ? "鼠标控制已释放" : `未检测到鼠标锁定；释放键为 ${MOUSE_RELEASE_KEY}`,
    });
  }
  return released;
}

async function changeBossKey(rawValue) {
  const accelerator = normalizeAccelerator(rawValue);
  if (!accelerator) return { ok: false, error: "组合键无效或与常见系统快捷键冲突" };
  if (accelerator === activeBossKey && bossKeyRegistered) {
    return { ok: true, bossKey: activeBossKey };
  }

  if (!IS_SMOKE_TEST && !globalShortcut.register(accelerator, toggleBossMode)) {
    return { ok: false, error: "该快捷键已被系统或其他应用占用" };
  }
  if (!IS_SMOKE_TEST && activeBossKey) globalShortcut.unregister(activeBossKey);
  activeBossKey = accelerator;
  bossKeyRegistered = true;
  settings.bossKey = accelerator;
  settings = await settingsStore.save(settings);
  await broadcastAppState();
  return { ok: true, bossKey: accelerator };
}

function hideChildWindowsForBossMode() {
  const visibleChildren = [];
  for (const child of childWindows) {
    if (!child.isDestroyed() && child.isVisible()) {
      visibleChildren.push(child);
      child.hide();
    }
  }
  return visibleChildren;
}

function getPageWebContents() {
  const contents = tabs
    .map((tab) => tab.view.webContents)
    .filter((item) => !item.isDestroyed());
  for (const child of childWindows) {
    if (!child.isDestroyed() && !child.webContents.isDestroyed()) contents.push(child.webContents);
  }
  return [...new Set(contents)];
}

function muteAllWebPages() {
  const audioStates = new Map();
  for (const contents of getPageWebContents()) {
    audioStates.set(contents, contents.isAudioMuted());
    contents.setAudioMuted(true);
  }
  return audioStates;
}

function restoreWebPageAudio(audioStates) {
  const previousStates = audioStates instanceof Map ? audioStates : new Map();
  for (const contents of getPageWebContents()) {
    contents.setAudioMuted(previousStates.get(contents) ?? false);
  }
}

function toggleBossMode() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (appMode === "web") {
    void releaseMouseCapture({ focusUi: false, notice: false });
    clearTimeout(saveBoundsTimer);
    const windowBounds = mainWindow.getNormalBounds();
    const display = screen.getDisplayMatching(windowBounds);
    const windowOpacity = getIntendedWindowOpacity();
    restoreMouseLeaveOpacity();
    bossSnapshot = {
      ...createBossSnapshot({ visible: mainWindow.isVisible(), minimized: mainWindow.isMinimized() }),
      windowBounds,
      minimumSize: mainWindow.getMinimumSize(),
      opacity: windowOpacity,
      audioStates: muteAllWebPages(),
      visibleChildren: hideChildWindowsForBossMode(),
    };
    appMode = settings.bossKeyAction === "hide" ? "boss-hidden" : "ad";
    settingsOverlayOpen = false;
    if (appMode === "boss-hidden") {
      mainWindow.hide();
      updateBrowserViewsVisibility();
      sendToUi("app:mode", { mode: appMode, settingsOverlayOpen: false });
      rebuildTrayMenu();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setMinimumSize(MIN_BOSS_WINDOW_WIDTH, MIN_BOSS_WINDOW_HEIGHT);
    mainWindow.setBounds(getBossWindowBounds(display.workArea, settings.adWindowSize), false);
    setManagedWindowOpacity(1);
    mainWindow.show();
    mainWindow.focus();
    updateBrowserViewsVisibility();
    sendToUi("app:mode", { mode: appMode, settingsOverlayOpen: false });
    rebuildTrayMenu();
    return;
  }

  clearTimeout(saveBoundsTimer);
  const snapshot = bossSnapshot;
  if (snapshot?.minimumSize) mainWindow.setMinimumSize(...snapshot.minimumSize);
  if (snapshot?.windowBounds) mainWindow.setBounds(snapshot.windowBounds, false);
  setManagedWindowOpacity(snapshot?.opacity ?? settings.opacity / 100);
  restoreWebPageAudio(snapshot?.audioStates);
  mainWindow.setAlwaysOnTop(settings.alwaysOnTop, "floating");
  appMode = "web";
  sendToUi("app:mode", { mode: appMode, settingsOverlayOpen: false });
  const restoreAction = getBossRestoreAction(snapshot);
  if (restoreAction === "hide") {
    mainWindow.hide();
  } else if (restoreAction === "minimize") {
    mainWindow.show();
    mainWindow.minimize();
  } else {
    mainWindow.show();
    mainWindow.focus();
    for (const child of snapshot?.visibleChildren || []) {
      if (!child.isDestroyed()) child.show();
    }
  }
  bossSnapshot = null;
  updateBrowserViewsVisibility();
  rebuildTrayMenu();
}

function isAllowedPopupUrl(url) {
  return url === "about:blank" || isAllowedRemoteUrl(url);
}

function hardenRemoteContents(contents, { openInTabs = false } = {}) {
  if (appMode !== "web") contents.setAudioMuted(true);
  contents.on("will-navigate", (event, url) => {
    if (!isAllowedPopupUrl(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler((details) => {
    if (!isAllowedPopupUrl(details.url)) return { action: "deny" };
    if (openInTabs && isAllowedRemoteUrl(details.url) && !details.postBody) {
      const loadOptions = {};
      if (details.referrer?.url && isAllowedRemoteUrl(details.referrer.url)) {
        loadOptions.httpReferrer = details.referrer;
      }
      setImmediate(() => {
        const result = createBrowserTab(details.url, { loadOptions });
        if (!result.ok) sendToUi("app:notice", { message: result.error || "新标签页创建失败" });
      });
      return { action: "deny" };
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        parent: mainWindow,
        width: 900,
        height: 720,
        minWidth: 360,
        minHeight: 320,
        autoHideMenuBar: true,
        backgroundColor: "#ffffff",
        webPreferences: {
          partition: REMOTE_PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
        },
      },
    };
  });
  contents.on("did-create-window", (child) => {
    child.setMenuBarVisibility(false);
    childWindows.add(child);
    hardenRemoteContents(child.webContents, { openInTabs: false });
    child.on("closed", () => childWindows.delete(child));
  });
}

function persistTabs() {
  settings.tabs = tabs.map((tab) => getTabUrl(tab));
  settings.activeTabIndex = Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId));
  settings.lastUrl = getTabUrl(getActiveTab());
  void settingsStore.save(settings).then((saved) => {
    settings = saved;
  });
}

function broadcastTabState() {
  broadcastBrowserState();
}

function switchTab(tabId, { persist = true } = {}) {
  const tab = tabs.find((item) => item.id === Number(tabId));
  if (!tab) return { ok: false, error: "标签页不存在" };
  if (activeTabId !== tab.id) void releaseMouseCapture({ focusUi: false, notice: false });
  activeTabId = tab.id;
  settings.lastUrl = getTabUrl(tab);
  updateBrowserViewsVisibility();
  broadcastTabState();
  if (persist) persistTabs();
  return { ok: true, activeTabId };
}

function switchRelativeTab(offset) {
  if (tabs.length < 2) return;
  const currentIndex = Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId));
  const nextIndex = (currentIndex + offset + tabs.length) % tabs.length;
  switchTab(tabs[nextIndex].id);
}

function handleTabShortcut(event, input, tab) {
  if (input.type !== "keyDown") return;
  const key = String(input.key || "").toLowerCase();
  if (key === "escape" && tab.mouseCaptured) {
    void releaseMouseCapture({ focusUi: true, notice: false });
    return;
  }
  if (!input.control || input.alt || input.meta) return;
  if (key === "t") {
    event.preventDefault();
    createBrowserTab();
  } else if (key === "w") {
    event.preventDefault();
    closeBrowserTab(tab.id);
  } else if (key === "tab") {
    event.preventDefault();
    switchRelativeTab(input.shift ? -1 : 1);
  }
}

function configureBrowserViewEvents(tab) {
  const contents = tab.view.webContents;
  hardenRemoteContents(contents, { openInTabs: true });
  contents.on("before-input-event", (event, input) => handleTabShortcut(event, input, tab));

  contents.on("did-start-loading", () => {
    tab.loading = true;
    tab.error = "";
    updateBrowserViewsVisibility();
    if (tab.id === activeTabId) broadcastTabState();
  });
  contents.on("did-stop-loading", () => {
    tab.loading = false;
    if (tab.id === activeTabId) broadcastTabState();
  });
  contents.on("did-navigate", (_event, url) => {
    if (!isAllowedRemoteUrl(url)) return;
    tab.mouseCaptured = false;
    tab.url = url;
    tab.error = "";
    if (tab.id === activeTabId) settings.lastUrl = url;
    persistTabs();
    updateBrowserViewsVisibility();
    broadcastTabState();
  });
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (!isMainFrame || !isAllowedRemoteUrl(url)) return;
    tab.url = url;
    if (tab.id === activeTabId) settings.lastUrl = url;
    persistTabs();
    broadcastTabState();
  });
  contents.on("page-title-updated", (event, title) => {
    event.preventDefault();
    tab.title = String(title || "新标签页").slice(0, 200);
    broadcastTabState();
  });
  contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    tab.loading = false;
    tab.error = `${errorDescription || "网页加载失败"} (${errorCode})`;
    if (isAllowedRemoteUrl(validatedURL)) tab.url = validatedURL;
    persistTabs();
    if (tab.id === activeTabId) broadcastTabState();
  });
  contents.on("render-process-gone", () => {
    tab.loading = false;
    tab.error = "网页渲染进程已退出，请刷新重试";
    if (tab.id === activeTabId) broadcastTabState();
  });
}

function createBrowserTab(rawUrl = "", { activate = true, load = true, persist = true, loadOptions = undefined } = {}) {
  if (tabs.length >= MAX_TABS) return { ok: false, error: `最多只能打开 ${MAX_TABS} 个标签页` };
  const normalized = rawUrl ? normalizeUrl(rawUrl) : { ok: true, url: "" };
  if (!normalized.ok) return normalized;

  const view = new WebContentsView({
    webPreferences: {
      partition: REMOTE_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true,
    },
  });
  const tab = {
    id: nextTabId++,
    view,
    url: normalized.url,
    title: "新标签页",
    loading: false,
    error: "",
    mouseCaptured: false,
  };
  view.setBackgroundColor("#ffffff");
  view.setBorderRadius(10);
  view.setVisible(false);
  mainWindow.contentView.addChildView(view);
  tabs.push(tab);
  configureBrowserViewEvents(tab);
  layoutBrowserViews();
  if (activate || activeTabId === null) activeTabId = tab.id;
  updateBrowserViewsVisibility();
  broadcastTabState();
  if (persist) persistTabs();
  if (load && normalized.url) {
    view.webContents.loadURL(normalized.url, loadOptions).catch((error) => {
      tab.error = error.message;
      if (tab.id === activeTabId) broadcastTabState();
    });
  }
  return { ok: true, tab };
}

function closeBrowserTab(tabId, { persist = true } = {}) {
  const index = tabs.findIndex((tab) => tab.id === Number(tabId));
  if (index < 0) return { ok: false, error: "标签页不存在" };
  if (tabs[index].mouseCaptured) void releaseMouseCapture({ focusUi: false, notice: false });
  const [removed] = tabs.splice(index, 1);
  mainWindow.contentView.removeChildView(removed.view);
  if (!removed.view.webContents.isDestroyed()) removed.view.webContents.close();

  if (!tabs.length) {
    activeTabId = null;
    createBrowserTab("", { activate: true, load: false, persist: false });
  } else if (removed.id === activeTabId) {
    activeTabId = tabs[Math.min(index, tabs.length - 1)].id;
  }
  updateBrowserViewsVisibility();
  broadcastTabState();
  if (persist) persistTabs();
  return { ok: true, activeTabId };
}

async function navigateTo(rawUrl) {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized.ok) return normalized;
  const tab = getActiveTab();
  if (!tab) return { ok: false, error: "当前没有可用标签页" };
  tab.error = "";
  tab.url = normalized.url;
  settings.lastUrl = normalized.url;
  persistTabs();
  updateBrowserViewsVisibility();
  tab.view.webContents.loadURL(normalized.url).catch((error) => {
    tab.error = error.message;
    broadcastTabState();
  });
  return { ok: true, url: normalized.url };
}

function configureDownloads() {
  browserSession.on("will-download", (_event, item) => {
    item.pause();
    const defaultPath = path.join(app.getPath("downloads"), item.getFilename());
    void dialog.showSaveDialog(mainWindow, {
      title: "保存下载文件",
      defaultPath,
      buttonLabel: "保存",
    }).then((result) => {
      if (result.canceled || !result.filePath) {
        item.cancel();
        sendToUi("app:notice", { message: "下载已取消" });
        return;
      }
      item.setSavePath(result.filePath);
      item.resume();
      sendToUi("app:notice", { message: `正在下载：${item.getFilename()}` });
    });
    item.once("done", (_doneEvent, state) => {
      sendToUi("app:notice", {
        message: state === "completed" ? `下载完成：${item.getFilename()}` : `下载结束：${state}`,
      });
    });
  });
}

function getTabForContents(contents) {
  if (!contents) return null;
  return tabs.find((tab) => !tab.view.webContents.isDestroyed() && tab.view.webContents.id === contents.id) || null;
}

function canGrantPointerLock(contents, requestingOrigin = "") {
  const tab = getTabForContents(contents);
  const sourceUrl = requestingOrigin || contents?.getURL() || "";
  return Boolean(
    tab &&
    tab.id === activeTabId &&
    isAllowedRemoteUrl(sourceUrl) &&
    mainWindow?.isVisible() &&
    !mainWindow.isMinimized() &&
    appMode === "web" &&
    !settingsOverlayOpen
  );
}

function configureSessionSecurity() {
  browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    return permission === "pointerLock" && canGrantPointerLock(contents, requestingOrigin);
  });
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const allowed = permission === "pointerLock" && canGrantPointerLock(contents, details?.requestingUrl);
    if (allowed) {
      const tab = getTabForContents(contents);
      tab.mouseCaptured = true;
      broadcastTabState();
      sendToUi("app:notice", { message: `网页正在控制鼠标，按 ${MOUSE_RELEASE_KEY} 强制释放` });
    }
    callback(allowed);
  });
  if (typeof browserSession.setDevicePermissionHandler === "function") {
    browserSession.setDevicePermissionHandler(() => false);
  }
}

function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed() || !hasUsableMainWindow()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: mainWindow.isVisible() ? "隐藏窗口" : "显示窗口",
      click: () => {
        if (!hasUsableMainWindow()) return;
        if (mainWindow.isVisible()) hideMainWindow();
        else showMainWindow();
      },
    },
    {
      label: appMode !== "web"
        ? "恢复网页"
        : (settings.bossKeyAction === "hide" ? "静音并隐藏" : "切换为广告"),
      click: toggleBossMode,
    },
    {
      label: "保持置顶",
      type: "checkbox",
      checked: settings.alwaysOnTop,
      click: (item) => {
        setAlwaysOnTop(item.checked);
        void settingsStore.save(settings).then((saved) => {
          settings = saved;
          void broadcastAppState();
        });
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]));
}

function createTray() {
  const trayImage = nativeImage.createFromPath(getIconPath()).resize({ width: 20, height: 20 });
  tray = new Tray(trayImage);
  tray.setToolTip("悬浮小浏览器");
  tray.on("click", () => {
    if (!hasUsableMainWindow()) return;
    if (mainWindow.isVisible()) hideMainWindow();
    else showMainWindow();
  });
  rebuildTrayMenu();
}

async function chooseAdImages() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `选择轮播广告图片（最多 ${MAX_CUSTOM_AD_IMAGES} 张）`,
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  if (result.filePaths.length > MAX_CUSTOM_AD_IMAGES) {
    return { ok: false, error: `一次最多选择 ${MAX_CUSTOM_AD_IMAGES} 张图片` };
  }

  const selectedImages = [];
  for (const sourcePath of result.filePaths) {
    const stat = await fs.stat(sourcePath);
    if (stat.size <= 0 || stat.size > 2 * 1024 * 1024) {
      return { ok: false, error: `${path.basename(sourcePath)} 必须小于等于 2 MB` };
    }
    const buffer = await fs.readFile(sourcePath);
    const imageType = detectImageType(buffer);
    if (!imageType) {
      return { ok: false, error: `${path.basename(sourcePath)} 不是有效的 PNG、JPEG 或 WebP 图片` };
    }
    selectedImages.push({ buffer, extension: imageType.extension });
  }

  const oldPaths = getSafeCustomImagePaths();
  const stamp = `${Date.now()}-${process.pid}`;
  const newPaths = [];
  try {
    for (let index = 0; index < selectedImages.length; index += 1) {
      const image = selectedImages[index];
      const destinationPath = path.join(
        app.getPath("userData"),
        `custom-ad-${stamp}-${String(index + 1).padStart(2, "0")}${image.extension}`
      );
      await fs.writeFile(destinationPath, image.buffer);
      newPaths.push(destinationPath);
    }
    settings.adConfig = { mode: "custom", customImagePaths: newPaths };
    settings = await settingsStore.save(settings);
  } catch (error) {
    await Promise.all(newPaths.map((imagePath) => fs.rm(imagePath, { force: true })));
    throw error;
  }
  await Promise.all(oldPaths.map((imagePath) => fs.rm(imagePath, { force: true })));
  await broadcastAppState();
  return { ok: true, count: newPaths.length, state: await getAppState() };
}

async function removeAdImages() {
  await Promise.all(getSafeCustomImagePaths().map((imagePath) => fs.rm(imagePath, { force: true })));
  settings.adConfig = { mode: "builtin", customImagePaths: [] };
  settings = await settingsStore.save(settings);
  await broadcastAppState();
  return { ok: true, state: await getAppState() };
}

async function importBookmarks() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "导入浏览器书签",
    properties: ["openFile"],
    filters: [{ name: "书签 HTML", extensions: ["html", "htm"] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  const filePath = result.filePaths[0];
  const stat = await fs.stat(filePath);
  if (stat.size <= 0 || stat.size > MAX_BOOKMARK_FILE_BYTES) {
    return { ok: false, error: "书签文件必须小于等于 1 MB" };
  }
  const bookmarks = parseBookmarkHtml(await fs.readFile(filePath, "utf8"));
  if (!bookmarks.length) return { ok: false, error: "没有找到有效的 HTTP/HTTPS 书签" };
  settings.bookmarks = bookmarks;
  settings = await settingsStore.save(settings);
  await broadcastAppState();
  return { ok: true, count: bookmarks.length, state: await getAppState() };
}

async function removeImportedBookmarks() {
  settings.bookmarks = [];
  settings = await settingsStore.save(settings);
  await broadcastAppState();
  return { ok: true, state: await getAppState() };
}

function registerIpcHandlers() {
  ipcMain.handle("app:bootstrap", async (event) => {
    assertTrustedRenderer(event);
    return getAppState();
  });
  ipcMain.handle("browser:navigate", async (event, url) => {
    assertTrustedRenderer(event);
    return navigateTo(url);
  });
  ipcMain.handle("browser:back", (event) => {
    assertTrustedRenderer(event);
    const contents = getActiveTab()?.view.webContents;
    if (contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
  });
  ipcMain.handle("browser:forward", (event) => {
    assertTrustedRenderer(event);
    const contents = getActiveTab()?.view.webContents;
    if (contents?.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
  });
  ipcMain.handle("browser:reload", (event) => {
    assertTrustedRenderer(event);
    getActiveTab()?.view.webContents.reload();
  });
  ipcMain.handle("browser:stop", (event) => {
    assertTrustedRenderer(event);
    getActiveTab()?.view.webContents.stop();
  });
  ipcMain.handle("browser:external", async (event, rawUrl) => {
    assertTrustedRenderer(event);
    const normalized = normalizeUrl(rawUrl || getTabUrl(getActiveTab()));
    if (!normalized.ok) return normalized;
    await shell.openExternal(normalized.url);
    return { ok: true };
  });
  ipcMain.handle("tabs:create", (event, url) => {
    assertTrustedRenderer(event);
    const result = createBrowserTab(url || "");
    return result.ok ? { ok: true, activeTabId: result.tab.id } : result;
  });
  ipcMain.handle("tabs:switch", (event, tabId) => {
    assertTrustedRenderer(event);
    return switchTab(tabId);
  });
  ipcMain.handle("tabs:close", (event, tabId) => {
    assertTrustedRenderer(event);
    return closeBrowserTab(tabId);
  });
  ipcMain.handle("window:minimize", (event) => {
    assertTrustedRenderer(event);
    void releaseMouseCapture({ focusUi: false, notice: false });
    mainWindow.minimize();
  });
  ipcMain.handle("window:close", (event) => {
    assertTrustedRenderer(event);
    return closeMainWindow();
  });
  ipcMain.handle("window:toggle-top", async (event) => {
    assertTrustedRenderer(event);
    setAlwaysOnTop(!settings.alwaysOnTop);
    settings = await settingsStore.save(settings);
    await broadcastAppState();
    return getPublicSettings();
  });
  ipcMain.handle("ui:set-overlay", (event, value) => {
    assertTrustedRenderer(event);
    settingsOverlayOpen = Boolean(value);
    if (settingsOverlayOpen) void releaseMouseCapture({ focusUi: true, notice: false });
    updateBrowserViewsVisibility();
  });
  ipcMain.handle("mouse:release", async (event) => {
    assertTrustedRenderer(event);
    const released = await releaseMouseCapture({ focusUi: true, notice: true });
    return { ok: true, released, shortcut: MOUSE_RELEASE_KEY };
  });
  ipcMain.handle("settings:update", async (event, patch) => {
    assertTrustedRenderer(event);
    const source = patch && typeof patch === "object" ? patch : {};
    if ("opacity" in source) {
      settings.opacity = clamp(Math.round(Number(source.opacity) || 90), 30, 100);
      setManagedWindowOpacity(settings.opacity / 100);
    }
    if ("transparentWhenMouseOutside" in source) {
      settings.transparentWhenMouseOutside = Boolean(source.transparentWhenMouseOutside);
      if (settings.transparentWhenMouseOutside) setAlwaysOnTop(true);
      syncMouseTransparencyTracking();
    }
    if ("controlsHidden" in source) {
      settings.controlsHidden = Boolean(source.controlsHidden);
      layoutBrowserViews();
    }
    if ("alwaysOnTop" in source) setAlwaysOnTop(Boolean(source.alwaysOnTop));
    if ("closeBehavior" in source) {
      settings.closeBehavior = source.closeBehavior === "quit" ? "quit" : "tray";
    }
    if ("adWindowSize" in source) settings.adWindowSize = sanitizeAdWindowSize(source.adWindowSize);
    if ("bossKeyAction" in source) settings.bossKeyAction = source.bossKeyAction === "hide" ? "hide" : "ad";
    if ("autoStart" in source) setAutoStart(Boolean(source.autoStart));
    if ("adMode" in source) {
      settings.adConfig.mode = source.adMode === "custom" && getSafeCustomImagePaths().length ? "custom" : "builtin";
    }
    settings = await settingsStore.save(settings);
    await broadcastAppState();
    return { ok: true, settings: getPublicSettings(), autoStartSupported: app.isPackaged };
  });
  ipcMain.handle("settings:set-boss-key", async (event, value) => {
    assertTrustedRenderer(event);
    return changeBossKey(value);
  });
  ipcMain.handle("ad:choose", async (event) => {
    assertTrustedRenderer(event);
    return chooseAdImages();
  });
  ipcMain.handle("ad:remove", async (event) => {
    assertTrustedRenderer(event);
    return removeAdImages();
  });
  ipcMain.handle("bookmarks:import", async (event) => {
    assertTrustedRenderer(event);
    return importBookmarks();
  });
  ipcMain.handle("bookmarks:remove", async (event) => {
    assertTrustedRenderer(event);
    return removeImportedBookmarks();
  });
  ipcMain.handle("boss:toggle", (event) => {
    assertTrustedRenderer(event);
    toggleBossMode();
  });
  ipcMain.handle("app:quit", (event) => {
    assertTrustedRenderer(event);
    quitting = true;
    app.quit();
  });
}

function createMainWindow() {
  const bounds = getInitialWindowBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 360,
    minHeight: 320,
    show: false,
    frame: false,
    transparent: false,
    roundedCorners: true,
    backgroundColor: "#f8fafc",
    alwaysOnTop: settings.alwaysOnTop,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  mainWindow.setOpacity(settings.opacity / 100);
  mainWindow.setAlwaysOnTop(settings.alwaysOnTop, "floating");
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) event.preventDefault();
  });
  mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));

  const restoredUrls = IS_SMOKE_TEST ? [""] : settings.tabs;
  for (const url of restoredUrls) {
    createBrowserTab(url, { activate: false, load: false, persist: false });
  }
  const initialIndex = IS_SMOKE_TEST ? 0 : Math.min(settings.activeTabIndex, tabs.length - 1);
  activeTabId = tabs[initialIndex].id;
  layoutBrowserViews();
  updateBrowserViewsVisibility();

  mainWindow.on("resize", () => {
    layoutBrowserViews();
    scheduleBoundsSave();
  });
  mainWindow.on("move", scheduleBoundsSave);
  mainWindow.on("show", updateBrowserViewsVisibility);
  mainWindow.on("hide", updateBrowserViewsVisibility);
  mainWindow.on("minimize", () => {
    void releaseMouseCapture({ focusUi: false, notice: false });
    restoreMouseLeaveOpacity();
    updateBrowserViewsVisibility();
  });
  mainWindow.on("restore", updateBrowserViewsVisibility);
  mainWindow.on("blur", () => {
    if (getActiveTab()?.mouseCaptured) void releaseMouseCapture({ focusUi: false, notice: false });
  });
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    closeMainWindow();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    mouseLeaveOpacitySnapshot = null;
  });

  mainWindow.webContents.once("did-finish-load", async () => {
    await broadcastAppState();
    if (!IS_SMOKE_TEST) {
      showMainWindow({ focus: false });
      for (const tab of tabs) {
        if (tab.url) void tab.view.webContents.loadURL(tab.url);
      }
    } else {
      void runSmokeTest();
    }
  });
}

function waitForEvent(emitter, eventName, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      emitter.removeListener(eventName, onEvent);
      reject(new Error(`等待 ${eventName} 超时`));
    }, timeoutMs);
    function onEvent(...args) {
      clearTimeout(timeout);
      resolve(args);
    }
    emitter.once(eventName, onEvent);
  });
}

async function sendSmokeShortcut(contents, keyCode, modifiers) {
  contents.focus();
  contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  await new Promise((resolve) => setTimeout(resolve, 120));
}

async function captureMainWindow(filePath, attempts = 10) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const image = await mainWindow.webContents.capturePage();
      const buffer = image.toPNG();
      if (buffer.length > 1000) {
        await fs.writeFile(filePath, buffer);
        return;
      }
      lastError = new Error("截图内容为空");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error("截图失败");
}

async function runSmokeTest() {
  if (smokeStarted) return;
  smokeStarted = true;
  const resultPath = process.env.FMB_SMOKE_RESULT;
  let smokeStep = "初始化";
  try {
    smokeStep = "校验环境变量";
    const page1 = normalizeUrl(process.env.FMB_SMOKE_URL);
    const page2 = normalizeUrl(process.env.FMB_SMOKE_SECOND_URL);
    if (!page1.ok || !page2.ok || !resultPath) throw new Error("Smoke test 环境变量不完整");

    const outputDirectory = path.dirname(resultPath);
    await fs.mkdir(outputDirectory, { recursive: true });
    const uiScreenshot = path.join(outputDirectory, "ui-smoke.png");
    const settingsScreenshot = path.join(outputDirectory, "settings-smoke.png");
    const adScreenshot = path.join(outputDirectory, "ad-smoke.png");
    const tabsScreenshot = path.join(outputDirectory, "tabs-smoke.png");
    smokeStep = "显示测试窗口";
    settings.transparentWhenMouseOutside = false;
    settings.controlsHidden = false;
    syncMouseTransparencyTracking();
    layoutBrowserViews();
    await broadcastAppState();
    mainWindow.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 200));
    smokeStep = "验证合并浏览栏收起与恢复";
    const mergedBrowserControls = await mainWindow.webContents.executeJavaScript(`(() => {
      const controls = document.querySelector(".browser-controls");
      return Boolean(controls?.querySelector(".tabs-bar") && controls?.querySelector(".navigation-bar"));
    })()`);
    const controlsExpandedBrowserTop = getActiveTab().view.getBounds().y;
    const controlsHidden = await mainWindow.webContents.executeJavaScript(`(async () => {
      document.querySelector(".controls-toggle-button").click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return document.body.classList.contains("controls-hidden");
    })()`);
    const controlsHiddenPersisted = settings.controlsHidden;
    const controlsCollapsedBrowserTop = getActiveTab().view.getBounds().y;
    const controlsRestored = await mainWindow.webContents.executeJavaScript(`(async () => {
      document.querySelector(".controls-toggle-button").click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return !document.body.classList.contains("controls-hidden");
    })()`);
    const controlsVisiblePersisted = !settings.controlsHidden;
    const controlsRestoredBrowserTop = getActiveTab().view.getBounds().y;
    smokeStep = "截取工具栏界面";
    await captureMainWindow(uiScreenshot);
    smokeStep = "验证首页预设与设置标签";
    const homePresetLabels = await mainWindow.webContents.executeJavaScript(
      "[...document.querySelectorAll('.site-shortcut span')].map((item) => item.textContent)"
    );
    const settingsTabOpen = await mainWindow.webContents.executeJavaScript(`(async () => {
      document.querySelector(".settings-button").click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return document.body.classList.contains("settings-open") && Boolean(document.querySelector(".settings-tab.active"));
    })()`);
    await captureMainWindow(settingsScreenshot);
    const settingsTabClosed = await mainWindow.webContents.executeJavaScript(`(async () => {
      document.querySelector(".settings-tab .tab-close").click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return !document.body.classList.contains("settings-open") && !document.querySelector(".settings-tab");
    })()`);
    settings.bookmarks = [{ title: "测试书签", url: page1.url }];
    await broadcastAppState();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const importedBookmarkVisible = await mainWindow.webContents.executeJavaScript(
      "[...document.querySelectorAll('.site-shortcut span')].some((item) => item.textContent === '测试书签')"
    );
    settings.bookmarks = [];
    await broadcastAppState();
    smokeStep = "验证鼠标移出透明与移回恢复";
    const mouseTransparencyBounds = mainWindow.getBounds();
    const mouseTransparencyOriginalOpacity = mainWindow.getOpacity();
    settings.transparentWhenMouseOutside = true;
    setAlwaysOnTop(false);
    const mouseTransparencyForcedTop = settings.alwaysOnTop && mainWindow.isAlwaysOnTop();
    updateMouseLeaveTransparency({ x: mouseTransparencyBounds.x - 1, y: mouseTransparencyBounds.y - 1 });
    const mouseTransparencyOutsideOpacity = mainWindow.getOpacity();
    updateMouseLeaveTransparency({ x: mouseTransparencyBounds.x + 1, y: mouseTransparencyBounds.y + 1 });
    const mouseTransparencyRestoredOpacity = mainWindow.getOpacity();
    restoreMouseLeaveOpacity();
    smokeStep = "截取广告界面";
    const bossInitiallyUnmutedTab = getActiveTab();
    const bossMutedTabResult = createBrowserTab("", { activate: false, load: false, persist: false });
    if (!bossMutedTabResult.ok) throw new Error(bossMutedTabResult.error);
    const bossInitiallyMutedTab = bossMutedTabResult.tab;
    const bossOriginalBounds = mainWindow.getNormalBounds();
    const bossOriginalMinimumSize = mainWindow.getMinimumSize();
    const bossOriginalOpacity = mainWindow.getOpacity();
    bossInitiallyUnmutedTab.view.webContents.setAudioMuted(false);
    bossInitiallyMutedTab.view.webContents.setAudioMuted(true);
    settings.bossKeyAction = "ad";
    settings.adWindowSize = { width: 280, height: 260 };
    const bossConfiguredSize = { ...settings.adWindowSize };
    const bossTargetBounds = getBossWindowBounds(screen.getDisplayMatching(bossOriginalBounds).workArea, settings.adWindowSize);
    toggleBossMode();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const bossAdBounds = mainWindow.getBounds();
    const bossAdMinimumSize = mainWindow.getMinimumSize();
    const bossAdOpacity = mainWindow.getOpacity();
    const bossAdAlwaysOnTop = mainWindow.isAlwaysOnTop();
    updateMouseLeaveTransparency({ x: bossAdBounds.x - 1, y: bossAdBounds.y - 1 });
    const bossAdIgnoredMouseTransparency = mainWindow.getOpacity() === 1;
    settings.transparentWhenMouseOutside = false;
    const bossAdAllPagesMuted = getPageWebContents().every((contents) => contents.isAudioMuted());
    const adUiState = await mainWindow.webContents.executeJavaScript(`({
      source: document.querySelector(".ad-carousel-image")?.getAttribute("src") || "",
      counter: document.querySelector(".ad-counter")?.textContent || "",
      closeButtonVisible: (() => {
        const button = document.querySelector(".ad-close-button");
        return Boolean(button && getComputedStyle(button).display !== "none" && button.getBoundingClientRect().width > 0);
      })()
    })`);
    await captureMainWindow(adScreenshot);
    smokeStep = "验证自定义图片轮播";
    const smokeCustomPaths = [1, 2].map((number) => path.join(app.getPath("userData"), `smoke-custom-${number}.png`));
    await fs.copyFile(path.join(__dirname, "..", "build", "ads", "ad-09.png"), smokeCustomPaths[0]);
    await fs.copyFile(path.join(__dirname, "..", "build", "ads", "ad-10.png"), smokeCustomPaths[1]);
    settings.adConfig = { mode: "custom", customImagePaths: smokeCustomPaths };
    settings = await settingsStore.save(settings);
    await broadcastAppState();
    let customAdUiState = { source: "", counter: "" };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      customAdUiState = await mainWindow.webContents.executeJavaScript(`({
        source: document.querySelector(".ad-carousel-image")?.getAttribute("src") || "",
        counter: document.querySelector(".ad-counter")?.textContent || ""
      })`);
      if (customAdUiState.source.startsWith("data:image/")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    settings.adConfig = { mode: "builtin", customImagePaths: [] };
    settings = await settingsStore.save(settings);
    await Promise.all(smokeCustomPaths.map((imagePath) => fs.rm(imagePath, { force: true })));
    await mainWindow.webContents.executeJavaScript("document.querySelector('.ad-close-button').click()");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const bossAdCloseHidWindow = !mainWindow.isVisible();
    const bossAdCloseKeptMode = appMode === "ad";
    toggleBossMode();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const bossRestoredBounds = mainWindow.getNormalBounds();
    const bossRestoredMinimumSize = mainWindow.getMinimumSize();
    const bossRestoredOpacity = mainWindow.getOpacity();
    const bossRestoredAlwaysOnTop = mainWindow.isAlwaysOnTop();
    const bossAudioRestored =
      !bossInitiallyUnmutedTab.view.webContents.isAudioMuted() &&
      bossInitiallyMutedTab.view.webContents.isAudioMuted();
    closeBrowserTab(bossInitiallyMutedTab.id, { persist: false });

    smokeStep = "验证老板键静音并隐藏";
    const bossHideSettingSelected = await mainWindow.webContents.executeJavaScript(`(async () => {
      document.querySelector(".settings-button").click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      document.querySelector(".boss-hide-radio").click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      return document.querySelector(".boss-hide-radio").checked;
    })()`);
    bossInitiallyUnmutedTab.view.webContents.setAudioMuted(false);
    const bossHideOriginalBounds = mainWindow.getNormalBounds();
    toggleBossMode();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const bossHideModeActive = appMode === "boss-hidden";
    const bossHideWindowHidden = !mainWindow.isVisible();
    const bossHideAllPagesMuted = getPageWebContents().every((contents) => contents.isAudioMuted());
    toggleBossMode();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const bossHideWindowRestored = mainWindow.isVisible() && appMode === "web";
    const bossHideRestoredBounds = mainWindow.getNormalBounds();
    const bossHideAudioRestored = !bossInitiallyUnmutedTab.view.webContents.isAudioMuted();
    settings.bossKeyAction = "ad";

    smokeStep = "加载拒绝 iframe 的页面";
    const firstTab = getActiveTab();
    await firstTab.view.webContents.loadURL(page1.url);
    updateBrowserViewsVisibility();
    await new Promise((resolve) => setTimeout(resolve, 100));
    smokeStep = "检查远程页面沙箱";
    const security = await firstTab.view.webContents.executeJavaScript(`({
      requireType: typeof require,
      processType: typeof process,
      exposedApiType: typeof window.miniBrowser
    })`);
    smokeStep = "验证新窗口路由到标签页";
    const newTabRect = await firstTab.view.webContents.executeJavaScript(`(() => {
      const rect = document.querySelector("#newtab").getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    firstTab.view.webContents.sendInputEvent({ type: "mouseDown", x: newTabRect.x, y: newTabRect.y, button: "left", clickCount: 1 });
    firstTab.view.webContents.sendInputEvent({ type: "mouseUp", x: newTabRect.x, y: newTabRect.y, button: "left", clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const routedPopupTab = getActiveTab();
    const popupRoutedToTab = tabs.length === 2 && routedPopupTab.id !== firstTab.id && getTabUrl(routedPopupTab).endsWith("/popup");
    const popupChildWindowCount = childWindows.size;
    if (routedPopupTab.id !== firstTab.id) closeBrowserTab(routedPopupTab.id, { persist: false });
    switchTab(firstTab.id, { persist: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    smokeStep = "验证鼠标锁定与强制释放";
    firstTab.view.webContents.focus();
    firstTab.view.webContents.sendInputEvent({ type: "mouseDown", x: 70, y: 22, button: "left", clickCount: 1 });
    firstTab.view.webContents.sendInputEvent({ type: "mouseUp", x: 70, y: 22, button: "left", clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const pointerLockAcquired = await firstTab.view.webContents.executeJavaScript("Boolean(document.pointerLockElement)");
    const pointerLockReleased = await releaseMouseCapture({ focusUi: false, notice: false });
    const captureStateCleared = !(await firstTab.view.webContents.executeJavaScript("Boolean(document.pointerLockElement)")) && !firstTab.mouseCaptured;
    smokeStep = "创建并加载第二个标签页";
    const created = createBrowserTab("", { activate: true, load: false, persist: false });
    if (!created.ok) throw new Error(created.error);
    const secondTab = created.tab;
    await secondTab.view.webContents.loadURL(page2.url);
    const secondTabUrl = secondTab.view.webContents.getURL();
    const tabCount = tabs.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await captureMainWindow(tabsScreenshot);
    smokeStep = "验证标签快捷键";
    await sendSmokeShortcut(secondTab.view.webContents, "T", ["control"]);
    const shortcutCreatedTab = tabs.length === 3;
    const shortcutTab = getActiveTab();
    await shortcutTab.view.webContents.loadURL(page1.url);
    updateBrowserViewsVisibility();
    await sendSmokeShortcut(shortcutTab.view.webContents, "W", ["control"]);
    const shortcutClosedTab = tabs.length === 2;
    await sendSmokeShortcut(secondTab.view.webContents, "Tab", ["control"]);
    const shortcutSwitchedToFirst = activeTabId === firstTab.id;
    switchTab(firstTab.id, { persist: false });
    smokeStep = "加载第一标签第二页";
    await firstTab.view.webContents.loadURL(page2.url);
    const canGoBack = firstTab.view.webContents.navigationHistory.canGoBack();
    smokeStep = "验证后退导航";
    const backFinished = waitForEvent(firstTab.view.webContents, "did-finish-load");
    firstTab.view.webContents.navigationHistory.goBack();
    await backFinished;
    const returnedUrl = firstTab.view.webContents.getURL();
    smokeStep = "验证远程页面内容";
    const returnedPage = await firstTab.view.webContents.executeJavaScript(`({
      title: document.title,
      marker: document.querySelector("#marker")?.textContent || ""
    })`);
    settings.tabs = tabs.map((tab) => getTabUrl(tab));
    settings.activeTabIndex = tabs.findIndex((tab) => tab.id === activeTabId);
    settings.lastUrl = getTabUrl(getActiveTab());
    settings = await settingsStore.save(settings);
    await fs.writeFile(resultPath, JSON.stringify({
      ok: true,
      page1: page1.url,
      page2: page2.url,
      tabCount,
      secondTabUrl,
      activeTabId,
      shortcutCreatedTab,
      shortcutClosedTab,
      shortcutSwitchedToFirst,
      canGoBack,
      returnedUrl,
      requireType: security.requireType,
      processType: security.processType,
      exposedApiType: security.exposedApiType,
      popupRoutedToTab,
      popupChildWindowCount,
      pointerLockAcquired,
      pointerLockReleased,
      captureStateCleared,
      returnedTitle: returnedPage.title,
      returnedMarker: returnedPage.marker,
      permissionPolicy: "deny-all-except-active-pointer-lock",
      mergedBrowserControls,
      controlsHidden,
      controlsHiddenPersisted,
      controlsRestored,
      controlsVisiblePersisted,
      controlsExpandedBrowserTop,
      controlsCollapsedBrowserTop,
      controlsRestoredBrowserTop,
      homePresetLabels,
      settingsTabOpen,
      settingsTabClosed,
      importedBookmarkVisible,
      mouseTransparencyOriginalOpacity,
      mouseTransparencyOutsideOpacity,
      mouseTransparencyRestoredOpacity,
      mouseTransparencyForcedTop,
      builtinAdSource: adUiState.source,
      builtinAdCounter: adUiState.counter,
      bossOriginalBounds,
      bossOriginalMinimumSize,
      bossConfiguredSize,
      bossTargetBounds,
      bossAdBounds,
      bossAdMinimumSize,
      bossRestoredBounds,
      bossRestoredMinimumSize,
      bossOriginalOpacity,
      bossAdOpacity,
      bossAdAlwaysOnTop,
      bossAdIgnoredMouseTransparency,
      bossRestoredOpacity,
      bossRestoredAlwaysOnTop,
      bossAdAllPagesMuted,
      bossAudioRestored,
      bossCloseButtonVisible: adUiState.closeButtonVisible,
      bossAdCloseHidWindow,
      bossAdCloseKeptMode,
      bossHideSettingSelected,
      bossHideModeActive,
      bossHideWindowHidden,
      bossHideAllPagesMuted,
      bossHideWindowRestored,
      bossHideOriginalBounds,
      bossHideRestoredBounds,
      bossHideAudioRestored,
      customAdSourceIsDataUrl: customAdUiState.source.startsWith("data:image/"),
      customAdCounter: customAdUiState.counter,
      uiScreenshot,
      settingsScreenshot,
      adScreenshot,
      tabsScreenshot,
    }, null, 2));
    settings.closeBehavior = "quit";
    closeMainWindow();
    setTimeout(() => app.exit(1), 1000);
  } catch (error) {
    if (resultPath) {
      await fs.mkdir(path.dirname(resultPath), { recursive: true }).catch(() => {});
      await fs.writeFile(resultPath, JSON.stringify({
        ok: false,
        step: smokeStep,
        error: error.stack || error.message,
      }, null, 2)).catch(() => {});
    }
    app.exit(1);
  }
}

app.on("second-instance", () => {
  if (!hasUsableMainWindow()) return;
  showMainWindow();
});

app.on("before-quit", () => {
  quitting = true;
  clearTimeout(saveBoundsTimer);
  clearInterval(mouseTransparencyTimer);
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (IS_SMOKE_TEST) app.quit();
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  settingsStore = new SettingsStore(app.getPath("userData"));
  settings = await settingsStore.load();
  const safeImagePaths = getSafeCustomImagePaths();
  settings.adConfig = {
    mode: settings.adConfig.mode === "custom" && safeImagePaths.length ? "custom" : "builtin",
    customImagePaths: safeImagePaths,
  };
  browserSession = session.fromPartition(REMOTE_PARTITION, { cache: true });
  configureSessionSecurity();
  configureDownloads();
  registerIpcHandlers();
  createMainWindow();
  syncMouseTransparencyTracking();
  registerMouseReleaseKey();
  registerInitialBossKey();
  if (!IS_SMOKE_TEST) createTray();
});
