"use strict";

const api = window.miniBrowser;
const $ = (selector) => document.querySelector(selector);

const elements = {
  pageTitle: $(".page-title"),
  pinButton: $(".pin-button"),
  minimizeButton: $(".minimize-button"),
  closeButton: $(".close-button"),
  mouseReleaseButton: $(".mouse-release-button"),
  controlsToggleButton: $(".controls-toggle-button"),
  tabStrip: $(".tab-strip"),
  newTabButton: $(".new-tab-button"),
  backButton: $(".back-button"),
  forwardButton: $(".forward-button"),
  reloadButton: $(".reload-button"),
  addressForm: $(".address-form"),
  addressInput: $(".address-input"),
  externalButton: $(".external-button"),
  settingsButton: $(".settings-button"),
  startScreen: $(".start-screen"),
  quickSites: $(".quick-sites"),
  errorBanner: $(".error-banner"),
  errorMessage: $(".error-message"),
  errorRetry: $(".error-retry"),
  settingsDone: $(".settings-done"),
  opacityRange: $(".opacity-range"),
  opacityOutput: $(".opacity-output"),
  adWidthInput: $(".ad-width-input"),
  adHeightInput: $(".ad-height-input"),
  shortcutRecorder: $(".shortcut-recorder"),
  shortcutRegistration: $(".shortcut-registration"),
  shortcutStatus: $(".shortcut-status"),
  bossAdRadio: $(".boss-ad-radio"),
  bossHideRadio: $(".boss-hide-radio"),
  topCheckbox: $(".top-checkbox"),
  topHelp: $(".top-help"),
  autostartCheckbox: $(".autostart-checkbox"),
  autostartHelp: $(".autostart-help"),
  mouseTransparencyCheckbox: $(".mouse-transparency-checkbox"),
  closeTrayRadio: $(".close-tray-radio"),
  closeQuitRadio: $(".close-quit-radio"),
  importBookmarks: $(".import-bookmarks"),
  removeBookmarks: $(".remove-bookmarks"),
  bookmarkCount: $(".bookmark-count"),
  bookmarkStatus: $(".bookmark-status"),
  builtinRadio: $(".builtin-radio"),
  customRadio: $(".custom-radio"),
  chooseImage: $(".choose-image"),
  adPreview: $(".ad-preview"),
  adCarouselImage: $(".ad-carousel-image"),
  adCloseButton: $(".ad-close-button"),
  adCounter: $(".ad-counter"),
  removeImage: $(".remove-image"),
  imageStatus: $(".image-status"),
  quitButton: $(".quit-button"),
  toast: $(".toast"),
};

let appState = null;
let browserState = { url: "", title: "", loading: false, canGoBack: false, canGoForward: false, error: "", tabs: [], activeTabId: null, maxTabs: 12, mouseCaptured: false, mouseReleaseKey: "Alt+Shift+M", mouseReleaseRegistered: false };
let settingsOpen = false;
let recordingShortcut = false;
let opacityTimer = null;
let toastTimer = null;
let adCarouselTimer = null;
let adSlideIndex = 0;

const AD_CAROUSEL_INTERVAL_MS = 3500;
const BUILTIN_AD_SOURCES = Array.from(
  { length: 10 },
  (_unused, index) => `../../build/ads/ad-${String(index + 1).padStart(2, "0")}.png`
);
const PRESET_BOOKMARKS = [
  { title: "抖音", url: "https://www.douyin.com/", icon: "抖" },
  { title: "知乎", url: "https://www.zhihu.com/", icon: "知" },
  { title: "哔哩哔哩", url: "https://www.bilibili.com/", icon: "哔" },
  { title: "百度", url: "https://www.baidu.com/", icon: "百" },
  { title: "微博", url: "https://weibo.com/", icon: "微" },
];

function getAdSources() {
  const customSources = Array.isArray(appState?.adImageDataUrls) ? appState.adImageDataUrls : [];
  return appState?.settings?.adConfig?.mode === "custom" && customSources.length
    ? customSources
    : BUILTIN_AD_SOURCES;
}

function renderAdSlide({ reset = false } = {}) {
  const sources = getAdSources();
  if (reset || adSlideIndex >= sources.length) adSlideIndex = 0;
  elements.adCarouselImage.src = sources[adSlideIndex] || BUILTIN_AD_SOURCES[0];
  elements.adCounter.textContent = `${adSlideIndex + 1} / ${sources.length}`;
}

