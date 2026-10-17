import { encodePolar, renderPolarSvg, packagePolarAnimatedHtml, startPolarCameraScanner, type Scanner } from '../src/index.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const payload = $<HTMLTextAreaElement>('payload');
const mark = $<HTMLInputElement>('mark');
const motion = $<HTMLInputElement>('motion');
const preview = $<HTMLDivElement>('preview');
const status = $<HTMLDivElement>('status');
let current = '';
let scanner: Scanner | null = null;

function generated() {
  const value = payload.value.trim();
  encodePolar(value);
  current = value;
  if (motion.checked) {
    const live = document.createElement('iframe');
    live.title = 'Animated AsterHalo code preview';
    live.setAttribute('sandbox', 'allow-scripts');
    live.srcdoc = packagePolarAnimatedHtml(value, { size: 800, mark: mark.value.trim() });
    preview.replaceChildren(live);
  } else {
    preview.innerHTML = renderPolarSvg(value, { size: 800, mark: mark.value.trim() });
  }
  status.textContent = 'Polar data encoded in the fixed outer ring. The inner cloud moves freely; use the SDK scanner to read it.';
}

function report(error: unknown) { status.textContent = error instanceof Error ? error.message : 'Something went wrong'; }
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function png(svg: string): Promise<Blob> {
  const image = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Could not render the polar image'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 800;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG export failed')), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

$('generate').addEventListener('click', () => { try { generated(); } catch (error) { report(error); } });
motion.addEventListener('change', () => { try { generated(); } catch (error) { report(error); } });
$('svg').addEventListener('click', () => { try { if (!current) generated(); download(new Blob([renderPolarSvg(current, { size: 800, mark: mark.value.trim() })], { type: 'image/svg+xml' }), 'asterhalo-polar.svg'); } catch (error) { report(error); } });
$('png').addEventListener('click', async () => { try { if (!current) generated(); download(await png(renderPolarSvg(current, { size: 800, mark: mark.value.trim() })), 'asterhalo-polar.png'); } catch (error) { report(error); } });
$('html').addEventListener('click', () => {
  try {
    if (!current) generated();
    download(new Blob([packagePolarAnimatedHtml(current, { size: 800, mark: mark.value.trim() })], { type: 'text/html' }), 'asterhalo-polar-live.html');
  } catch (error) { report(error); }
});
$('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(current || payload.value.trim()); status.textContent = 'Payload copied'; } catch (error) { report(error); } });
$('scan').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('scan');
  const video = $<HTMLVideoElement>('camera');
  const result = $<HTMLDivElement>('scan-result');
  if (scanner) {
    scanner.stop(); scanner = null;
    button.textContent = 'Scan with AsterHalo camera';
    video.hidden = true;
    return;
  }
  try {
    scanner = await startPolarCameraScanner(video, value => {
      result.textContent = value;
      status.textContent = 'AsterHalo code decoded';
    }, { onError: report });
    video.hidden = false;
    button.textContent = 'Stop camera';
    result.textContent = 'Show the full circle clearly in the camera frame.';
  } catch (error) { report(error); }
});
try { generated(); } catch (error) { report(error); }
