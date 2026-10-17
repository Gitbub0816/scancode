import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const client = await build({ entryPoints: [resolve(root, 'site-src/client.ts')], bundle: true, minify: true, platform: 'browser', format: 'iife', write: false, target: 'es2022' });
const html = await readFile(resolve(root, 'site-src/index.html'), 'utf8');
const worker = await readFile(resolve(root, 'site-src/worker.ts'), 'utf8');
const source = worker.replace('declare const __SITE_HTML__: string;', `const __SITE_HTML__ = ${JSON.stringify(html)};`).replace('declare const __CLIENT_JS__: string;', `const __CLIENT_JS__ = ${JSON.stringify(client.outputFiles[0].text)};`);
const temp = resolve(root, 'site-src/.worker-generated.ts');
await writeFile(temp, source);
try {
  const result = await build({ entryPoints: [temp], bundle: true, minify: true, platform: 'browser', format: 'esm', write: false, target: 'es2022', external: [] });
  const out = resolve(root, 'site-dist/worker');
  await mkdir(out, { recursive: true });
  await writeFile(resolve(out, 'index.js'), result.outputFiles[0].text);
} finally {
  const { unlink } = await import('node:fs/promises');
  await unlink(temp);
}
