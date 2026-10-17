import { renderParticleSvg, type ParticleRenderOptions } from './particle.js';
import type { EncodedCode } from './encode.js';

export type RenderOptions = ParticleRenderOptions;

/** Render the experimental particle matrix as a self-contained SVG. */
export function renderSvg(input: string | EncodedCode, options: RenderOptions = {}): string {
  return renderParticleSvg(input, options);
}

/** Browser PNG export. Node callers can rasterize renderSvg with their image pipeline. */
export async function renderPng(input: string | EncodedCode, options: RenderOptions = {}): Promise<Blob> {
  if (typeof document === 'undefined') throw new Error('PNG rendering requires a browser canvas; use SVG in Node.js');
  const svg = renderSvg(input, options);
  const image = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('SVG image could not be rendered'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = options.size ?? 800;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D canvas unavailable');
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export failed')), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
