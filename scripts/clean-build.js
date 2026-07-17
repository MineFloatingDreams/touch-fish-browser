"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const GENERATED_DIRECTORIES = new Set([
  ".icon-ico",
  "win-unpacked",
  "win-ia32-unpacked",
  "win-arm64-unpacked",
]);

function isGeneratedBuildEntry(name, isDirectory) {
  if (isDirectory) return GENERATED_DIRECTORIES.has(name);
  return (
    /^FloatingMiniBrowser-(?:Setup|Portable)-.+\.exe(?:\.blockmap)?$/i.test(name) ||
    /^builder-(?:debug\.yml|effective-config\.yaml)$/i.test(name) ||
    name === "latest.yml"
  );
}

async function cleanBuildOutputs(outputDirectory) {
  const directory = path.resolve(outputDirectory);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const removed = [];
  for (const entry of entries) {
    if (!isGeneratedBuildEntry(entry.name, entry.isDirectory())) continue;
    await fs.rm(path.join(directory, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
      maxRetries: 5,
      retryDelay: 250,
    });
    removed.push(entry.name);
  }
  return removed;
}

function resolveBuildOutputDirectory(projectDirectory, packageConfig) {
  const configuredOutput = packageConfig?.build?.directories?.output || "dist";
  return path.resolve(projectDirectory, configuredOutput);
}

if (require.main === module) {
  const projectDirectory = path.resolve(__dirname, "..");
  const packageConfig = require(path.join(projectDirectory, "package.json"));
  const outputDirectory = resolveBuildOutputDirectory(projectDirectory, packageConfig);
  cleanBuildOutputs(outputDirectory)
    .then((removed) => {
      console.log(removed.length
        ? `已清理 ${outputDirectory}：${removed.join(", ")}`
        : `${outputDirectory} 没有需要清理的构建输出`);
    })
    .catch((error) => {
      console.error(`清理构建输出失败：${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { cleanBuildOutputs, isGeneratedBuildEntry, resolveBuildOutputDirectory };
