import { encode, type EncodedCode } from './encode.js';

export interface ParticleRenderOptions {
  size?: number;
  mark?: string;
  /** Experimental center window, as a fraction of the QR's total width. Keep <= .15. */
  centerRadius?: number;
}

const escapeXml = (value: string) => value.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/**
 * An experimental QR artwork: the data modules become ink particles inside a
 * luminous orb. The QR lattice and its three standard finder patterns remain.
 * This is a visual encoding, not a new barcode symbology.
 */
export function renderParticleSvg(input: string | EncodedCode, options: ParticleRenderOptions = {}): string {
  const code = typeof input === 'string' ? encode(input) : input;
  const size = options.size ?? 800;
  const centerRadius = options.centerRadius ?? .10;
  if (!Number.isInteger(size) || size < 320 || size > 4096) throw new RangeError('size must be 320-4096');
  if (!Number.isFinite(centerRadius) || centerRadius < 0 || centerRadius > .15) {
    throw new RangeError('centerRadius must be 0-.15; larger cutouts are not scan-safe');
  }
  const cx = size / 2;
  const width = size * .49;
  const cell = width / (code.size + 8);
  const start = cx - width / 2 + 4 * cell;
  const core = width * centerRadius;
  const scale = size / 800;
  const pieces: string[] = [];
  const vapor: string[] = [];

  for (let layer = 0; layer < 7; layer++) {
    const points: string[] = [];
    for (let i = 0; i <= 128; i++) {
      const a = i * Math.PI * 2 / 128;
      const r = size * (.123 + layer * .015
        + Math.sin(a * 5 + layer * .74) * .013
        + Math.sin(a * 9 - layer * .42) * .008);
      const x = cx + Math.cos(a) * r;
      const y = cx + Math.sin(a) * r;
      points.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`);
    }
    const color = ['#6ce9ee', '#e580c9', '#eac879', '#83d5ee'][layer % 4];
    vapor.push(`<path d="${points.join(' ')}" fill="none" stroke="${color}" stroke-opacity=".27" stroke-width="${((layer % 2 ? 19 : 11) * scale).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }

  // The cloud is colorful, but every light area is held at high luminance.
  // Dark QR particles are drawn last and stay at a stable low luminance.
  for (let i = 0; i < 410; i++) {
    const a = i * 2.399963229728653;
    const r = size * (.08 + ((i * 73) % 173) / 1000);
    const x = cx + Math.cos(a + Math.sin(i * .17) * .34) * r;
    const y = cx + Math.sin(a + Math.cos(i * .13) * .34) * r;
    const shade = i % 4 === 0 ? '#ff9bd5' : i % 3 === 0 ? '#83ecf5' : '#f4d990';
    const dot = (i % 13 === 0 ? 3.3 : 1.35) * scale;
    pieces.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${dot.toFixed(2)}" fill="${shade}" opacity=".58"/>`);
  }
  const modules: string[] = [];
  for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++) {
    if (!code.modules[y][x]) continue;
    const px = start + (x + .5) * cell;
    const py = start + (y + .5) * cell;
    if (Math.hypot(px - cx, py - cx) < core) continue;
    const finder = (x < 7 && y < 7) || (x >= code.size - 7 && y < 7) || (x < 7 && y >= code.size - 7);
    if (!finder) {
      const tone = ['#09243a', '#341d42', '#0b3438', '#311c3a'][(x + y * 3) % 4];
      const dx = Math.sin(x * 17.13 + y * 8.31) * cell * .075;
      const dy = Math.sin(x * 5.73 - y * 19.11) * cell * .075;
      const radius = cell * (.45 + .025 * Math.sin(x * 2.71 + y * 5.31));
      modules.push(`<circle cx="${(px + dx).toFixed(3)}" cy="${(py + dy).toFixed(3)}" r="${radius.toFixed(3)}" fill="${tone}"/>`);
    }
  }
  const eyes: string[] = [];
  for (const [x, y] of [[3.5, 3.5], [code.size - 3.5, 3.5], [3.5, code.size - 3.5]]) {
    const px = start + x * cell;
    const py = start + y * cell;
    eyes.push(`<circle cx="${px.toFixed(3)}" cy="${py.toFixed(3)}" r="${(3.5 * cell).toFixed(3)}" fill="#071c2b"/><circle cx="${px.toFixed(3)}" cy="${py.toFixed(3)}" r="${(2.5 * cell).toFixed(3)}" fill="#78b6ca"/><circle cx="${px.toFixed(3)}" cy="${py.toFixed(3)}" r="${(1.5 * cell).toFixed(3)}" fill="#071c2b"/>`);
  }
  const ringBits: string[] = [];
  for (let ring = 0; ring < 4; ring++) {
    const radius = size * (.37 + ring * .034);
    ringBits.push(`<circle cx="${cx}" cy="${cx}" r="${radius.toFixed(2)}" fill="none" stroke="${ring % 2 ? '#b8faff' : '#63ddeb'}" stroke-opacity="${ring === 1 ? '.73' : '.42'}" stroke-width="${ring === 1 ? 2.5 * scale : 1.4 * scale}" stroke-dasharray="${ring % 2 ? `${(size * .15).toFixed(1)} ${(size * .05).toFixed(1)}` : `${(size * .065).toFixed(1)} ${(size * .023).toFixed(1)}`}"/>`);
  }
  for (let i = 0; i < 192; i++) {
    const a = i * Math.PI * 2 / 192;
    const r = size * (i % 11 === 0 ? .454 : .438);
    const x = cx + Math.cos(a) * r;
    const y = cx + Math.sin(a) * r;
    ringBits.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${((i % 11 === 0 ? 2.7 : 1.35) * scale).toFixed(2)}" fill="${i % 5 === 0 ? '#f2e4fb' : '#a3eff6'}" opacity="${i % 11 === 0 ? '.95' : '.63'}"/>`);
  }
  const mark = options.mark?.trim() ?? '';
  const label = mark ? `<text x="${cx}" y="${(cx + core * .15).toFixed(2)}" text-anchor="middle" dominant-baseline="middle" font-family="system-ui,sans-serif" font-weight="800" font-size="${Math.min(core * .5, size * .023).toFixed(1)}" fill="#ecfbff">${escapeXml(Array.from(mark).slice(0, 3).join(''))}</text>` : '';
  const title = mark ? `<title>${escapeXml(mark.slice(0, 24))}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Experimental scannable particle code" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${title}<defs><radialGradient id="bg"><stop stop-color="#162d41"/><stop offset=".7" stop-color="#071521"/><stop offset="1" stop-color="#030b13"/></radialGradient><radialGradient id="orb"><stop stop-color="#78b6ca"/><stop offset=".65" stop-color="#70afc3"/><stop offset="1" stop-color="#477f9e"/></radialGradient><clipPath id="cloud"><circle cx="${cx}" cy="${cx}" r="${(size * .275).toFixed(2)}"/></clipPath></defs><rect width="${size}" height="${size}" fill="url(#bg)"/><circle cx="${cx}" cy="${cx}" r="${(size * .285).toFixed(2)}" fill="url(#orb)"/><g clip-path="url(#cloud)">${vapor.join('')}${pieces.join('')}</g><g fill="#0a1b31">${modules.join('')}</g>${eyes.join('')}<circle cx="${cx}" cy="${cx}" r="${core.toFixed(2)}" fill="#14263b"/>${label}${ringBits.join('')}</svg>`;
}