function stopAdCarousel() {
  clearInterval(adCarouselTimer);
  adCarouselTimer = null;
}

function startAdCarousel({ reset = false } = {}) {
  stopAdCarousel();
  renderAdSlide({ reset });
  const sources = getAdSources();
  if (sources.length < 2) return;
  adCarouselTimer = setInterval(() => {
    adSlideIndex = (adSlideIndex + 1) % getAdSources().length;
    renderAdSlide();
  }, AD_CAROUSEL_INTERVAL_MS);
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = String(message || "");
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2800);
}

function renderHomeBookmarks() {
  const imported = Array.isArray(appState?.settings?.bookmarks) ? appState.settings.bookmarks : [];
  const seen = new Set(PRESET_BOOKMARKS.map((bookmark) => bookmark.url));
  const bookmarks = [...PRESET_BOOKMARKS];
  for (const bookmark of imported) {
    if (!bookmark?.url || seen.has(bookmark.url)) continue;
    seen.add(bookmark.url);
    bookmarks.push(bookmark);
  }
  elements.quickSites.replaceChildren();
  for (const bookmark of bookmarks) {
    const shortcut = document.createElement("button");
    shortcut.className = "site-shortcut";
    shortcut.type = "button";
    shortcut.title = bookmark.url;
    const icon = document.createElement("strong");
    icon.textContent = bookmark.icon || String(bookmark.title || "网").slice(0, 1);
    const label = document.createElement("span");
    label.textContent = bookmark.title || bookmark.url;
    shortcut.append(icon, label);
    shortcut.addEventListener("click", async () => {
      const result = await api.navigate(bookmark.url);
      if (!result.ok) showToast(result.error);
    });
    elements.quickSites.append(shortcut);
  }
  elements.bookmarkCount.textContent = imported.length ? `已导入 ${imported.length} 个` : "使用内置预设";
  elements.removeBookmarks.classList.toggle("show", imported.length > 0);
}

function setSettingsOpen(value) {
  settingsOpen = Boolean(value);
  document.body.classList.toggle("settings-open", settingsOpen);
  elements.settingsButton.classList.toggle("active", settingsOpen);
  applyBrowserState(browserState);
  void api.setOverlayOpen(settingsOpen);
}

function renderTabs() {
  elements.tabStrip.replaceChildren();
  for (const tab of browserState.tabs || []) {
    const item = document.createElement("div");
    item.className = "browser-tab";
    item.classList.toggle("active", !settingsOpen && tab.id === browserState.activeTabId);
    item.classList.toggle("loading", Boolean(tab.loading));
    item.setAttribute("role", "tab");
    item.setAttribute("aria-selected", String(!settingsOpen && tab.id === browserState.activeTabId));

    const main = document.createElement("button");
    main.className = "tab-main";
    main.type = "button";
    main.title = tab.title || tab.url || "新标签页";
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title || "新标签页";
    main.append(title);
    main.addEventListener("click", () => {
      if (settingsOpen) setSettingsOpen(false);
      void api.switchTab(tab.id);
    });

    const close = document.createElement("button");
    close.className = "tab-close";
    close.type = "button";
    close.textContent = "×";
    close.title = `关闭 ${tab.title || "标签页"}`;
    close.setAttribute("aria-label", close.title);
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      void api.closeTab(tab.id);
    });

    item.append(main, close);
    elements.tabStrip.append(item);
  }
  if (settingsOpen) {
    const item = document.createElement("div");
    item.className = "browser-tab settings-tab active";
    item.setAttribute("role", "tab");
    item.setAttribute("aria-selected", "true");

    const main = document.createElement("button");
    main.className = "tab-main";
    main.type = "button";
    main.title = "应用设置";
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = "设置";
    main.append(title);

    const close = document.createElement("button");
    close.className = "tab-close";
    close.type = "button";
    close.textContent = "×";
    close.title = "关闭设置";
    close.setAttribute("aria-label", close.title);
    close.addEventListener("click", () => setSettingsOpen(false));

    item.append(main, close);
    elements.tabStrip.append(item);
  }
  elements.newTabButton.disabled = (browserState.tabs?.length || 0) >= (browserState.maxTabs || 12);
}

