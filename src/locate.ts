import { decodePolarBits, getPolarSlots } from './polar.js';

interface Dot { x: number; y: number; area: number }
interface Waypoint { x: number; y: number; score: number; spacing: number; dots: readonly [Dot, Dot, Dot] }

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
  return dots.sort((a, b) => b.area - a.area).slice(0, 192);
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
      found.push({ x, y, score: a.area + m.area + b.area - offset * 2, spacing: (da + db) / 2, dots: [a, m, b] });
    }
  }
  return found.sort((a, b) => b.score - a.score).slice(0, 64);
}

type Projection = [number, number, number, number, number, number];

function project(p: Projection, u: number, v: number): [number, number] {
  const [cx, cy, sx, sy, angle, depth] = p;
  const cosine = Math.cos(angle), sine = Math.sin(angle), denominator = 1 + depth * v;
  return [cx + (sx * u * cosine - sy * v * sine) / denominator,
    cy + (sx * u * sine + sy * v * cosine) / denominator];
}

function inverse(p: Projection, x: number, y: number): [number, number] {
  const [cx, cy, sx, sy, angle, depth] = p;
  const cosine = Math.cos(angle), sine = Math.sin(angle), dx = x - cx, dy = y - cy;
  const uu = cosine * dx + sine * dy, vv = -sine * dx + cosine * dy;
  const v = vv / (sy - depth * vv);
  return [uu * (1 + depth * v) / sx, v];
}

/** Fit the visible data circle as a projected circle, using the six waypoint dots to fix its rotation. */
function initialProjection(left: Waypoint, right: Waypoint): Projection {
  const chord = Math.hypot(right.x - left.x, right.y - left.y);
  const angle = Math.atan2(right.y - left.y, right.x - left.x);
  const sx = chord / (.42 * Math.SQRT2);
  const midX = (left.x + right.x) / 2, midY = (left.y + right.y) / 2;
  return [midX - .297 * sx * Math.sin(angle), midY + .297 * sx * Math.cos(angle), sx, sx, angle, 0];
}

function projectionInside(p: Projection, width: number, height: number): boolean {
  for (const [u, v] of [[.42, 0], [-.42, 0], [0, .42], [0, -.42]]) {
    const [x, y] = project(p, u, v);
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
  }
  return true;
}

function fitProjection(left: Waypoint, right: Waypoint, dots: Dot[]): Projection {
  const initial = initialProjection(left, right);
  const chord = Math.hypot(right.x - left.x, right.y - left.y);
  const axisX = (right.x - left.x) / chord, axisY = (right.y - left.y) / chord;
  const ordered = (point: Waypoint) => [...point.dots].sort((a, b) =>
    (a.x * axisX + a.y * axisY) - (b.x * axisX + b.y * axisY));
  const observed = [...ordered(left), ...ordered(right)];
  const source = [5 * Math.PI / 4, 7 * Math.PI / 4].flatMap(base => [-.029, 0, .029]
    .map(offset => [.42 * Math.cos(base + offset), .42 * Math.sin(base + offset)]));
  const ring = dots.filter(dot => {
    const [u, v] = inverse(initial, dot.x, dot.y);
    const radius = Math.hypot(u, v);
    return radius > .34 && radius < .52 && dot.area < Math.max(50, left.score / 2);
  });
  const loss = (p: Projection): number => {
    if (p[2] < 100 || p[3] < 100 || Math.abs(p[5]) > 1.5) return 1e15;
    let sum = 0;
    for (let i = 0; i < 6; i++) {
      const [x, y] = project(p, source[i][0], source[i][1]);
      sum += .5 * ((x - observed[i].x) ** 2 + (y - observed[i].y) ** 2);
    }
    for (const dot of ring) {
      const [u, v] = inverse(p, dot.x, dot.y);
      const error = (Math.hypot(u, v) - .42) * 1000;
      sum += Math.min(error * error, 4000);
    }
    return sum;
  };
  const simplex: Projection[] = [initial];
  const step = [4, 4, 8, 8, .007, .04];
  for (let i = 0; i < 6; i++) {
    const trial = [...initial] as Projection;
    trial[i] += step[i];
    simplex.push(trial);
  }
  let values = simplex.map(loss);
  for (let iteration = 0; iteration < 450; iteration++) {
    const order = Array.from({ length: 7 }, (_, i) => i).sort((a, b) => values[a] - values[b]);
    const sorted = order.map(i => simplex[i]);
    const sortedValues = order.map(i => values[i]);
    simplex.splice(0, 7, ...sorted);
    values = sortedValues;
    const center = Array(6).fill(0);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) center[j] += simplex[i][j] / 6;
    const trial = (factor: number) => center.map((value, j) => value + factor * (center[j] - simplex[6][j])) as Projection;
    const reflected = trial(1), reflectedLoss = loss(reflected);
    if (reflectedLoss < values[0]) {
      const expanded = trial(2), expandedLoss = loss(expanded);
      simplex[6] = expandedLoss < reflectedLoss ? expanded : reflected;
      values[6] = Math.min(expandedLoss, reflectedLoss);
    } else if (reflectedLoss < values[5]) {
      simplex[6] = reflected; values[6] = reflectedLoss;
    } else {
      const contracted = trial(reflectedLoss < values[6] ? .5 : -.5), contractedLoss = loss(contracted);
      if (contractedLoss < Math.min(reflectedLoss, values[6])) {
        simplex[6] = contracted; values[6] = contractedLoss;
      } else {
        for (let i = 1; i < 7; i++) {
          simplex[i] = simplex[0].map((value, j) => (value + simplex[i][j]) / 2) as Projection;
          values[i] = loss(simplex[i]);
        }
      }
    }
  }
  return simplex[values.indexOf(Math.min(...values))];
}

