import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const result = await build({
  entryPoints: [resolve(root, 'site-src/client.ts')],
  bundle: true,
  minify: true,
  platform: 'browser',
  format: 'iife',
  write: false,
  target: 'es2022'
});
const html = await readFile(resolve(root, 'site-src/index.html'), 'utf8');
const standalone = html.replace('<script type="module" src="/app.js"></script>', `<script>${result.outputFiles[0].text}</script>`);
await writeFile(resolve(root, '../../outputs/asterhalo-generator.html'), standalone);
