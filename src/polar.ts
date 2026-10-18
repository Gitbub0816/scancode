import { GenericGF, ReedSolomonDecoder, ReedSolomonEncoder } from '@zxing/library';

/** AsterHalo's experimental polar wire format. Stock camera apps do not decode it. */
export interface PolarCode {
  readonly payload: string;
  readonly bits: Uint8Array;
  readonly slots: readonly PolarSlot[];
  readonly size: number;
}

export interface PolarSlot {
  readonly x: number;
  readonly y: number;
  readonly ring: boolean;
}

const DATA_BYTES = 96;
const PARITY_BYTES = 32;
const CODE_BYTES = DATA_BYTES + PARITY_BYTES;
const BIT_COUNT = CODE_BYTES * 8;
const OUTER_BITS = 256;
const HEADER_BYTES = 9;
const MAX_PAYLOAD_BYTES = DATA_BYTES - HEADER_BYTES;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function slotMap(): PolarSlot[] {
  const inner: PolarSlot[] = [];
  const placement = random(0x716ca2b5);
  const cells = new Map<string, PolarSlot[]>();
  while (inner.length < BIT_COUNT - OUTER_BITS) {
    const angle = placement() / 0x100000000 * 2 * Math.PI;
    const radial = placement() / 0x100000000;
    const radius = Math.sqrt(.14 ** 2 + radial * (.305 ** 2 - .14 ** 2));
    const x = .5 + radius * Math.cos(angle), y = .5 + radius * Math.sin(angle);
    const gx = Math.floor(x / .007), gy = Math.floor(y / .007);
    let near = false;
    for (let dx = -1; dx <= 1 && !near; dx++) for (let dy = -1; dy <= 1 && !near; dy++) {
      for (const slot of cells.get(`${gx + dx},${gy + dy}`) ?? []) {
        if (Math.hypot(x - slot.x, y - slot.y) < .0065) { near = true; break; }
      }
    }
    if (near) continue;
    const slot = { x, y, ring: false };
    inner.push(slot);
    const key = `${gx},${gy}`;
    cells.set(key, [...(cells.get(key) ?? []), slot]);
  }
  // Two gaps hold triple-dot waypoints; encoded dots occupy one outer track.
  const gap = .06, m1 = 5 * Math.PI / 4, m2 = 7 * Math.PI / 4;
  const ranges = [[0, m1 - gap], [m1 + gap, m2 - gap], [m2 + gap, 2 * Math.PI]];
  const total = ranges.reduce((sum, [a, b]) => sum + b - a, 0);
  const outer: PolarSlot[] = [];
  for (let i = 0; i < OUTER_BITS; i++) {
    let t = (i + .5) * total / OUTER_BITS;
    let angle = 0;
    for (const [a, b] of ranges) {
      if (t < b - a) { angle = a + t; break; }
      t -= b - a;
    }
    outer.push({ x: .5 + .42 * Math.cos(angle), y: .5 + .42 * Math.sin(angle), ring: true });
  }
  // Deterministic interleaving spreads adjacent codeword bits across the cloud and ring.
  const next = random(0xa57e2c91);
  const slots = [...inner, ...outer];
  for (let i = slots.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  if (slots.length < BIT_COUNT) throw new Error('Polar layout capacity is below wire format size');
  return slots.slice(0, BIT_COUNT);
}

const SLOTS = slotMap();
/** Shared geometry for the encoder and camera locator. */
export function getPolarSlots(): readonly PolarSlot[] { return SLOTS; }

/** Encodes UTF-8 bytes directly into a circular particle matrix with RS(128,96). */
export function encodePolar(payload: string): PolarCode {
  if (typeof payload !== 'string' || !payload) throw new TypeError('payload must be a non-empty string');
  const utf8 = encoder.encode(payload);
  if (utf8.length > MAX_PAYLOAD_BYTES) throw new RangeError(`polar payload exceeds ${MAX_PAYLOAD_BYTES} UTF-8 bytes; use a short redirect URL`);
  const data = new Int32Array(CODE_BYTES);
  data[0] = 0x50; data[1] = 0x43; data[2] = 3;
  data[3] = utf8.length >>> 8; data[4] = utf8.length & 255;
  const crc = crc32(utf8);
  data[5] = crc >>> 24; data[6] = (crc >>> 16) & 255;
  data[7] = (crc >>> 8) & 255; data[8] = crc & 255;
  for (let i = 0; i < utf8.length; i++) data[HEADER_BYTES + i] = utf8[i];
  const next = random(0x759e2361);
  for (let i = HEADER_BYTES + utf8.length; i < DATA_BYTES; i++) data[i] = next() & 255;
  new ReedSolomonEncoder(GenericGF.QR_CODE_FIELD_256).encode(data, PARITY_BYTES);
  const bits = new Uint8Array(BIT_COUNT);
  const mask = random(0x2d943fa7);
  for (let i = 0; i < BIT_COUNT; i++) bits[i] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) ^ (mask() & 1);
  return { payload, bits, slots: SLOTS, size: 800 };
}