function ringSupport(left: Waypoint, right: Waypoint, dots: Dot[]): number {
  const p = initialProjection(left, right);
  const sectors = new Uint8Array(16);
  let count = 0;
  for (const dot of dots) {
    const [u, v] = inverse(p, dot.x, dot.y);
    const radius = Math.hypot(u, v);
    if (Math.abs(radius - .42) > .035) continue;
    count++;
    sectors[Math.floor(((Math.atan2(v, u) + Math.PI) / (2 * Math.PI)) * 16) % 16] = 1;
  }
  return count + sectors.reduce((sum, value) => sum + value, 0) * 6;
}

function waypointGeometry(a: Waypoint, b: Waypoint): boolean {
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  const axisX = (b.x - a.x) / chord, axisY = (b.y - a.y) / chord;
  const tangent = (point: Waypoint): [number, number] => {
    const ordered = [...point.dots].sort((x, y) =>
      (x.x * axisX + x.y * axisY) - (y.x * axisX + y.y * axisY));
    const dx = ordered[2].x - ordered[0].x, dy = ordered[2].y - ordered[0].y;
    const length = Math.hypot(dx, dy);
    return [(dx * axisX + dy * axisY) / length, (axisX * dy - axisY * dx) / length];
  };
  const [aAlong, aAcross] = tangent(a), [bAlong, bAcross] = tangent(b);
  return aAlong > .45 && aAlong < .92 && bAlong > .45 && bAlong < .92 && aAcross * bAcross < -.15;
}

function sampleProjection(rgba: ArrayLike<number>, width: number, height: number, p: Projection): string {
  const slots = getPolarSlots(), bits = new Uint8Array(slots.length);
  for (let i = 0; i < bits.length; i++) {
    const [x, y] = project(p, slots[i].x - .5, slots[i].y - .5);
    const xx = Math.round(x), yy = Math.round(y);
    if (xx < 0 || yy < 0 || xx >= width || yy >= height) throw new Error('symbol extends outside frame');
    bits[i] = luminance(rgba, width, xx, yy) > 105 ? 1 : 0;
  }
  return decodePolarBits(bits);
}

function fieldContrast(rgba: ArrayLike<number>, width: number, height: number, p: Projection): number {
  const values = new Float32Array(getPolarSlots().length);
  const slots = getPolarSlots();
  for (let i = 0; i < slots.length; i++) {
    const [x, y] = project(p, slots[i].x - .5, slots[i].y - .5);
    const xx = Math.round(x), yy = Math.round(y);
    if (xx < 0 || yy < 0 || xx >= width || yy >= height) return -Infinity;
    values[i] = luminance(rgba, width, xx, yy);
  }
  values.sort();
  let score = 0;
  for (let i = 0; i < values.length / 2; i++) score += values[i + values.length / 2] - values[i];
  return score;
}

function fieldVariance(rgba: ArrayLike<number>, width: number, height: number, p: Projection): number {
  let sum = 0, squares = 0;
  const slots = getPolarSlots();
  for (const slot of slots) {
    const [x, y] = project(p, slot.x - .5, slot.y - .5);
    const xx = Math.round(x), yy = Math.round(y);
    if (xx < 0 || yy < 0 || xx >= width || yy >= height) return -Infinity;
    const value = luminance(rgba, width, xx, yy);
    sum += value; squares += value * value;
  }
  const mean = sum / slots.length;
  return squares / slots.length - mean * mean;
}

