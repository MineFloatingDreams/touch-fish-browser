const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_SETTINGS,
  MAX_CUSTOM_AD_IMAGES,
  MAX_TABS,
  normalizeUrl,
  parseBookmarkHtml,
  isAllowedRemoteUrl,
  sanitizeBounds,
  constrainBounds,
  normalizeAccelerator,
  sanitizeSettings,
  sanitizeAdWindowSize,
  detectImageType,
  createBossSnapshot,
  getBossWindowBounds,
  getBossRestoreAction
} = require("../src/core");

test("URL 会补全 HTTPS，且只接受 HTTP/HTTPS", () => {
  assert.deepEqual(normalizeUrl("example.com/path"), { ok: true, url: "https://example.com/path" });
  assert.deepEqual(normalizeUrl(" http://example.com "), { ok: true, url: "http://example.com/" });
  assert.equal(isAllowedRemoteUrl("https://example.com"), true);
  assert.match(normalizeUrl("javascript:alert(1)").error, /HTTP/);
  assert.match(normalizeUrl("file:///C:/Windows").error, /HTTP/);
  assert.match(normalizeUrl("data:text/plain,hello").error, /HTTP/);
  assert.match(normalizeUrl("a".repeat(2049)).error, /2048/);
});

test("窗口尺寸和位置被约束在工作区", () => {
  assert.deepEqual(sanitizeBounds({ x: 1, y: 2, width: 10, height: 9999 }), {
    x: 1,
    y: 2,
    width: 360,
    height: 4096
  });

  assert.deepEqual(
    constrainBounds(
      { x: -500, y: 3000, width: 500, height: 700 },
      { x: 0, y: 0, width: 1920, height: 1080 }
    ),
    { x: 0, y: 380, width: 500, height: 700 }
  );
});

test("老板键广告窗口固定在工作区右下角且尺寸为 440×586", () => {
  assert.deepEqual(
    getBossWindowBounds({ x: 100, y: 50, width: 1600, height: 900 }),
    { x: 1236, y: 340, width: 440, height: 586 }
  );
  assert.deepEqual(
    getBossWindowBounds({ x: 100, y: 50, width: 1600, height: 900 }, { width: 500, height: 600 }),
    { x: 1176, y: 326, width: 500, height: 600 }
  );
  assert.deepEqual(sanitizeAdWindowSize({ width: 20, height: 9999 }), { width: 200, height: 4096 });
});

test("老板键格式化并拒绝高风险组合", () => {
  assert.equal(normalizeAccelerator("shift+alt+a"), "Alt+Shift+A");
  assert.equal(normalizeAccelerator("Ctrl+Shift+F9"), "Control+Shift+F9");
  assert.equal(normalizeAccelerator("A"), null);
  assert.equal(normalizeAccelerator("Alt+F4"), null);
  assert.equal(normalizeAccelerator("Ctrl+L"), null);
  assert.equal(normalizeAccelerator("Alt+Shift"), null);
});

test("设置校验回退默认值并限制范围", () => {
  const settings = sanitizeSettings({
    opacity: 200,
    alwaysOnTop: false,
    bossKey: "Ctrl+Shift+B",
    lastUrl: "javascript:bad",
    adConfig: { type: "custom", customImagePath: 42 }
  });

  assert.equal(settings.opacity, 100);
  assert.equal(settings.alwaysOnTop, false);
  assert.equal(settings.transparentWhenMouseOutside, false);
  assert.equal(settings.controlsHidden, false);
  assert.equal(settings.closeBehavior, "tray");
  assert.deepEqual(settings.adWindowSize, { width: 440, height: 586 });
  assert.equal(settings.bossKey, "Control+Shift+B");
  assert.equal(settings.bossKeyAction, "ad");
  assert.equal(settings.lastUrl, "");
  assert.equal(settings.adConfig.mode, "builtin");
  assert.deepEqual(settings.adConfig.customImagePaths, []);
  assert.deepEqual(settings.tabs, [""]);
  assert.equal(settings.activeTabIndex, 0);
  assert.deepEqual(DEFAULT_SETTINGS.windowBounds, { x: null, y: null, width: 480, height: 680 });
  assert.equal(sanitizeSettings({ closeBehavior: "quit" }).closeBehavior, "quit");
  assert.equal(sanitizeSettings({ transparentWhenMouseOutside: true }).transparentWhenMouseOutside, true);
  assert.equal(sanitizeSettings({ transparentWhenMouseOutside: true, alwaysOnTop: false }).alwaysOnTop, true);
  assert.equal(sanitizeSettings({ controlsHidden: true }).controlsHidden, true);
  assert.deepEqual(sanitizeSettings({ adWindowSize: { width: 520, height: 640 } }).adWindowSize, { width: 520, height: 640 });
  assert.equal(sanitizeSettings({ bossKeyAction: "hide" }).bossKeyAction, "hide");
  assert.equal(sanitizeSettings({ bossKeyAction: "invalid" }).bossKeyAction, "ad");
});

