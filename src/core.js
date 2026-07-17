"use strict";

const MAX_URL_LENGTH = 2048;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_CUSTOM_AD_IMAGES = 20;
const MAX_TABS = 12;
const BOSS_WINDOW_WIDTH = 440;
const BOSS_WINDOW_HEIGHT = 586;
const BOSS_WINDOW_MARGIN = 24;
const MIN_BOSS_WINDOW_WIDTH = 200;
const MIN_BOSS_WINDOW_HEIGHT = 200;
const MAX_IMPORTED_BOOKMARKS = 100;
const MAX_BOOKMARK_FILE_BYTES = 1024 * 1024;

const DEFAULT_SETTINGS = Object.freeze({
  version: 3,
  windowBounds: Object.freeze({ x: null, y: null, width: 480, height: 680 }),
  opacity: 90,
  alwaysOnTop: true,
  transparentWhenMouseOutside: false,
  controlsHidden: false,
  closeBehavior: "tray",
  adWindowSize: Object.freeze({ width: BOSS_WINDOW_WIDTH, height: BOSS_WINDOW_HEIGHT }),
  bossKey: "Alt+Shift+A",
  bossKeyAction: "ad",
  autoStart: false,
  lastUrl: "",
  tabs: Object.freeze([""]),
  activeTabIndex: 0,
  bookmarks: Object.freeze([]),
  adConfig: Object.freeze({ mode: "builtin", customImagePaths: Object.freeze([]) }),
});

const BLOCKED_SHORTCUTS = new Set([
  "ALT+F4",
  "CONTROL+F4",
  "CONTROL+L",
  "CONTROL+N",
  "CONTROL+R",
  "CONTROL+T",
  "CONTROL+W",
  "CONTROL+SHIFT+T",
  "CONTROL+SHIFT+W",
]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeUrl(rawValue) {
  const raw = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!raw) return { ok: false, error: "请输入网址" };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, error: "网址不能超过 2048 个字符" };

  const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) {
      return { ok: false, error: "仅支持 HTTP 或 HTTPS 网页" };
    }
    return { ok: true, url: parsed.href };
  } catch {
    return { ok: false, error: "网址格式不正确" };
  }
}

function isAllowedRemoteUrl(rawValue) {
  return normalizeUrl(rawValue).ok;
}

function decodeHtmlEntities(value) {
  return String(value || "").replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|quot|apos|lt|gt));/gi, (match, decimal, hex, named) => {
    const codePoint = decimal ? Number(decimal) : (hex ? Number.parseInt(hex, 16) : null);
    if (codePoint !== null) return codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    return { amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">" }[named.toLowerCase()];
  });
}

function sanitizeBookmarks(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const bookmarks = [];
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const normalized = normalizeUrl(item.url);
    if (!normalized.ok || seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    const title = String(item.title || "").replace(/\s+/g, " ").trim().slice(0, 40);
    bookmarks.push({ title: title || new URL(normalized.url).hostname, url: normalized.url });
    if (bookmarks.length >= MAX_IMPORTED_BOOKMARKS) break;
  }
  return bookmarks;
}

function parseBookmarkHtml(html) {
  const bookmarks = [];
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || "").matchAll(anchorPattern)) {
    bookmarks.push({
      url: decodeHtmlEntities(match[2]),
      title: decodeHtmlEntities(match[3].replace(/<[^>]*>/g, " ")),
    });
  }
  return sanitizeBookmarks(bookmarks);
}

function sanitizeBounds(value) {
  const source = value && typeof value === "object" ? value : {};
  const width = clamp(Math.round(Number(source.width) || 480), 360, 4096);
  const height = clamp(Math.round(Number(source.height) || 680), 320, 4096);
  return {
    x: Number.isFinite(Number(source.x)) ? Math.round(Number(source.x)) : null,
    y: Number.isFinite(Number(source.y)) ? Math.round(Number(source.y)) : null,
    width,
    height,
  };
}

function constrainBounds(bounds, workArea) {
  const source = sanitizeBounds(bounds);
  const area = workArea && typeof workArea === "object"
    ? workArea
    : { x: 0, y: 0, width: 1920, height: 1080 };
  const width = Math.min(source.width, Math.max(360, area.width));
  const height = Math.min(source.height, Math.max(320, area.height));
  const defaultX = area.x + area.width - width - 24;
  const defaultY = area.y + area.height - height - 24;
  const maxX = area.x + Math.max(0, area.width - width);
  const maxY = area.y + Math.max(0, area.height - height);

  return {
    x: clamp(source.x ?? defaultX, area.x, maxX),
    y: clamp(source.y ?? defaultY, area.y, maxY),
    width,
    height,
  };
}

function sanitizeAdWindowSize(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    width: clamp(Math.round(Number(source.width) || BOSS_WINDOW_WIDTH), MIN_BOSS_WINDOW_WIDTH, 4096),
    height: clamp(Math.round(Number(source.height) || BOSS_WINDOW_HEIGHT), MIN_BOSS_WINDOW_HEIGHT, 4096),
  };
}