function applyBrowserState(nextState) {
  browserState = { ...browserState, ...(nextState || {}) };
  const inputFocused = document.activeElement === elements.addressInput;
  if (!inputFocused) elements.addressInput.value = browserState.url || "";
  elements.backButton.disabled = settingsOpen || !browserState.canGoBack;
  elements.forwardButton.disabled = settingsOpen || !browserState.canGoForward;
  elements.reloadButton.disabled = settingsOpen;
  elements.externalButton.disabled = settingsOpen;
  elements.addressInput.disabled = settingsOpen;
  elements.reloadButton.textContent = browserState.loading ? "×" : "↻";
  elements.reloadButton.title = browserState.loading ? "停止加载" : "刷新";
  elements.pageTitle.textContent = settingsOpen ? "应用设置" : (browserState.mouseCaptured
    ? `鼠标已锁定 · ${browserState.mouseReleaseKey} 释放`
    : (browserState.title || (browserState.url ? "正在浏览" : "未打开网页")));
  elements.startScreen.classList.toggle("hidden", settingsOpen || Boolean(browserState.url));
  elements.errorBanner.classList.toggle("show", Boolean(browserState.error));
  elements.errorMessage.textContent = browserState.error || "";
  document.body.classList.toggle("loading", Boolean(browserState.loading));
  document.body.classList.toggle("mouse-captured", Boolean(browserState.mouseCaptured));
  elements.mouseReleaseButton.classList.toggle("active", Boolean(browserState.mouseCaptured));
  elements.mouseReleaseButton.title = browserState.mouseReleaseRegistered
    ? `释放鼠标 (${browserState.mouseReleaseKey})`
    : "释放鼠标（全局快捷键注册失败时请按 Esc）";
  renderTabs();
}

function applyAppState(nextState) {
  if (!nextState) return;
  appState = nextState;
  const { settings } = nextState;
  elements.opacityRange.value = String(settings.opacity);
  elements.opacityOutput.textContent = `${settings.opacity}%`;
  elements.adWidthInput.value = String(settings.adWindowSize?.width || 440);
  elements.adHeightInput.value = String(settings.adWindowSize?.height || 586);
  elements.topCheckbox.checked = settings.alwaysOnTop;
  elements.topCheckbox.disabled = Boolean(settings.transparentWhenMouseOutside);
  elements.topHelp.textContent = settings.transparentWhenMouseOutside ? "移出透明开启时必须保持置顶" : "让窗口浮在其他应用上方";
  elements.pinButton.classList.toggle("active", settings.alwaysOnTop);
  elements.shortcutRecorder.textContent = recordingShortcut ? "请按新的组合键…" : settings.bossKey;
  elements.shortcutRegistration.textContent = nextState.shortcutRegistered ? "已注册" : "注册失败";
  elements.shortcutRegistration.classList.toggle("failed", !nextState.shortcutRegistered);
  elements.bossAdRadio.checked = settings.bossKeyAction !== "hide";
  elements.bossHideRadio.checked = settings.bossKeyAction === "hide";
  elements.autostartCheckbox.checked = settings.autoStart;
  elements.autostartCheckbox.disabled = !nextState.autoStartSupported;
  elements.autostartHelp.textContent = nextState.autoStartSupported ? "默认关闭，可随时更改" : "开发模式不修改系统启动项";
  elements.mouseTransparencyCheckbox.checked = Boolean(settings.transparentWhenMouseOutside);
  const controlsHidden = Boolean(settings.controlsHidden);
  document.body.classList.toggle("controls-hidden", controlsHidden);
  elements.controlsToggleButton.textContent = controlsHidden ? "▾" : "▴";
  elements.controlsToggleButton.title = controlsHidden ? "显示标签与操作栏" : "隐藏标签与操作栏";
  elements.controlsToggleButton.setAttribute("aria-label", elements.controlsToggleButton.title);
  elements.closeTrayRadio.checked = settings.closeBehavior !== "quit";
  elements.closeQuitRadio.checked = settings.closeBehavior === "quit";
  renderHomeBookmarks();

  const customImages = Array.isArray(nextState.adImageDataUrls) ? nextState.adImageDataUrls : [];
  const hasImage = settings.adConfig.hasCustomImage && customImages.length > 0;
  elements.builtinRadio.checked = settings.adConfig.mode !== "custom";
  elements.customRadio.checked = settings.adConfig.mode === "custom" && hasImage;
  elements.adPreview.src = hasImage ? customImages[0] : "";
  elements.adPreview.classList.toggle("show", hasImage);
  elements.removeImage.classList.toggle("show", hasImage);
  elements.imageStatus.textContent = hasImage ? `已选择 ${customImages.length} 张图片` : "";
  document.body.classList.toggle("ad-mode", nextState.mode === "ad");
  if (nextState.mode === "ad") startAdCarousel({ reset: true });
  else stopAdCarousel();
  if (nextState.mode === "ad") setSettingsOpen(false);
  if (nextState.browser) applyBrowserState(nextState.browser);
}

