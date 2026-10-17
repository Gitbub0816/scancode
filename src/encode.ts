import QRCode from 'qrcode';

export interface EncodedCode {
  readonly payload: string;
  readonly modules: readonly (readonly boolean[])[];
  readonly size: number;
  readonly version: number;
  readonly correction: 'H';
}

/** Encode the exact UTF-8 string. Redirects and shortening belong to the caller's API. */
export function encode(payload: string): EncodedCode {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new TypeError('payload must be a non-empty string');
  }
  if (new TextEncoder().encode(payload).length > 2048) {
    throw new RangeError('payload exceeds the 2048-byte SDK limit; use a short redirect URL');
  }
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'H' });
  const size = qr.modules.size;
  const modules = Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => Boolean(qr.modules.get(x, y)))
  );
  return { payload, modules, size, version: qr.version, correction: 'H' };
}
