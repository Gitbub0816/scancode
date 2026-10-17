#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { renderSvg } from './render.js';
import { packageAnimatedHtml } from './package.js';
import { renderPolarSvg, packagePolarAnimatedHtml } from './polar.js';

const args = process.argv.slice(2);
if (args.includes('--help') || args.length === 0) {
  console.log('Usage: asterhalo <payload> --output code.svg|code.html [--size 800] [--mark LABEL] [--mode polar|qr]');
  process.exit(args.length === 0 ? 1 : 0);
}
const value = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const payload = args[0];
const output = value('--output');
if (!output || !/\.(svg|html)$/i.test(output)) {
  console.error('Output must end in .svg or .html');
  process.exit(2);
}
const size = value('--size') ? Number(value('--size')) : 800;
const options = { size, mark: value('--mark') };
const mode = value('--mode') ?? 'polar';
try {
  if (mode !== 'polar' && mode !== 'qr') throw new TypeError('mode must be polar or qr');
  const svg = output.toLowerCase().endsWith('.svg');
  await writeFile(output, mode === 'polar' ? (svg ? renderPolarSvg(payload, options) : packagePolarAnimatedHtml(payload, options)) : (svg ? renderSvg(payload, options) : packageAnimatedHtml(payload, options)), 'utf8');
  console.log(output);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