function keyToAccelerator(event) {
  if (event.metaKey) return null;
  const parts = [];
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (!parts.length) return null;

  const code = event.code;
  let key = "";
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F(?:[1-9]|1[0-2])$/.test(code)) key = code;
  else {
    key = {
      Space: "Space", Tab: "Tab", Home: "Home", End: "End", Insert: "Insert", Delete: "Delete",
      ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    }[code] || "";
  }
  return key ? [...parts, key].join("+") : null;
}

function cancelShortcutRecording(message = "") {
  recordingShortcut = false;
  elements.shortcutRecorder.classList.remove("recording");
  elements.shortcutRecorder.textContent = appState?.settings.bossKey || "Alt+Shift+A";
  elements.shortcutStatus.textContent = message;
}

async function recordShortcut(event) {
  if (!recordingShortcut) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.key === "Escape") {
    cancelShortcutRecording("已取消");
    return;
  }
  if (/^(Control|Alt|Shift|Meta)/.test(event.key)) {
    elements.shortcutStatus.textContent = "请继续按一个普通按键";
    return;
  }
  const accelerator = keyToAccelerator(event);
  if (!accelerator) {
    elements.shortcutStatus.textContent = "请使用 Ctrl、Alt 或 Shift 加字母、数字或功能键";
    return;
  }
  const result = await api.setBossKey(accelerator);
  if (!result.ok) {
    elements.shortcutStatus.textContent = result.error || "快捷键设置失败";
    return;
  }
  cancelShortcutRecording(`已设置为 ${result.bossKey}`);
}

elements.addressForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await api.navigate(elements.addressInput.value);
  elements.addressInput.classList.toggle("invalid", !result.ok);
  if (!result.ok) showToast(result.error);
  else elements.addressInput.value = result.url;
});
elements.addressInput.addEventListener("input", () => elements.addressInput.classList.remove("invalid"));
elements.newTabButton.addEventListener("click", async () => {
  if (settingsOpen) setSettingsOpen(false);
  const result = await api.createTab();
  if (!result.ok) return showToast(result.error);
  elements.addressInput.focus();
});
elements.backButton.addEventListener("click", () => void api.goBack());
elements.forwardButton.addEventListener("click", () => void api.goForward());
elements.reloadButton.addEventListener("click", () => {
  if (!browserState.url) return showToast("请先输入网址");
  void (browserState.loading ? api.stop() : api.reload());
});
elements.externalButton.addEventListener("click", async () => {
  const result = await api.openExternal(browserState.url || elements.addressInput.value);
  if (!result.ok) showToast(result.error);
});
elements.errorRetry.addEventListener("click", () => void api.reload());
elements.pinButton.addEventListener("click", () => void api.toggleAlwaysOnTop());
elements.controlsToggleButton.addEventListener("click", () => {
  void api.updateSettings({ controlsHidden: !Boolean(appState?.settings?.controlsHidden) });
});
elements.minimizeButton.addEventListener("click", () => void api.minimize());
elements.closeButton.addEventListener("click", () => void api.closeToTray());
elements.adCloseButton.addEventListener("click", () => void api.closeToTray());
elements.mouseReleaseButton.addEventListener("click", () => void api.releaseMouse());
elements.settingsButton.addEventListener("click", () => setSettingsOpen(true));
elements.settingsDone.addEventListener("click", () => setSettingsOpen(false));