function getBossWindowBounds(workArea, windowSize) {
  const area = workArea && typeof workArea === "object"
    ? workArea
    : { x: 0, y: 0, width: 1920, height: 1080 };
  const size = sanitizeAdWindowSize(windowSize);
  return {
    x: area.x + Math.max(0, area.width - size.width - BOSS_WINDOW_MARGIN),
    y: area.y + Math.max(0, area.height - size.height - BOSS_WINDOW_MARGIN),
    width: size.width,
    height: size.height,
  };
}

function normalizeAccelerator(rawValue) {
  if (typeof rawValue !== "string") return null;
  const tokens = rawValue
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) return null;

  const modifierMap = new Map([
    ["CTRL", "Control"],
    ["CONTROL", "Control"],
    ["ALT", "Alt"],
    ["SHIFT", "Shift"],
  ]);
  const modifiers = [];
  let key = "";

  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (modifierMap.has(upper)) {
      const normalized = modifierMap.get(upper);
      if (modifiers.includes(normalized)) return null;
      modifiers.push(normalized);
      continue;
    }
    if (key) return null;
    if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|SPACE|TAB|HOME|END|INSERT|DELETE|UP|DOWN|LEFT|RIGHT)$/.test(upper)) {
      return null;
    }
    key = upper.length === 1 ? upper : upper[0] + upper.slice(1).toLowerCase();
  }

  if (!modifiers.length || !key) return null;
  const order = ["Control", "Alt", "Shift"];
  modifiers.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const accelerator = [...modifiers, key].join("+");
  const signature = [...modifiers.map((item) => item.toUpperCase()), key.toUpperCase()].join("+");
  if (BLOCKED_SHORTCUTS.has(signature)) return null;
  return accelerator;
}

function sanitizeSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  const ad = source.adConfig && typeof source.adConfig === "object" ? source.adConfig : {};
  const lastUrl = normalizeUrl(source.lastUrl);
  const legacyImagePath = typeof ad.customImagePath === "string" ? ad.customImagePath : "";
  const imagePathSource = Array.isArray(ad.customImagePaths)
    ? ad.customImagePaths
    : (legacyImagePath ? [legacyImagePath] : []);
  const customImagePaths = [...new Set(imagePathSource
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim()))]
    .slice(0, MAX_CUSTOM_AD_IMAGES);
  const bossKey = normalizeAccelerator(source.bossKey) || DEFAULT_SETTINGS.bossKey;
  const transparentWhenMouseOutside = Boolean(source.transparentWhenMouseOutside);
  const sourceTabs = Array.isArray(source.tabs) ? source.tabs.slice(0, MAX_TABS) : [];
  const tabs = sourceTabs.map((item) => {
    if (item === "") return "";
    const normalized = normalizeUrl(item);
    return normalized.ok ? normalized.url : "";
  });
  if (!tabs.length) tabs.push(lastUrl.ok ? lastUrl.url : "");
  const activeTabIndex = clamp(Math.round(Number(source.activeTabIndex) || 0), 0, tabs.length - 1);

  return {
    version: 3,
    windowBounds: sanitizeBounds(source.windowBounds),
    opacity: clamp(Math.round(Number(source.opacity) || 90), 30, 100),
    alwaysOnTop: transparentWhenMouseOutside || source.alwaysOnTop !== false,
    transparentWhenMouseOutside,
    controlsHidden: Boolean(source.controlsHidden),
    closeBehavior: source.closeBehavior === "quit" ? "quit" : "tray",
    adWindowSize: sanitizeAdWindowSize(source.adWindowSize),
    bossKey,
    bossKeyAction: source.bossKeyAction === "hide" ? "hide" : "ad",
    autoStart: Boolean(source.autoStart),
    lastUrl: lastUrl.ok ? lastUrl.url : "",
    tabs,
    activeTabIndex,
    bookmarks: sanitizeBookmarks(source.bookmarks),
    adConfig: {
      mode: ad.mode === "custom" && customImagePaths.length ? "custom" : "builtin",
      customImagePaths,
    },
  };
}

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null;
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) return { mime: "image/png", extension: ".png" };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", extension: ".jpg" };
  }
  if (
    buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) return { mime: "image/webp", extension: ".webp" };
  return null;
}

function createBossSnapshot({ visible, minimized }) {
  return { visible: Boolean(visible), minimized: Boolean(minimized) };
}

function getBossRestoreAction(snapshot) {
  if (!snapshot?.visible) return "hide";
  if (snapshot.minimized) return "minimize";
  return "show";
}

module.exports = {
  BLOCKED_SHORTCUTS,
  BOSS_WINDOW_HEIGHT,
  BOSS_WINDOW_WIDTH,
  DEFAULT_SETTINGS,
  MAX_CUSTOM_AD_IMAGES,
  MAX_BOOKMARK_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMPORTED_BOOKMARKS,
  MAX_TABS,
  MIN_BOSS_WINDOW_HEIGHT,
  MIN_BOSS_WINDOW_WIDTH,
  clamp,
  constrainBounds,
  createBossSnapshot,
  detectImageType,
  getBossWindowBounds,
  getBossRestoreAction,
  isAllowedRemoteUrl,
  normalizeAccelerator,
  normalizeUrl,
  parseBookmarkHtml,
  sanitizeAdWindowSize,
  sanitizeBookmarks,
  sanitizeBounds,
  sanitizeSettings,
};
