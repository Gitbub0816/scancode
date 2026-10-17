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

const DATA_BYTES = 223;
const PARITY_BYTES = 32;
const CODE_BYTES = DATA_BYTES + PARITY_BYTES;
const BIT_COUNT = CODE_BYTES * 8;
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
  const slots: PolarSlot[] = [];
  const eyes = [[.22, .22], [.78, .22], [.22, .78]];
  for (let track = 0; track < 12; track++) {
    const radius = .338 + track * (.12 / 11);
    const count = Math.floor(2 * Math.PI * radius * 800 / 8.4);
    for (let sector = 0; sector < count; sector++) {
      const angle = (sector + (track % 2) * .5) * 2 * Math.PI / count - Math.PI / 2;
      const wave = .0018 * Math.sin(7 * angle + .4);
      const displaced = radius + wave;
      const x = .5 + displaced * Math.cos(angle);
      const y = .5 + displaced * Math.sin(angle);
      if (eyes.some(([ex, ey]) => Math.hypot(x - ex, y - ey) < .052)) continue;
      slots.push({ x, y, ring: true });
    }
  }
  // Deterministic interleaving spreads adjacent bits and parity over all tracks.
  const next = random(0xa57e2c91);
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

/** Encodes UTF-8 bytes directly into a circular particle matrix with RS(255,223). */
export function encodePolar(payload: string): PolarCode {
  if (typeof payload !== 'string' || !payload) throw new TypeError('payload must be a non-empty string');
  const utf8 = encoder.encode(payload);
  if (utf8.length > MAX_PAYLOAD_BYTES) throw new RangeError(`polar payload exceeds ${MAX_PAYLOAD_BYTES} UTF-8 bytes; use a short redirect URL`);
  const data = new Int32Array(CODE_BYTES);
  data[0] = 0x50; data[1] = 0x43; data[2] = 1;
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
  if (data[0] !== 0x50 || data[1] !== 0x43 || data[2] !== 1) throw new Error('polar format marker is invalid');
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

/** Renders the encoded data as concentric particles; there is no square QR layer. */
export function renderPolarSvg(input: string | PolarCode, options: PolarRenderOptions = {}): string {
  const code = typeof input === 'string' ? encodePolar(input) : input;
  const size = options.size ?? 800;
  if (!Number.isInteger(size) || size < 600 || size > 4096) throw new RangeError('size must be 600-4096');
  const cx = size / 2;
  const scale = size / 800;
  const colors = ['#49e5f4', '#f25cb3', '#f0c46a', '#839eff'];
  const bright: string[] = [], dim: string[] = [];
  for (let i = 0; i < code.bits.length; i++) {
    const slot = code.slots[i];
    const x = (slot.x * size).toFixed(2), y = (slot.y * size).toFixed(2);
    const radius = 2.25 * scale;
    const angle = Math.atan2(slot.y - .5, slot.x - .5);
    const band = Math.floor((Math.sin(angle * 3 + Math.hypot(slot.x - .5, slot.y - .5) * 34) + 1) * 1.999);
    const color = i % 11 === 0 ? '#e6fbff' : i % 5 === 0 ? '#b4eff5' : '#8bdce8';
    if (code.bits[i]) bright.push(`<circle cx="${x}" cy="${y}" r="${radius.toFixed(2)}" fill="${color}"/>`);
    else dim.push(`<circle cx="${x}" cy="${y}" r="${(radius * .88).toFixed(2)}" fill="#243a50"/>`);
  }
  const wisps: string[] = [];
  const filaments: string[] = [];
  for (let layer = 0; layer < 17; layer++) {
    const points: string[] = [];
    for (let step = 0; step <= 240; step++) {
      const a = step * Math.PI * 2 / 240;
      const r = size * (.19 + layer * .0068 + .022 * Math.sin(5 * a + .4) + .015 * Math.cos(9 * a - .5) + .004 * Math.sin(17 * a + layer * .1));
      points.push(`${step ? 'L' : 'M'}${(cx + r * Math.cos(a)).toFixed(1)} ${(cx + r * Math.sin(a)).toFixed(1)}`);
    }
    wisps.push(`<path d="${points.join('')}" fill="none" stroke="${colors[layer % 4]}" stroke-opacity=".24" stroke-width="${((layer % 3 ? 16 : 26) * scale).toFixed(1)}"/>`);
  }
  for (let strand = 0; strand < 76; strand++) {
    const points: string[] = [];
    const phase = strand * 2.399963229728653;
    const start = phase % (2 * Math.PI);
    const length = .38 + (strand % 9) * .075;
    const home = .182 + (strand % 23) / 23 * .116;
    for (let step = 0; step <= 46; step++) {
      const t = step / 46;
      const a = start + t * length + .034 * Math.sin(t * 9 + phase);
      const wave = .018 * Math.sin(5 * a + .4) + .011 * Math.cos(9 * a - .5);
      const r = home + wave + .005 * Math.sin(t * 15 + phase);
      points.push(`${step ? 'L' : 'M'}${(cx + size * r * Math.cos(a)).toFixed(1)} ${(cx + size * r * Math.sin(a)).toFixed(1)}`);
    }
    const hue = colors[Math.floor((Math.sin(start * 3 + home * 34) + 1) * 1.999)];
    filaments.push(`<path d="${points.join('')}" fill="none" stroke="${hue}" stroke-opacity="${strand % 8 === 0 ? '.47' : '.25'}" stroke-width="${((strand % 8 === 0 ? 1.6 : .8) * scale).toFixed(2)}" stroke-linecap="round"/>`);
  }
  const vapor: string[] = [];
  const sparks: string[] = [];
  const next = random(0x6f0b91e2);
  for (let i = 0; i < 6200; i++) {
    const angle = (next() / 0x100000000) * Math.PI * 2;
    const spread = (next() / 0x100000000 + next() / 0x100000000) / 2;
    const wave = .026 * Math.sin(5 * angle + .4) + .016 * Math.cos(9 * angle - .5) + .008 * Math.sin(16 * angle + .7);
    const r = .158 + .145 * spread + wave;
    const x = (cx + size * r * Math.cos(angle)).toFixed(2);
    const y = (cx + size * r * Math.sin(angle)).toFixed(2);
    const band = Math.floor((Math.sin(angle * 3 + r * 34) + 1) * 1.999);
    const dot = ((i % 37 === 0 ? 1.8 : i % 7 === 0 ? 1.08 : .48) * scale).toFixed(2);
    const opacity = i % 37 === 0 ? '.92' : i % 7 === 0 ? '.73' : '.55';
    vapor.push(`<circle cx="${x}" cy="${y}" r="${dot}" fill="${colors[band]}" opacity="${opacity}"/>`);
    if (i % 37 === 0) sparks.push(`<circle cx="${x}" cy="${y}" r="${(5.4 * scale).toFixed(2)}" fill="${colors[band]}" opacity=".29"/>`);
  }
  const eyes = [[.22, .22], [.78, .22], [.22, .78]].map(([x, y]) => {
    const px = (x * size).toFixed(2), py = (y * size).toFixed(2);
    return `<circle cx="${px}" cy="${py}" r="${(29 * scale).toFixed(2)}" fill="#c9eff3"/><circle cx="${px}" cy="${py}" r="${(24 * scale).toFixed(2)}" fill="#0a1b2c"/><circle cx="${px}" cy="${py}" r="${(15 * scale).toFixed(2)}" fill="#d9f9f7"/><circle cx="${px}" cy="${py}" r="${(9 * scale).toFixed(2)}" fill="#0a1b2c"/>`;
  }).join('');
  const mark = escapeXml(Array.from(options.mark ?? '').slice(0, 3).join(''));
  const icon = mark ? `<text x="${cx}" y="${cx}" text-anchor="middle" dominant-baseline="middle" font-family="system-ui,sans-serif" font-size="${(29 * scale).toFixed(1)}" font-weight="700" fill="#e4fcff">${mark}</text>` : `<g transform="translate(${cx} ${cx}) scale(${scale})" fill="none" stroke="#e9fcff" stroke-linecap="round" stroke-linejoin="round"><path d="M-13 -27 L-2 6 L22 -5 M-2 6 L-20 23 M-2 6 L19 23" stroke-width="6"/><circle cx="-20" cy="23" r="6" stroke-width="4"/><circle cx="22" cy="-5" r="5" stroke-width="4"/></g>`;
  const motion = options.animated ? `<style>@keyframes breathe{0%,100%{opacity:.82;transform:rotate(-2deg) scale(.99)}50%{opacity:1;transform:rotate(3deg) scale(1.015)}}.mist{transform-origin:50% 50%;animation:breathe 8s ease-in-out infinite}@media(prefers-reduced-motion:reduce){.mist{animation:none}}</style>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="AsterHalo experimental polar code"><defs><radialGradient id="bg"><stop stop-color="#1c3447"/><stop offset=".58" stop-color="#102031"/><stop offset="1" stop-color="#030b15"/></radialGradient><radialGradient id="aura"><stop stop-color="#1d3546" stop-opacity="0"/><stop offset=".48" stop-color="#894d91" stop-opacity=".18"/><stop offset=".78" stop-color="#17b9d0" stop-opacity=".14"/><stop offset="1" stop-color="#061422" stop-opacity="0"/></radialGradient><filter id="soft"><feGaussianBlur stdDeviation="${(9 * scale).toFixed(1)}"/></filter><filter id="spark-glow"><feGaussianBlur stdDeviation="${(5 * scale).toFixed(1)}"/></filter><filter id="icon-glow"><feGaussianBlur stdDeviation="${(4 * scale).toFixed(1)}"/></filter></defs>${motion}<rect width="${size}" height="${size}" fill="url(#bg)"/><circle cx="${cx}" cy="${cx}" r="${(size * .475).toFixed(1)}" fill="#102338"/><circle cx="${cx}" cy="${cx}" r="${(size * .355).toFixed(1)}" fill="url(#aura)"/><g class="mist"><g filter="url(#soft)" opacity=".76">${wisps.join('')}</g><g filter="url(#spark-glow)">${sparks.join('')}</g>${filaments.join('')}${vapor.join('')}</g><g>${dim.join('')}${bright.join('')}</g><circle cx="${cx}" cy="${cx}" r="${(size * .105).toFixed(1)}" fill="#0e1d2d" opacity=".96"/><g filter="url(#icon-glow)" opacity=".85">${icon}</g>${icon}${eyes}<circle cx="${cx}" cy="${cx}" r="${(size * .475).toFixed(1)}" fill="none" stroke="#70d6e2" stroke-opacity=".4" stroke-width="${(2 * scale).toFixed(1)}"/><circle cx="${cx}" cy="${cx}" r="${(size * .488).toFixed(1)}" fill="none" stroke="#d6fcff" stroke-opacity=".36" stroke-width="${(1.3 * scale).toFixed(1)}" stroke-dasharray="${(size * .15).toFixed(1)} ${(size * .034).toFixed(1)}"/></svg>`;
}

/** Packages the polar symbol and its restrained vapor animation for offline viewing. */
export function packagePolarAnimatedHtml(input: string | PolarCode, options: PolarRenderOptions = {}): string {
  const svg = renderPolarSvg(input, { ...options, animated: false });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AsterHalo Polar</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 35%,#173246,#020812 70%)}main{position:relative;width:min(100vw,${options.size ?? 800}px);aspect-ratio:1}svg,canvas{position:absolute;inset:0;width:100%;height:100%}canvas{pointer-events:none}</style></head><body><main>${svg}<canvas width="800" height="800" aria-hidden="true"></canvas></main><script>(()=>{const motion=matchMedia('(prefers-reduced-motion: reduce)');if(motion.matches)return;const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d',{alpha:true});if(!ctx)return;document.querySelector('.mist').style.opacity='0';const N=3000,p=[];let seed=0x6f0b91e2;function rnd(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296}for(let i=0;i<N;i++){const a=rnd()*Math.PI*2,u=(rnd()+rnd())*.5,d=rnd(),phase=rnd()*Math.PI*2;p.push({a,u,d,phase,size:i%31===0?1.9:i%7===0?1.1:.57,color:['#49e5f4','#f25cb3','#f0c46a','#839eff'][Math.floor((Math.sin(a*3+u*10)+1)*1.999)]})}let last=0;function frame(ms){requestAnimationFrame(frame);if(ms-last<30)return;last=ms;const t=ms*.001;ctx.clearRect(0,0,800,800);ctx.globalCompositeOperation='lighter';for(let pass=0;pass<2;pass++){for(let i=0;i<N;i++){const q=p[i];if(pass===0&&i%7!==0)continue;const a=q.a+t*(.024+.018*q.d)+Math.sin(t*.19+q.phase)*.014;const wave=.028*Math.sin(5*a+.4+t*.19)+.017*Math.cos(9*a-.5-t*.12)+.008*Math.sin(16*a+t*.16+q.phase);const r=Math.min(.318,.16+.13*q.u+wave+Math.sin(t*.37+q.phase)*.004);const x=400+800*r*Math.cos(a),y=400+800*r*Math.sin(a);ctx.globalAlpha=pass===0?.11:q.d*.34+.3;ctx.fillStyle=q.color;ctx.beginPath();ctx.arc(x,y,pass===0?q.size*5:q.size,0,Math.PI*2);ctx.fill()}}ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over'}requestAnimationFrame(frame)})();</script></body></html>`;
}