elements.opacityRange.addEventListener("input", () => {
  const value = Number(elements.opacityRange.value);
  elements.opacityOutput.textContent = `${value}%`;
  clearTimeout(opacityTimer);
  opacityTimer = setTimeout(() => void api.updateSettings({ opacity: value }), 100);
});
function updateAdWindowSize() {
  void api.updateSettings({
    adWindowSize: {
      width: Number(elements.adWidthInput.value),
      height: Number(elements.adHeightInput.value),
    },
  });
}
elements.adWidthInput.addEventListener("change", updateAdWindowSize);
elements.adHeightInput.addEventListener("change", updateAdWindowSize);
elements.topCheckbox.addEventListener("change", () => void api.updateSettings({ alwaysOnTop: elements.topCheckbox.checked }));
elements.autostartCheckbox.addEventListener("change", () => void api.updateSettings({ autoStart: elements.autostartCheckbox.checked }));
elements.mouseTransparencyCheckbox.addEventListener("change", () => {
  void api.updateSettings({ transparentWhenMouseOutside: elements.mouseTransparencyCheckbox.checked });
});
elements.closeTrayRadio.addEventListener("change", () => {
  if (elements.closeTrayRadio.checked) void api.updateSettings({ closeBehavior: "tray" });
});
elements.closeQuitRadio.addEventListener("change", () => {
  if (elements.closeQuitRadio.checked) void api.updateSettings({ closeBehavior: "quit" });
});
elements.importBookmarks.addEventListener("click", async () => {
  const result = await api.importBookmarks();
  elements.bookmarkStatus.textContent = result.ok ? `已导入 ${result.count} 个书签` : (result.canceled ? "" : result.error);
  if (result.ok && result.state) applyAppState(result.state);
});
elements.removeBookmarks.addEventListener("click", async () => {
  const result = await api.removeBookmarks();
  elements.bookmarkStatus.textContent = result.ok ? "已清除导入书签" : result.error;
  if (result.ok && result.state) applyAppState(result.state);
});

elements.shortcutRecorder.addEventListener("click", () => {
  recordingShortcut = !recordingShortcut;
  elements.shortcutRecorder.classList.toggle("recording", recordingShortcut);
  elements.shortcutRecorder.textContent = recordingShortcut ? "请按新的组合键…" : appState.settings.bossKey;
  elements.shortcutStatus.textContent = recordingShortcut ? "按 Esc 取消" : "";
});
elements.bossAdRadio.addEventListener("change", () => {
  if (elements.bossAdRadio.checked) void api.updateSettings({ bossKeyAction: "ad" });
});
elements.bossHideRadio.addEventListener("change", () => {
  if (elements.bossHideRadio.checked) void api.updateSettings({ bossKeyAction: "hide" });
});
document.addEventListener("keydown", (event) => void recordShortcut(event), true);
document.addEventListener("keydown", (event) => {
  if (!event.ctrlKey || event.altKey || event.metaKey || recordingShortcut) return;
  const key = event.key.toLowerCase();
  if (key === "t") {
    event.preventDefault();
    void elements.newTabButton.click();
  } else if (key === "w") {
    event.preventDefault();
    if (settingsOpen) setSettingsOpen(false);
    else if (browserState.activeTabId !== null) void api.closeTab(browserState.activeTabId);
  } else if (key === "tab" && (settingsOpen || (browserState.tabs?.length || 0) > 1)) {
    event.preventDefault();
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    const index = browserState.tabs.findIndex((tab) => tab.id === browserState.activeTabId);
    const offset = event.shiftKey ? -1 : 1;
    const next = (index + offset + browserState.tabs.length) % browserState.tabs.length;
    void api.switchTab(browserState.tabs[next].id);
  }
});

elements.builtinRadio.addEventListener("change", () => {
  if (elements.builtinRadio.checked) void api.updateSettings({ adMode: "builtin" });
});
elements.customRadio.addEventListener("change", async () => {
  if (!elements.customRadio.checked) return;
  if (!appState.settings.adConfig.hasCustomImage) {
    const result = await api.chooseAdImage();
    if (!result.ok && !result.canceled) elements.imageStatus.textContent = result.error;
    return;
  }
  void api.updateSettings({ adMode: "custom" });
});
elements.chooseImage.addEventListener("click", async () => {
  const result = await api.chooseAdImage();
  elements.imageStatus.textContent = result.ok ? `已保存 ${result.count} 张轮播图片` : (result.canceled ? "" : result.error);
  if (result.ok && result.state) applyAppState(result.state);
});
elements.removeImage.addEventListener("click", async () => {
  const result = await api.removeAdImage();
  elements.imageStatus.textContent = result.ok ? "自定义图片已全部删除" : result.error;
  if (result.ok && result.state) applyAppState(result.state);
});
elements.quitButton.addEventListener("click", () => void api.quit());

api.onBrowserState(applyBrowserState);
api.onAppState(applyAppState);
api.onMode(({ mode }) => {
  if (!appState) return;
  appState.mode = mode;
  document.body.classList.toggle("ad-mode", mode === "ad");
  if (mode === "ad") {
    setSettingsOpen(false);
    startAdCarousel({ reset: true });
  } else {
    stopAdCarousel();
  }
});
api.onNotice(({ message }) => showToast(message));

void api.bootstrap()
  .then(applyAppState)
  .catch((error) => showToast(`初始化失败：${error.message}`));
