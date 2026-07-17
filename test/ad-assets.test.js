const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("内置广告包含 10 张有效的 720×1020 PNG", () => {
  const directory = path.join(__dirname, "..", "build", "ads");
  const files = fs.readdirSync(directory).filter((name) => /^ad-\d{2}\.png$/.test(name)).sort();
  assert.deepEqual(files, Array.from({ length: 10 }, (_unused, index) => `ad-${String(index + 1).padStart(2, "0")}.png`));

  for (const fileName of files) {
    const buffer = fs.readFileSync(path.join(directory, fileName));
    assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(buffer.readUInt32BE(16), 720, `${fileName} 宽度错误`);
    assert.equal(buffer.readUInt32BE(20), 1020, `${fileName} 高度错误`);
    assert.ok(buffer.length > 100_000, `${fileName} 内容体积异常`);
  }
});
