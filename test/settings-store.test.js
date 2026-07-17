const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { SettingsStore } = require("../src/settings-store");

test("设置文件可首次创建并连续原子覆盖", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "floating-mini-browser-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const store = new SettingsStore(directory);
  const defaults = await store.load();
  assert.equal(defaults.opacity, 90);

  await store.save({ ...defaults, opacity: 70, lastUrl: "https://example.com/" });
  await store.save({ ...defaults, opacity: 55, lastUrl: "https://example.org/" });

  const saved = JSON.parse(await fs.readFile(path.join(directory, "settings.json"), "utf8"));
  assert.equal(saved.opacity, 55);
  assert.equal(saved.lastUrl, "https://example.org/");
  assert.equal(await fs.stat(path.join(directory, "settings.json.tmp")).catch(() => null), null);
});

test("损坏设置文件安全回退默认设置", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "floating-mini-browser-bad-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "settings.json"), "{broken", "utf8");

  const store = new SettingsStore(directory);
  const settings = await store.load();
  assert.equal(settings.bossKey, "Alt+Shift+A");
  assert.equal(settings.bossKeyAction, "ad");
  assert.equal(settings.lastUrl, "");
});
