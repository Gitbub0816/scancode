import { decodePolarBits, getPolarSlots } from './polar.js';

interface Dot { x: number; y: number; area: number }
interface Waypoint { x: number; y: number; score: number; spacing: number }

export interface PolarFrameResult {
  payload: string;
  /** Centers of the two three-dot waypoints in input-image pixels. */
  waypoints: readonly [{ x: number; y: number }, { x: number; y: number }];
  /** Approximate horizontal symbol width in input-image pixels. */
  symbolSize: number;
}

function luminance(rgba: ArrayLike<number>, width: number, x: number, y: number): number {
  const p = (y * width + x) * 4;
  return .2126 * Number(rgba[p]) + .7152 * Number(rgba[p + 1]) + .0722 * Number(rgba[p + 2]);
}

/** Locate unusually large, bright particles rather than adding separate finder shapes. */
function markerDots(rgba: ArrayLike<number>, width: number, height: number, threshold: number): Dot[] {
  const light = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4;
    const r = Number(rgba[p]), g = Number(rgba[p + 1]), b = Number(rgba[p + 2]);
    light[y * width + x] = r > threshold && g > threshold && b > threshold && Math.max(r, g, b) - Math.min(r, g, b) < 68 ? 1 : 0;
  }
  const seen = new Uint8Array(light.length), queue = new Int32Array(light.length), dots: Dot[] = [];
  for (let start = 0; start < light.length; start++) {
    if (!light[start] || seen[start]) continue;
    let head = 0, tail = 0, area = 0, sx = 0, sy = 0, minX = width, maxX = 0, minY = height, maxY = 0;
    queue[tail++] = start; seen[start] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % width, y = (p / width) | 0;
      area++; sx += x; sy += y;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        const nx = x + ox, ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (light[n] && !seen[n]) { seen[n] = 1; queue[tail++] = n; }
      }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (area < 3 || area > 130 || bw < 2 || bh < 2 || bw > 18 || bh > 18 || bw / bh < .55 || bw / bh > 1.8) continue;
    dots.push({ x: sx / area, y: sy / area, area });
  }
  return dots.sort((a, b) => b.area - a.area).slice(0, 96);
}

function waypointCandidates(dots: Dot[]): Waypoint[] {
  const found: Waypoint[] = [];
  for (let middle = 0; middle < dots.length; middle++) {
    const m = dots[middle];
    const near: Dot[] = [];
    for (const dot of dots) {
      const d = Math.hypot(dot.x - m.x, dot.y - m.y);
      if (d >= 3 && d <= 23 && Math.max(dot.area, m.area) / Math.min(dot.area, m.area) < 2.6) near.push(dot);
    }
    for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
      const a = near[i], b = near[j];
      const ax = a.x - m.x, ay = a.y - m.y, bx = b.x - m.x, by = b.y - m.y;
      const da = Math.hypot(ax, ay), db = Math.hypot(bx, by);
      if (Math.abs(da - db) / Math.max(da, db) > .32) continue;
      if ((ax * bx + ay * by) / (da * db) > -.86) continue;
      const offset = Math.hypot((a.x + b.x) / 2 - m.x, (a.y + b.y) / 2 - m.y);
      if (offset > Math.max(2.6, .24 * Math.max(da, db))) continue;
      const x = (a.x + m.x + b.x) / 3, y = (a.y + m.y + b.y) / 3;
      if (found.some(w => Math.hypot(w.x - x, w.y - y) < 5)) continue;
      found.push({ x, y, score: a.area + m.area + b.area - offset * 2, spacing: (da + db) / 2 });
    }
  }
  return found.sort((a, b) => b.score - a.score).slice(0, 16);
}

function sample(rgba: ArrayLike<number>, width: number, height: number, a: Waypoint, b: Waypoint, q: number, offsetX: number, offsetY: number): string {
  const dx = b.x - a.x, dy = b.y - a.y, chord = Math.hypot(dx, dy);
  const cos = dx / chord, sin = dy / chord;
  const sizeX = chord / (.42 * Math.SQRT2), sizeY = sizeX * q;
  const cx = (a.x + b.x) / 2 - sin * chord * q / 2 + offsetX;
  const cy = (a.y + b.y) / 2 + cos * chord * q / 2 + offsetY;
  const slots = getPolarSlots(), bits = new Uint8Array(slots.length);
  for (let i = 0; i < bits.length; i++) {
    const slot = slots[i], xx = (slot.x - .5) * sizeX, yy = (slot.y - .5) * sizeY;
    const x = Math.round(cx + xx * cos - yy * sin), y = Math.round(cy + xx * sin + yy * cos);
    if (x < 0 || y < 0 || x >= width || y >= height) throw new Error('symbol extends outside frame');
    bits[i] = luminance(rgba, width, x, y) > 95 ? 1 : 0;
  }
  return decodePolarBits(bits);
}

/** Locate two triple-dot waypoints and read the one-row ring plus cloud data. */
export function decodePolarFrame(rgba: ArrayLike<number>, width: number, height: number): PolarFrameResult | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 200 || height < 200 || rgba.length < width * height * 4) {
    throw new RangeError('expected a full RGBA camera frame of at least 200 by 200 pixels');
  }
  const ratios = [1, .66, .662, .75, .8, .9, 1.1, ...Array.from({ length: 61 }, (_, i) => .6 + i * .01)];
  const offsets = [[0, 0], [0, .5], [0, -.5], [-.5, 0], [.5, 0], [-.5, -.5], [.5, .5], [-.5, .5], [.5, -.5]];
  for (const threshold of [185, 170]) {
  const waypoints = waypointCandidates(markerDots(rgba, width, height, threshold));
  for (let i = 0; i < waypoints.length; i++) for (let j = i + 1; j < waypoints.length; j++) {
    const a = waypoints[i], b = waypoints[j], chord = Math.hypot(a.x - b.x, a.y - b.y);
    if (chord < 90 || chord > Math.max(width, height) * .9) continue;
    const spacingRatio = chord / ((a.spacing + b.spacing) / 2);
    if (spacingRatio < 32 || spacingRatio > 78) continue;
    for (const [left, right] of [[a, b], [b, a]]) for (const q of ratios) for (const [offsetX, offsetY] of offsets) {
      try {
        const payload = sample(rgba, width, height, left, right, q, offsetX, offsetY);
        return { payload, waypoints: [{ x: left.x, y: left.y }, { x: right.x, y: right.y }], symbolSize: chord / (.42 * Math.SQRT2) };
      } catch { /* Try the next geometric hypothesis. */ }
    }
  }
  }
  return null;
}