/** Decodes sampled polar bits; corrects up to 16 erroneous bytes per codeword. */
export function decodePolarBits(bits: ArrayLike<number>): string {
  if (bits.length !== BIT_COUNT) throw new RangeError(`expected ${BIT_COUNT} polar bits`);
  const data = new Int32Array(CODE_BYTES);
  const mask = random(0x2d943fa7);
  for (let i = 0; i < BIT_COUNT; i++) {
    const bit = Number(bits[i]);
    if (bit !== 0 && bit !== 1) throw new TypeError('polar bits must be 0 or 1');
    data[i >>> 3] |= (bit ^ (mask() & 1)) << (7 - (i & 7));
  }
  try { new ReedSolomonDecoder(GenericGF.QR_CODE_FIELD_256).decode(data, PARITY_BYTES); }
  catch { throw new Error('polar error correction failed'); }
  if (data[0] !== 0x50 || data[1] !== 0x43 || data[2] !== 3) throw new Error('polar format marker is invalid');
  const length = (data[3] << 8) | data[4];
  if (length < 1 || length > MAX_PAYLOAD_BYTES) throw new Error('polar payload length is invalid');
  const utf8 = Uint8Array.from(data.slice(HEADER_BYTES, HEADER_BYTES + length));
  const expected = ((data[5] << 24) | (data[6] << 16) | (data[7] << 8) | data[8]) >>> 0;
  if (crc32(utf8) !== expected) throw new Error('polar payload checksum failed');
  return decoder.decode(utf8);
}

export interface PolarSampleTransform { scale?: number; offsetX?: number; offsetY?: number; angleDegrees?: number }

/** Samples an upright RGBA image. Camera perspective detection is a separate step. */
export function decodePolarRgba(rgba: ArrayLike<number>, width: number, height: number, transform: PolarSampleTransform = {}): string {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 600 || height < 600 || rgba.length < width * height * 4) {
    throw new RangeError('expected an aligned RGBA image of at least 600 by 600 pixels');
  }
  const scale = transform.scale ?? 1;
  const offsetX = transform.offsetX ?? 0;
  const offsetY = transform.offsetY ?? 0;
  const angle = (transform.angleDegrees ?? 0) * Math.PI / 180;
  if (!Number.isFinite(scale) || scale < .5 || scale > 1.2 || !Number.isFinite(offsetX) || !Number.isFinite(offsetY) || !Number.isFinite(angle)) {
    throw new RangeError('invalid polar sample transform');
  }
  const sine = Math.sin(angle), cosine = Math.cos(angle);
  const bits = new Uint8Array(BIT_COUNT);
  for (let i = 0; i < BIT_COUNT; i++) {
    const slot = SLOTS[i];
    const dx = (slot.x - .5) * width * scale;
    const dy = (slot.y - .5) * height * scale;
    const x = Math.round(width / 2 + dx * cosine - dy * sine + offsetX);
    const y = Math.round(height / 2 + dx * sine + dy * cosine + offsetY);
    if (x < 0 || y < 0 || x >= width || y >= height) throw new RangeError('polar sample is outside the image');
    const p = (y * width + x) * 4;
    const luminance = .2126 * Number(rgba[p]) + .7152 * Number(rgba[p + 1]) + .0722 * Number(rgba[p + 2]);
    bits[i] = luminance > 95 ? 1 : 0;
  }
  return decodePolarBits(bits);
}

