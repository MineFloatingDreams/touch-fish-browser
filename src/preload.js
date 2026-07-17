"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  if (typeof callback !== "function") throw new TypeError("callback 必须是函数");
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("miniBrowser", Object.freeze({
  bootstrap: () => ipcRenderer.invoke("app:bootstrap"),
  navigate: (url) => ipcRenderer.invoke("browser:navigate", url),
  goBack: () => ipcRenderer.invoke("browser:back"),
  goForward: () => ipcRenderer.invoke("browser:forward"),
  reload: () => ipcRenderer.invoke("browser:reload"),
  stop: () => ipcRenderer.invoke("browser:stop"),
  openExternal: (url) => ipcRenderer.invoke("browser:external", url),
  createTab: (url = "") => ipcRenderer.invoke("tabs:create", url),
  switchTab: (tabId) => ipcRenderer.invoke("tabs:switch", tabId),
  closeTab: (tabId) => ipcRenderer.invoke("tabs:close", tabId),
  releaseMouse: () => ipcRenderer.invoke("mouse:release"),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  closeToTray: () => ipcRenderer.invoke("window:close"),
  toggleAlwaysOnTop: () => ipcRenderer.invoke("window:toggle-top"),
  setOverlayOpen: (value) => ipcRenderer.invoke("ui:set-overlay", Boolean(value)),
  updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
  setBossKey: (value) => ipcRenderer.invoke("settings:set-boss-key", value),
  chooseAdImage: () => ipcRenderer.invoke("ad:choose"),
  removeAdImage: () => ipcRenderer.invoke("ad:remove"),
  importBookmarks: () => ipcRenderer.invoke("bookmarks:import"),
  removeBookmarks: () => ipcRenderer.invoke("bookmarks:remove"),
  toggleBossMode: () => ipcRenderer.invoke("boss:toggle"),
  quit: () => ipcRenderer.invoke("app:quit"),
  onBrowserState: (callback) => subscribe("browser:state", callback),
  onAppState: (callback) => subscribe("app:state", callback),
  onMode: (callback) => subscribe("app:mode", callback),
  onNotice: (callback) => subscribe("app:notice", callback),
}));
