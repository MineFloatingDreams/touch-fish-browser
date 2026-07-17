const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { cleanBuildOutputs, resolveBuildOutputDirectory } = require("../scripts/clean-build");

test("构建清理只删除明确的输出文件并保留源码", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "floating-browser-clean-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "win-unpacked"));
  await fs.mkdir(path.join(directory, "win-unpacked.tmp"));
  await fs.mkdir(path.join(directory, ".icon-ico"));
  await fs.writeFile(path.join(directory, "win-unpacked", "app.exe"), "generated");
  await fs.writeFile(path.join(directory, "FloatingMiniBrowser-Portable-1.8.3-x64.exe"), "generated");
  await fs.writeFile(path.join(directory, "builder-effective-config.yaml"), "generated");
  await fs.writeFile(path.join(directory, "package.json"), "source");
  await fs.mkdir(path.join(directory, "src"));

  const removed = await cleanBuildOutputs(directory);

  assert.deepEqual(removed.sort(), [
    ".icon-ico",
    "FloatingMiniBrowser-Portable-1.8.3-x64.exe",
    "builder-effective-config.yaml",
    "win-unpacked",
    "win-unpacked.tmp",
  ]);
  assert.equal(await fs.readFile(path.join(directory, "package.json"), "utf8"), "source");
  assert.equal((await fs.stat(path.join(directory, "src"))).isDirectory(), true);
});

test("构建清理目录跟随 electron-builder 输出配置", () => {
  assert.equal(
    resolveBuildOutputDirectory("C:\\project", { build: { directories: { output: "./build" } } }),
    path.resolve("C:\\project", "./build")
  );
});