function refineProjection(rgba: ArrayLike<number>, width: number, height: number, initial: Projection): Projection {
  const simplex: Projection[] = [initial];
  const step = [2, 2, 4, 4, .005, .03];
  for (let i = 0; i < 6; i++) {
    const trial = [...initial] as Projection;
    trial[i] += step[i];
    simplex.push(trial);
  }
  let values = simplex.map(p => -fieldVariance(rgba, width, height, p));
  for (let iteration = 0; iteration < 600; iteration++) {
    const order = Array.from({ length: 7 }, (_, i) => i).sort((a, b) => values[a] - values[b]);
    const sorted = order.map(i => simplex[i]), sortedValues = order.map(i => values[i]);
    simplex.splice(0, 7, ...sorted); values = sortedValues;
    const center = Array(6).fill(0);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) center[j] += simplex[i][j] / 6;
    const trial = (factor: number) => center.map((value, j) => value + factor * (center[j] - simplex[6][j])) as Projection;
    const reflected = trial(1), reflectedLoss = -fieldVariance(rgba, width, height, reflected);
    if (reflectedLoss < values[0]) {
      const expanded = trial(2), expandedLoss = -fieldVariance(rgba, width, height, expanded);
      simplex[6] = expandedLoss < reflectedLoss ? expanded : reflected;
      values[6] = Math.min(expandedLoss, reflectedLoss);
    } else if (reflectedLoss < values[5]) {
      simplex[6] = reflected; values[6] = reflectedLoss;
    } else {
      const contracted = trial(reflectedLoss < values[6] ? .5 : -.5);
      const contractedLoss = -fieldVariance(rgba, width, height, contracted);
      if (contractedLoss < Math.min(reflectedLoss, values[6])) {
        simplex[6] = contracted; values[6] = contractedLoss;
      } else {
        for (let i = 1; i < 7; i++) {
          simplex[i] = simplex[0].map((value, j) => (value + simplex[i][j]) / 2) as Projection;
          values[i] = -fieldVariance(rgba, width, height, simplex[i]);
        }
      }
    }
  }
  return simplex[values.indexOf(Math.min(...values))];
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
  const dots = markerDots(rgba, width, height, threshold);
  const waypoints = waypointCandidates(dots);
  const pairs: [Waypoint, Waypoint][] = [];
  for (let i = 0; i < waypoints.length; i++) for (let j = i + 1; j < waypoints.length; j++) {
    const a = waypoints[i], b = waypoints[j], chord = Math.hypot(a.x - b.x, a.y - b.y);
    const spacingRatio = chord / ((a.spacing + b.spacing) / 2);
    if (chord >= 90 && chord <= Math.max(width, height) * .9 && spacingRatio >= 32 && spacingRatio <= 78 && waypointGeometry(a, b) &&
      (projectionInside(initialProjection(a, b), width, height) || projectionInside(initialProjection(b, a), width, height))) pairs.push([a, b]);
  }
  pairs.sort((a, b) => ringSupport(b[0], b[1], dots) - ringSupport(a[0], a[1], dots));
  for (const [a, b] of pairs.slice(0, 3)) for (const [left, right] of [[a, b], [b, a]]) {
    const fitted = fitProjection(left, right, dots);
    const angles = Array.from({ length: 41 }, (_, i) => {
      const projection = [...fitted] as Projection;
      projection[4] += (i - 20) * .002;
      return { projection, score: fieldContrast(rgba, width, height, projection) };
    }).sort((x, y) => y.score - x.score).slice(0, 5);
    for (const angle of angles) {
      for (const [dx, dy] of [[0, 0], ...Array.from({ length: 12 }, (_, i) => (i + 1) * .5)
        .flatMap(step => [[step, 0], [-step, 0], [0, step], [0, -step]])]) {
        for (const shiftY of [dy, dy + .5, dy - .5]) {
          const adjusted = [...angle.projection] as Projection;
          adjusted[0] += dx; adjusted[1] += shiftY;
          try {
            const payload = sampleProjection(rgba, width, height, adjusted);
            return { payload, waypoints: [{ x: left.x, y: left.y }, { x: right.x, y: right.y }], symbolSize: fitted[2] };
          } catch { /* Try the next subpixel alignment. */ }
        }
      }
    }
    if (projectionInside(fitted, width, height)) {
      const refined = refineProjection(rgba, width, height, fitted);
      for (let ai = -4; ai <= 4; ai++) for (let xi = -2; xi <= 2; xi++) for (let yi = -2; yi <= 2; yi++) {
        const adjusted = [...refined] as Projection;
        adjusted[0] += xi * .5; adjusted[1] += yi * .5; adjusted[4] += ai * .001;
        try {
          const payload = sampleProjection(rgba, width, height, adjusted);
          return { payload, waypoints: [{ x: left.x, y: left.y }, { x: right.x, y: right.y }], symbolSize: fitted[2] };
        } catch { /* Try the next refined alignment. */ }
      }
    }
  }
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
