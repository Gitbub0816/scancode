import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser';
import { decodePolarRgba } from './polar.js';
import { decodePolarFrame } from './locate.js';

export interface Scanner {
  stop(): void;
}

/** Use the same ISO QR decoder in the branded camera view. Requires HTTPS or localhost. */
export async function startCameraScanner(
  video: HTMLVideoElement,
  onResult: (payload: string) => void,
  options: { deviceId?: string; onError?: (error: Error) => void } = {}
): Promise<Scanner> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires HTTPS or localhost');
  const reader = new BrowserQRCodeReader();
  let last = '';
  let lastAt = 0;
  const controls: IScannerControls = await reader.decodeFromVideoDevice(options.deviceId, video, (result, error) => {
    if (result) {
      const payload = result.getText();
      const now = Date.now();
      if (payload !== last || now - lastAt > 2000) {
        last = payload;
        lastAt = now;
        onResult(payload);
      }
    } else if (error && error.name !== 'NotFoundException' && error.name !== 'ChecksumException' && error.name !== 'FormatException') {
      options.onError?.(error);
    }
  });
  return { stop: () => controls.stop() };
}

export interface PolarScannerOptions {
  deviceId?: string;
  /** Fraction of the shorter video dimension occupied by the guided capture square. */
  captureFraction?: number;
  /** Time between decode attempts; defaults to 350 ms. */
  intervalMs?: number;
  onError?: (error: Error) => void;
}

/**
 * Browser scanner for AsterHalo Polar. Finder eyes locate the symbol anywhere
 * in the frame; a guided center crop remains as a fallback for difficult light.
 * This is not a stock-camera scanner.
 */
export async function startPolarCameraScanner(
  video: HTMLVideoElement,
  onResult: (payload: string) => void,
  options: PolarScannerOptions = {}
): Promise<Scanner> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires HTTPS or localhost');
  const fraction = options.captureFraction ?? .9;
  const interval = options.intervalMs ?? 350;
  if (!Number.isFinite(fraction) || fraction < .3 || fraction > 1) throw new RangeError('captureFraction must be .3-1');
  if (!Number.isFinite(interval) || interval < 100 || interval > 5000) throw new RangeError('intervalMs must be 100-5000');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: options.deviceId ? { deviceId: { exact: options.deviceId } } : { facingMode: { ideal: 'environment' } }
  });
  video.srcObject = stream;
  video.playsInline = true;
  try { await video.play(); }
  catch (error) {
    stream.getTracks().forEach(track => track.stop());
    video.srcObject = null;
    throw error;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 800;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    stream.getTracks().forEach(track => track.stop());
    throw new Error('Canvas 2D context unavailable');
  }
  let stopped = false;
  let timer = 0;
  let last = '';
  let lastAt = 0;
  const attempt = () => {
    if (stopped) return;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const frameScale = Math.min(1, 1200 / Math.max(video.videoWidth, video.videoHeight));
      const frameWidth = Math.round(video.videoWidth * frameScale);
      const frameHeight = Math.round(video.videoHeight * frameScale);
      if (canvas.width !== frameWidth || canvas.height !== frameHeight) {
        canvas.width = frameWidth;
        canvas.height = frameHeight;
      }
      context.drawImage(video, 0, 0, frameWidth, frameHeight);
      let payload = decodePolarFrame(context.getImageData(0, 0, frameWidth, frameHeight).data, frameWidth, frameHeight)?.payload;
      if (!payload) {
      const side = Math.min(video.videoWidth, video.videoHeight) * fraction;
      const left = (video.videoWidth - side) / 2;
      const top = (video.videoHeight - side) / 2;
      canvas.width = canvas.height = 800;
      context.drawImage(video, left, top, side, side, 0, 0, 800, 800);
      try {
        const image = context.getImageData(0, 0, 800, 800);
        const offsets = [[0, 0], [-6, 0], [6, 0], [0, -6], [0, 6]];
        for (const angleDegrees of [0, -3, 3]) {
          for (const scale of [1, .98, 1.02, .96, .95, 1.04]) {
            for (const [offsetX, offsetY] of offsets) {
              try {
                payload = decodePolarRgba(image.data, 800, 800, { scale, offsetX, offsetY, angleDegrees });
                break;
              } catch { /* Try the next guided alignment. */ }
            }
            if (payload) break;
          }
          if (payload) break;
        }
        if (!payload) throw new Error('No aligned polar code in frame');
      } catch (error) {
        // Most camera frames do not contain a centered, readable symbol.
        if (error instanceof TypeError || error instanceof RangeError) options.onError?.(error);
      }
      }
      if (payload) {
        const now = Date.now();
        if (payload !== last || now - lastAt > 2000) {
          last = payload;
          lastAt = now;
          onResult(payload);
        }
      }
    }
    timer = window.setTimeout(attempt, interval);
  };
  timer = window.setTimeout(attempt, interval);
  return {
    stop() {
      stopped = true;
      window.clearTimeout(timer);
      stream.getTracks().forEach(track => track.stop());
      if (video.srcObject === stream) video.srcObject = null;
    }
  };
}