export interface PolarRenderOptions { size?: number; mark?: string; animated?: boolean }

const escapeXml = (value: string) => value.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** Renders the encoded data in one outer track and the particle cloud. */
export function renderPolarSvg(input: string | PolarCode, options: PolarRenderOptions = {}): string {
  const code = typeof input === 'string' ? encodePolar(input) : input;
  const size = options.size ?? 800;
  if (!Number.isInteger(size) || size < 600 || size > 4096) throw new RangeError('size must be 600-4096');
  const cx = size / 2;
  const scale = size / 800;
  const colors = ['#45d8f2', '#f051b0', '#f0c86c', '#62aee8'];
  const bright: string[] = [], dim: string[] = [];
  for (let i = 0; i < code.bits.length; i++) {
    const slot = code.slots[i];
    const x = (slot.x * size).toFixed(2), y = (slot.y * size).toFixed(2);
    const radius = (slot.ring ? 2.4 : 2.5) * scale;
    const particleColors = ['#b5f3f4', '#f6b6de', '#ffe3aa', '#a6cdeb'];
    const color = slot.ring ? '#c3e9e9' : particleColors[Math.floor((Math.sin(Math.atan2(slot.y - .5, slot.x - .5) * 2.9 + i * .37) + 1) * 1.999)];
    if (code.bits[i]) bright.push(`<circle cx="${x}" cy="${y}" r="${radius.toFixed(2)}" fill="${color}"/>`);
    else dim.push(`<circle cx="${x}" cy="${y}" r="${(slot.ring ? radius * .75 : 2.65 * scale).toFixed(2)}" fill="${slot.ring ? '#263846' : '#172433'}"/>`);
  }
  const bloom: string[] = [];
  const filaments: string[] = [];
  const ridge = (a: number) => .226 + .013 * Math.sin(5 * a + .75) + .009 * Math.cos(8 * a - .8) + .005 * Math.sin(14 * a + .35);
  for (let strand = 0; strand < 232; strand++) {
    const points: string[] = [];
    const start = strand * 2.399963229728653;
    const length = .42 + (strand % 17) * .058;
    const offset = ((strand * 37) % 127) / 127 * .106 - .053;
    const twist = strand * .37;
    for (let step = 0; step <= 96; step++) {
      const t = step / 96;
      const a = start + t * length;
      const r = ridge(a) + offset + .007 * Math.sin(11 * a + twist + t * 5);
      const z = .011 * Math.sin(6 * a + twist + t * 4);
      points.push(`${step ? 'L' : 'M'}${(cx + size * r * Math.cos(a)).toFixed(1)} ${(cx + size * (r * Math.sin(a) + z)).toFixed(1)}`);
    }
    const hue = colors[Math.floor((Math.sin(start * 2.7 + offset * 20) + 1) * 1.999)];
    const path = points.join('');
    if (strand % 3 === 0) bloom.push(`<path d="${path}" fill="none" stroke="${hue}" stroke-opacity="${strand % 9 === 0 ? '.55' : '.29'}" stroke-width="${((strand % 9 === 0 ? 14 : 7) * scale).toFixed(1)}" stroke-linecap="round"/>`);
    filaments.push(`<path d="${path}" fill="none" stroke="${hue}" stroke-opacity="${strand % 11 === 0 ? '.82' : '.34'}" stroke-width="${((strand % 11 === 0 ? 1.2 : .5) * scale).toFixed(2)}" stroke-linecap="round"/>`);
  }
  const vapor: string[][] = [[], [], [], []];
  const sparks: string[] = [];
  const next = random(0x6f0b91e2);
  for (let i = 0; i < 30000; i++) {
    const a = next() / 0x100000000 * Math.PI * 2;
    const v = next() / 0x100000000 * Math.PI * 2;
    const volume = .062 + .014 * Math.sin(4 * a - .6) + .008 * Math.cos(7 * a + 1.1);
    const cross = Math.sqrt(next() / 0x100000000) * volume;
    const fold = .008 * Math.sin(12 * a + 2.2 * v) + .003 * Math.cos(22 * a - 3 * v);
    const r = ridge(a) + cross * Math.cos(v) + fold;
    const depth = cross * Math.sin(v);
    const angle = a + .011 * Math.sin(7 * a + v);
    const x = (cx + size * r * Math.cos(angle)).toFixed(2);
    const y = (cx + size * (r * Math.sin(angle) + depth * .48)).toFixed(2);
    const chroma = Math.sin(2.8 * a + 2.2 * Math.sin(v) + 7 * (r - ridge(a)));
    const band = chroma > .38 ? 1 : chroma < -.38 ? 0 : Math.cos(4.8 * a + v) > 0 ? 3 : 2;
    const depthLight = .43 + .57 * (.5 + .5 * Math.cos(v - .65));
    const light = (.42 + .58 * Math.max(0, Math.sin(6 * a + v + r * 29))) * depthLight;
    const dot = ((i % 137 === 0 ? 1.4 : i % 19 === 0 ? .94 : .5) * scale).toFixed(2);
    const opacity = (i % 137 === 0 ? .94 : .29 + light * .52).toFixed(2);
    vapor[band].push(`<circle cx="${x}" cy="${y}" r="${dot}" fill="${colors[band]}" opacity="${opacity}"/>`);
    if (i % 137 === 0) sparks.push(`<circle cx="${x}" cy="${y}" r="${(3.7 * scale).toFixed(2)}" fill="${colors[band]}" opacity=".18"/>`);
  }
  const waypoints = [5 * Math.PI / 4, 7 * Math.PI / 4].flatMap(base => [-.029, 0, .029].map(offset => {
    const angle = base + offset;
    return `<circle cx="${(size * (.5 + .42 * Math.cos(angle))).toFixed(2)}" cy="${(size * (.5 + .42 * Math.sin(angle))).toFixed(2)}" r="${(3.65 * scale).toFixed(2)}" fill="#d6f8f5"/>`;
  })).join('');
  const mark = escapeXml(Array.from(options.mark ?? '').slice(0, 3).join(''));
  const icon = mark ? `<text x="${cx}" y="${cx}" text-anchor="middle" dominant-baseline="middle" font-family="system-ui,sans-serif" font-size="${(29 * scale).toFixed(1)}" font-weight="700" fill="#e4fcff">${mark}</text>` : `<g transform="translate(${cx} ${cx}) scale(${scale})" fill="none" stroke="#e9fcff" stroke-linecap="round" stroke-linejoin="round"><path d="M-13 -27 L-2 6 L22 -5 M-2 6 L-20 23 M-2 6 L19 23" stroke-width="6"/><circle cx="-20" cy="23" r="6" stroke-width="4"/><circle cx="22" cy="-5" r="5" stroke-width="4"/></g>`;
  const motion = options.animated ? `<style>.cloud-layer,.haze,.filaments{transform-origin:50% 50%}.cloud-0{animation:cloud-a 8s ease-in-out infinite}.cloud-1{animation:cloud-b 11s ease-in-out infinite}.cloud-2{animation:cloud-a 13s ease-in-out infinite reverse}.cloud-3{animation:cloud-b 9s ease-in-out infinite reverse}.haze{animation:cloud-b 15s ease-in-out infinite}.filaments{animation:cloud-a 12s ease-in-out infinite}@keyframes cloud-a{0%,100%{transform:rotate(-2deg) scale(.985);opacity:.75}50%{transform:rotate(3deg) scale(1.015);opacity:1}}@keyframes cloud-b{0%,100%{transform:rotate(2deg) scale(1.01);opacity:1}50%{transform:rotate(-3deg) scale(.985);opacity:.72}}@media(prefers-reduced-motion:reduce){.cloud-layer,.haze,.filaments{animation:none}}</style>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="AsterHalo experimental polar code"><defs><radialGradient id="bg"><stop stop-color="#1c3447"/><stop offset=".58" stop-color="#102031"/><stop offset="1" stop-color="#030b15"/></radialGradient><radialGradient id="aura"><stop stop-color="#1d3546" stop-opacity="0"/><stop offset=".48" stop-color="#894d91" stop-opacity=".18"/><stop offset=".78" stop-color="#17b9d0" stop-opacity=".14"/><stop offset="1" stop-color="#061422" stop-opacity="0"/></radialGradient><radialGradient id="void"><stop stop-color="#081524"/><stop offset=".55" stop-color="#0b1a2a"/><stop offset="1" stop-color="#0b1a2a" stop-opacity="0"/></radialGradient><filter id="soft"><feGaussianBlur stdDeviation="${(5 * scale).toFixed(1)}"/></filter><filter id="spark-glow"><feGaussianBlur stdDeviation="${(5 * scale).toFixed(1)}"/></filter><filter id="icon-glow"><feGaussianBlur stdDeviation="${(4 * scale).toFixed(1)}"/></filter></defs>${motion}<rect width="${size}" height="${size}" fill="url(#bg)"/><circle cx="${cx}" cy="${cx}" r="${(size * .475).toFixed(1)}" fill="#0b1823"/><circle cx="${cx}" cy="${cx}" r="${(size * .355).toFixed(1)}" fill="url(#aura)"/><g class="mist"><g class="haze" filter="url(#soft)" opacity=".9">${bloom.join('')}</g><g filter="url(#spark-glow)">${sparks.join('')}</g><g class="filaments">${filaments.join('')}</g>${vapor.map((layer, index) => `<g class="cloud-layer cloud-${index}">${layer.join('')}</g>`).join('')}</g><g>${dim.join('')}${bright.join('')}</g><circle cx="${cx}" cy="${cx}" r="${(size * .09).toFixed(1)}" fill="url(#void)"/><g filter="url(#icon-glow)" opacity=".85">${icon}</g>${icon}${waypoints}<circle cx="${cx}" cy="${cx}" r="${(size * .475).toFixed(1)}" fill="none" stroke="#70d6e2" stroke-opacity=".3" stroke-width="${(1.2 * scale).toFixed(1)}" stroke-dasharray="${(size * .33).toFixed(1)} ${(size * .08).toFixed(1)}"/><circle cx="${cx}" cy="${cx}" r="${(size * .488).toFixed(1)}" fill="none" stroke="#d6fcff" stroke-opacity=".27" stroke-width="${(.9 * scale).toFixed(1)}" stroke-dasharray="${(size * .19).toFixed(1)} ${(size * .11).toFixed(1)}"/></svg>`;
}

/** Packages the same fixed data and independently flowing cloud for offline viewing. */
export function packagePolarAnimatedHtml(input: string | PolarCode, options: PolarRenderOptions = {}): string {
  const svg = renderPolarSvg(input, { ...options, animated: true });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AsterHalo Polar</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 35%,#173246,#020812 70%)}main{width:min(100vw,${options.size ?? 800}px);aspect-ratio:1}svg{display:block;width:100%;height:100%}</style></head><body><main>${svg}</main></body></html>`;
}
