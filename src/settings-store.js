"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { sanitizeSettings } = require("./core");

class SettingsStore {
  constructor(directory) {
    this.directory = directory;
    this.filePath = path.join(directory, "settings.json");
    this.pendingWrite = Promise.resolve();
  }

  async load() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return sanitizeSettings(JSON.parse(raw));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      const defaults = sanitizeSettings({});
      await this.save(defaults);
      return defaults;
    }
  }

  async save(value) {
    const settings = sanitizeSettings(value);
    this.pendingWrite = this.pendingWrite.then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      await fs.rename(temporaryPath, this.filePath);
    });
    await this.pendingWrite;
    return settings;
  }
}

module.exports = { SettingsStore };