test("广告设置兼容旧单图字段，并去重和限制轮播数量", () => {
  const migrated = sanitizeSettings({
    adConfig: { mode: "custom", customImagePath: " C:\\legacy\\ad.png " },
  });
  assert.equal(migrated.version, 3);
  assert.equal(migrated.adConfig.mode, "custom");
  assert.deepEqual(migrated.adConfig.customImagePaths, ["C:\\legacy\\ad.png"]);

  const manyPaths = Array.from({ length: 25 }, (_, index) => `C:\\ads\\${index}.png`);
  manyPaths.splice(3, 0, manyPaths[0]);
  const limited = sanitizeSettings({ adConfig: { mode: "custom", customImagePaths: manyPaths } });
  assert.equal(limited.adConfig.customImagePaths.length, MAX_CUSTOM_AD_IMAGES);
  assert.equal(new Set(limited.adConfig.customImagePaths).size, MAX_CUSTOM_AD_IMAGES);
});

test("浏览器书签 HTML 仅导入 HTTP/HTTPS 并按 URL 去重", () => {
  const bookmarks = parseBookmarkHtml(`
    <A HREF="https://www.zhihu.com/">知乎 &amp; 问答</A>
    <A HREF="https://www.zhihu.com/">重复</A>
    <A HREF="javascript:alert(1)">危险链接</A>
    <A HREF="bilibili.com">哔哩哔哩</A>
  `);
  assert.deepEqual(bookmarks, [
    { title: "知乎 & 问答", url: "https://www.zhihu.com/" },
    { title: "哔哩哔哩", url: "https://bilibili.com/" },
  ]);
});

test("标签页列表会校验 URL、限制数量并约束活动索引", () => {
  const settings = sanitizeSettings({
    tabs: ["example.com", "javascript:bad", ...Array.from({ length: 20 }, (_, index) => `https://example.com/${index}`)],
    activeTabIndex: 99,
  });
  assert.equal(settings.tabs.length, MAX_TABS);
  assert.equal(settings.tabs[0], "https://example.com/");
  assert.equal(settings.tabs[1], "");
  assert.equal(settings.activeTabIndex, MAX_TABS - 1);

  const migrated = sanitizeSettings({ lastUrl: "https://legacy.example/" });
  assert.deepEqual(migrated.tabs, ["https://legacy.example/"]);
});

test("广告图片按文件头识别，限制为 2 MB", () => {
  assert.deepEqual(detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), { mime: "image/png", extension: ".png" });
  assert.deepEqual(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), { mime: "image/jpeg", extension: ".jpg" });
  assert.deepEqual(detectImageType(Buffer.from("RIFFxxxxWEBP")), { mime: "image/webp", extension: ".webp" });
  assert.equal(detectImageType(Buffer.from("not-an-image")), null);
  assert.equal(detectImageType(Buffer.alloc(2 * 1024 * 1024 + 1)), null);
});

test("老板键恢复隐藏、最小化与普通窗口状态", () => {
  assert.deepEqual(
    getBossRestoreAction(createBossSnapshot({ visible: false, minimized: false, alwaysOnTop: true })),
    "hide"
  );
  assert.deepEqual(
    getBossRestoreAction(createBossSnapshot({ visible: true, minimized: true, alwaysOnTop: true })),
    "minimize"
  );
  assert.deepEqual(
    getBossRestoreAction(createBossSnapshot({ visible: true, minimized: false, alwaysOnTop: false })),
    "show"
  );
});
