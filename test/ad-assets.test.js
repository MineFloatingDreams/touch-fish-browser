const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { detectImageType } = require("../src/core");

const EXPECTED_AD_FILES = Array.from(
  { length: 10 },
  (_unused, index) => `ad-${String(index + 1).padStart(2, "0")}.png`
);

function readImageDimensions(buffer, mime) {
  if (mime === "image/png") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mime !== "image/jpeg") return null;

  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (startOfFrameMarkers.has(marker)) {
      return {
        width: buffer.readUInt16BE(offset + 5),
        height: buffer.readUInt16BE(offset + 3),
      };
    }
    offset += segmentLength;
  }
  return null;
}

test("内置广告清单包含 10 张有效的 440×586 PNG/JPEG", () => {
  const directory = path.join(__dirname, "..", "build", "ads");
  const files = new Set(fs.readdirSync(directory));

  for (const fileName of EXPECTED_AD_FILES) {
    assert.equal(files.has(fileName), true, `缺少内置广告 ${fileName}`);
    const buffer = fs.readFileSync(path.join(directory, fileName));
    const imageType = detectImageType(buffer);
    assert.ok(imageType && ["image/png", "image/jpeg"].includes(imageType.mime), `${fileName} 格式错误`);
    const dimensions = readImageDimensions(buffer, imageType.mime);
    assert.deepEqual(dimensions, { width: 440, height: 586 }, `${fileName} 尺寸错误`);
    assert.ok(buffer.length > 50_000, `${fileName} 内容体积异常`);
  }
});
