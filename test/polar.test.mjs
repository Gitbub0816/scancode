import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { encodePolar, decodePolarBits, decodePolarRgba, decodePolarFrame, renderPolarSvg } from '../dist/index.js';

test('polar encoder carries exact Unicode and URL payloads in the one-row ring and cloud', () => {
  for (const payload of [
    'https://citeory.com/study-buddies/invite/aJ3BnnB12345',
    'こんにちは 🌌 AsterHalo'
  ]) {
    const code = encodePolar(payload);
    assert.equal(code.bits.length, 1024);
    assert.equal(code.slots.filter(slot => slot.ring).length, 256);
    assert.equal(code.slots.filter(slot => !slot.ring).length, 768);
    assert.equal(decodePolarBits(code.bits), payload);
  }
});

test('triple-dot waypoints locate and decode a full camera frame across rotations', async () => {
  const payload = 'https://citeory.com/study-buddies/invite/aJ3BnnB12345';
  const svg = Buffer.from(renderPolarSvg(payload, { size: 800 }));
  for (const angle of [0, 15, 35, 90]) {
    const code = await sharp(svg).rotate(angle, { background: '#060e19' }).png().toBuffer();
    const meta = await sharp(code).metadata();
    const { data, info } = await sharp({ create: { width: 1200, height: 1200, channels: 4, background: '#060e19' } })
      .composite([{ input: code, left: Math.round((1200 - meta.width) / 2 + 45), top: Math.round((1200 - meta.height) / 2 - 30) }])
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const result = decodePolarFrame(data, info.width, info.height);
    assert.equal(result?.payload, payload, `failed at ${angle} degrees`);
    assert.ok(result.symbolSize > 700);
  }
});

test('Reed-Solomon recovers sixteen corrupted encoded bytes', () => {
  const code = encodePolar('https://example.org/invite/abc');
  const damaged = Uint8Array.from(code.bits);
  for (let byte = 0; byte < 16; byte++) damaged[byte * 8] ^= 1;
  assert.equal(decodePolarBits(damaged), code.payload);
  damaged[16 * 8] ^= 1;
  assert.throws(() => decodePolarBits(damaged));
});

test('rendered polar image decodes without a QR grid', async () => {
  const payload = 'https://citeory.com/study-buddies/invite/aJ3BnnB12345';
  for (const size of [600, 800, 1200]) {
    const svg = renderPolarSvg(payload, { size, mark: 'A' });
    assert.ok(!svg.includes('<rect x='));
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(decodePolarRgba(data, info.width, info.height), payload);
  }
});

test('aligned polar image survives compression, blur, and downscaling to 600px', async () => {
  const payload = 'https://citeory.com/study-buddies/invite/aJ3BnnB12345';
  const svg = Buffer.from(renderPolarSvg(payload, { size: 800, mark: 'A' }));
  for (const pipeline of [
    sharp(svg).jpeg({ quality: 70 }),
    sharp(svg).resize(600),
    sharp(svg).blur(1)
  ]) {
    const raster = await pipeline.toBuffer();
    const { data, info } = await sharp(raster).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(decodePolarRgba(data, info.width, info.height), payload);
  }
});

test('waypoint scanner reads a camera-sized blurred symbol', async () => {
  const payload = 'https://citeory.com/study-buddies/invite/aJ3BnnB12345';
  const svg = Buffer.from(renderPolarSvg(payload, { size: 800 }));
  const { data, info } = await sharp(svg).resize(400, 400).blur(.7).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decodePolarFrame(data, info.width, info.height)?.payload, payload);
});

test('sampler reads a slightly rotated and rescaled frame with guide adjustment', async () => {
  const payload = 'https://example.org/invite/abc';
  const svg = Buffer.from(renderPolarSvg(payload, { size: 800 }));
  const { data, info } = await sharp(svg)
    .rotate(3, { background: '#060e19' })
    .resize(800, 800, { fit: 'contain', background: '#060e19' })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decodePolarRgba(data, info.width, info.height, { angleDegrees: 3, scale: .95 }), payload);
});

test('polar API rejects oversized data and malformed symbols', () => {
  assert.throws(() => encodePolar(''), /non-empty/);
  assert.throws(() => encodePolar('x'.repeat(88)), /87 UTF-8/);
  assert.throws(() => decodePolarBits(new Uint8Array(8)), /1024/);
  assert.throws(() => renderPolarSvg('x', { size: 100 }), /600-4096/);
});
