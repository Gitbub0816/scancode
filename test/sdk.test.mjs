import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { BinaryBitmap, HybridBinarizer, RGBLuminanceSource, QRCodeReader } from '@zxing/library';
import { encode, renderSvg } from '../dist/index.js';

function decode(raw, width, height) {
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = (raw[i * 4] + raw[i * 4 + 1] * 2 + raw[i * 4 + 2]) / 4;
  const luminance = new RGBLuminanceSource(gray, width, height);
  return new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(luminance))).getText();
}

test('exact Unicode and URL payloads survive generated static images', async () => {
  for (const payload of [
    'https://citeory.com/study-buddies/invite/aJ3BnnB12345',
    'https://example.org/?q=hello%20world&code=🌌',
    'こんにちは AsterHalo 👋'
  ]) {
    const code = encode(payload);
    assert.equal(code.correction, 'H');
    assert.equal(code.modules.length, code.size);
    const svg = renderSvg(code, { size: 800, mark: 'ASTERHALO' });
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(decode(data, info.width, info.height), payload);
  }
});

test('invalid input and unsafe rendering options fail or escape', () => {
  assert.throws(() => encode(''), /non-empty/);
  assert.throws(() => encode('x'.repeat(2049)), /2048-byte/);
  assert.throws(() => renderSvg('x', { size: 10 }), /320-4096/);
  assert.throws(() => renderSvg('x', { centerRadius: .3 }), /0-.15/);
  const svg = renderSvg('hello', { mark: '<script>alert(1)</script>' });
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('#071521'));
});

test('particle style decodes after practical image transforms', async () => {
  const payload = 'https://citeory.com/study-buddies/invite/aJ3BnnB12345';
  const svg = renderSvg(payload, { size: 800, mark: 'A' });
  assert.equal((svg.match(/r="[\d.]+" fill="#071c2b"/g) || []).length, 6);
  for (const pipeline of [
    sharp(Buffer.from(svg)),
    sharp(Buffer.from(svg)).jpeg({ quality: 70 }),
    sharp(Buffer.from(svg)).resize(300),
    sharp(Buffer.from(svg)).blur(2),
    sharp(Buffer.from(svg)).rotate(15, { background: '#07101d' })
  ]) {
    const bytes = await pipeline.toBuffer();
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(decode(data, info.width, info.height), payload);
  }
});
