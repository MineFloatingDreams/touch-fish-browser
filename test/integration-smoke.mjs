import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.join(projectRoot, "test-artifacts");
await fs.mkdir(outputDirectory, { recursive: true });

const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  if (request.url === "/popup") {
    response.end("<!doctype html><title>新标签页测试</title><h1 id='popup-marker'>popup-routed-to-tab</h1>");
    return;
  }
  if (request.url === "/second") {
    response.end("<!doctype html><title>第二页</title><h1 id='marker'>second-page</h1>");
    return;
  }
  response.end("<!doctype html><title>禁止 iframe 的测试页</title><button id='lock' style='position:fixed;left:8px;top:8px;width:140px;height:44px'>lock pointer</button><a id='newtab' target='_blank' href='/popup' style='position:fixed;left:160px;top:8px;width:140px;height:44px'>open new tab</a><h1 id='marker' style='margin-top:70px'>frame-denied-page</h1><a href='/second'>next</a><script>document.querySelector('#lock').addEventListener('click',()=>document.body.requestPointerLock())</script>");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const resultPath = path.join(outputDirectory, "integration-result.json");
const userDataPath = path.join(outputDirectory, "user-data");
const customExecutable = process.argv[2] ? path.resolve(process.argv[2]) : "";
const executable = customExecutable || require("electron");
const args = customExecutable ? [] : [projectRoot];

await fs.rm(resultPath, { force: true });

const child = spawn(executable, args, {
  cwd: projectRoot,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    FMB_SMOKE: "1",
    FMB_SMOKE_URL: `${baseUrl}/`,
    FMB_SMOKE_SECOND_URL: `${baseUrl}/second`,
    FMB_SMOKE_RESULT: resultPath,
    FMB_SMOKE_USER_DATA: userDataPath
  }
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

const timeout = setTimeout(() => child.kill(), 45_000);
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
clearTimeout(timeout);
server.close();

assert.equal(exitCode, 0, `Electron 冒烟测试退出码异常。\nstdout:\n${stdout}\nstderr:\n${stderr}`);
const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
assert.equal(result.ok, true, result.error || "未知 Electron 冒烟测试错误");
assert.equal(result.requireType, "undefined");
assert.equal(result.exposedApiType, "undefined");
assert.equal(result.tabCount, 2);
assert.equal(result.secondTabUrl, `${baseUrl}/second`);
assert.equal(result.shortcutCreatedTab, true);
assert.equal(result.shortcutClosedTab, true);
assert.equal(result.shortcutSwitchedToFirst, true);
assert.equal(result.popupRoutedToTab, true);
assert.equal(result.popupChildWindowCount, 0);
assert.equal(result.pointerLockAcquired, true);
assert.equal(result.pointerLockReleased, true);
assert.equal(result.captureStateCleared, true);
assert.equal(result.mergedBrowserControls, true);
assert.equal(result.controlsHidden, true);
assert.equal(result.controlsHiddenPersisted, true);
assert.equal(result.controlsRestored, true);
assert.equal(result.controlsVisiblePersisted, true);
assert.equal(result.controlsExpandedBrowserTop, 84);
assert.equal(result.controlsCollapsedBrowserTop, 42);
assert.equal(result.controlsRestoredBrowserTop, 84);
assert.deepEqual(result.homePresetLabels, ["抖音", "知乎", "哔哩哔哩", "百度", "微博"]);
assert.equal(result.settingsTabOpen, true);
assert.equal(result.settingsTabClosed, true);
assert.equal(result.importedBookmarkVisible, true);
assert.equal(result.mouseTransparencyOutsideOpacity, 0);
assert.ok(Math.abs(result.mouseTransparencyRestoredOpacity - result.mouseTransparencyOriginalOpacity) < 0.01);
assert.equal(result.mouseTransparencyForcedTop, true);
assert.match(result.builtinAdSource, /build\/ads\/ad-01\.png$/);
assert.equal(result.builtinAdCounter, "1 / 10");
assert.deepEqual(result.bossAdBounds, result.bossTargetBounds);
assert.deepEqual(result.bossConfiguredSize, { width: 280, height: 260 });
assert.equal(result.bossAdBounds.width, 280);
assert.equal(result.bossAdBounds.height, 260);
assert.deepEqual(result.bossAdMinimumSize, [200, 200]);
assert.deepEqual(result.bossRestoredBounds, result.bossOriginalBounds);
assert.deepEqual(result.bossRestoredMinimumSize, result.bossOriginalMinimumSize);
assert.equal(result.bossAdOpacity, 1);
assert.equal(result.bossAdAlwaysOnTop, false);
assert.equal(result.bossAdIgnoredMouseTransparency, true);
assert.ok(Math.abs(result.bossRestoredOpacity - result.bossOriginalOpacity) < 0.01);
assert.equal(result.bossRestoredAlwaysOnTop, true);
assert.equal(result.bossAdAllPagesMuted, true);
assert.equal(result.bossAudioRestored, true);
assert.equal(result.bossCloseButtonVisible, true);
assert.equal(result.bossAdCloseHidWindow, true);
assert.equal(result.bossAdCloseKeptMode, true);
assert.equal(result.bossHideSettingSelected, true);
assert.equal(result.bossHideModeActive, true);
assert.equal(result.bossHideWindowHidden, true);
assert.equal(result.bossHideAllPagesMuted, true);
assert.equal(result.bossHideWindowRestored, true);
assert.deepEqual(result.bossHideRestoredBounds, result.bossHideOriginalBounds);
assert.equal(result.bossHideAudioRestored, true);
assert.equal(result.customAdSourceIsDataUrl, true);
assert.equal(result.customAdCounter, "1 / 2");
assert.equal(result.canGoBack, true);
assert.equal(result.returnedUrl, `${baseUrl}/`);
assert.equal(result.returnedTitle, "禁止 iframe 的测试页");
assert.equal(result.returnedMarker, "frame-denied-page");
const persistedSettings = JSON.parse(await fs.readFile(path.join(userDataPath, "settings.json"), "utf8"));
assert.equal(persistedSettings.tabs.length, 2);
assert.equal(persistedSettings.activeTabIndex, 0);
assert.equal(persistedSettings.tabs[0], `${baseUrl}/`);
assert.equal(persistedSettings.tabs[1], `${baseUrl}/second`);

for (const screenshotPath of [result.uiScreenshot, result.settingsScreenshot, result.adScreenshot, result.tabsScreenshot]) {
  const stats = await fs.stat(screenshotPath);
  assert.ok(stats.size > 1_000, `${screenshotPath} 截图无效`);
}

console.log(JSON.stringify({ executable, ...result }, null, 2));
