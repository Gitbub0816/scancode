import { decodePolarBits, getPolarSlots } from './polar.js';

interface Eye { x: number; y: number; diameter: number }
interface Blob { x: number; y: number; width: number; height: number; area: number }

export interface PolarFrameResult {
  payload: string;
  /** Finder-eye centers in input-image pixels: right-angle eye, horizontal eye, vertical eye. */
  eyes: readonly [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  /** Approximate symbol width in input-image pixels. */
  symbolSize: number;
}

function luminance(rgba: ArrayLike<number>, width: number, x: number, y: number): number {
  const p = (y * width + x) * 4;
  return .2126 * Number(rgba[p]) + .7152 * Number(rgba[p + 1]) + .0722 * Number(rgba[p + 2]);
}

function findEyeCandidates(rgba: ArrayLike<number>, width: number, height: number): Eye[] {
  const factor = Math.max(1, Math.ceil(Math.max(width, height) / 1000));
  const w = Math.floor(width / factor), h = Math.floor(height / factor);
  const light = new Uint8Array(w * h);
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const value = luminance(rgba, width, Math.min(width - 1, x * factor + (factor >> 1)), Math.min(height - 1, y * factor + (factor >> 1)));
    gray[y * w + x] = value;
    light[y * w + x] = value > 160 ? 1 : 0;
  }
  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  const blobs: Blob[] = [];
  for (let start = 0; start < light.length; start++) {
    if (!light[start] || visited[start]) continue;
    let head = 0, tail = 0, area = 0, minX = w, maxX = 0, minY = h, maxY = 0, sumX = 0, sumY = 0;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % w, y = (p / w) | 0;
      area++; sumX += x; sumY += y;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        const nx = x + ox, ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const next = ny * w + nx;
        if (light[next] && !visited[next]) { visited[next] = 1; queue[tail++] = next; }
      }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const fill = area / (bw * bh);
    if (bw < 12 || bh < 12 || bw > Math.min(w, h) * .2 || bh > Math.min(w, h) * .2) continue;
    if (bw / bh < .7 || bw / bh > 1.3 || fill < .12 || fill > .72) continue;
    const cx = sumX / area, cy = sumY / area;
    const centerX = Math.round(cx), centerY = Math.round(cy);
    if (gray[centerY * w + centerX] > 110) continue;
    blobs.push({ x: cx, y: cy, width: bw, height: bh, area });
  }
  const eyes: Eye[] = [];
  for (const outer of blobs) {
    const inner = blobs.find(candidate => {
      const ratio = outer.width / candidate.width;
      return candidate !== outer && ratio > 1.55 && ratio < 2.35 &&
        Math.hypot(candidate.x - outer.x, candidate.y - outer.y) < outer.width * .08;
    });
    if (!inner) continue;
    if (eyes.some(eye => Math.hypot(eye.x - outer.x * factor, eye.y - outer.y * factor) < outer.width * factor * .3)) continue;
    eyes.push({ x: outer.x * factor, y: outer.y * factor, diameter: outer.width * factor });
  }
  return eyes.sort((a, b) => b.diameter - a.diameter).slice(0, 30);
}

function sampleTriplet(rgba: ArrayLike<number>, width: number, height: number, a: Eye, b: Eye, c: Eye): string {
  const bits = new Uint8Array(2040);
  const slots = getPolarSlots();
  for (let i = 0; i < bits.length; i++) {
    const slot = slots[i];
    const u = (slot.x - .22) / .56, v = (slot.y - .22) / .56;
    const x = Math.round(a.x + u * (b.x - a.x) + v * (c.x - a.x));
    const y = Math.round(a.y + u * (b.y - a.y) + v * (c.y - a.y));
    if (x < 0 || y < 0 || x >= width || y >= height) throw new Error('symbol extends outside frame');
    bits[i] = luminance(rgba, width, x, y) > 95 ? 1 : 0;
  }
  return decodePolarBits(bits);
}

/** Locate three circular finder eyes in a full RGBA frame and decode the code. */
export function decodePolarFrame(rgba: ArrayLike<number>, width: number, height: number): PolarFrameResult | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 200 || height < 200 || rgba.length < width * height * 4) {
    throw new RangeError('expected a full RGBA camera frame of at least 200 by 200 pixels');
  }
  const eyes = findEyeCandidates(rgba, width, height);
  if (eyes.length < 3) return null;
  for (let i = 0; i < eyes.length; i++) for (let j = i + 1; j < eyes.length; j++) for (let k = j + 1; k < eyes.length; k++) {
    const trio = [eyes[i], eyes[j], eyes[k]];
    for (let corner = 0; corner < 3; corner++) {
      const a = trio[corner], b = trio[(corner + 1) % 3], c = trio[(corner + 2) % 3];
      const abx = b.x - a.x, aby = b.y - a.y, acx = c.x - a.x, acy = c.y - a.y;
      const lab = Math.hypot(abx, aby), lac = Math.hypot(acx, acy);
      if (lab < 70 || lac < 70 || Math.abs(lab - lac) / Math.max(lab, lac) > .35) continue;
      if (Math.abs((abx * acx + aby * acy) / (lab * lac)) > .35) continue;
      if (Math.max(a.diameter, b.diameter, c.diameter) / Math.min(a.diameter, b.diameter, c.diameter) > 1.8) continue;
      for (const [right, down] of [[b, c], [c, b]]) {
        try {
          const payload = sampleTriplet(rgba, width, height, a, right, down);
          return { payload, eyes: [{ x: a.x, y: a.y }, { x: right.x, y: right.y }, { x: down.x, y: down.y }], symbolSize: (lab + lac) / 1.12 };
        } catch { /* Another candidate or orientation may decode. */ }
      }
    }
  }
  return null;
}
