import { encode } from '../src/encode.js';
import { renderSvg } from '../src/render.js';
import { encodePolar, renderPolarSvg } from '../src/polar.js';

declare const __SITE_HTML__: string;
declare const __CLIENT_JS__: string;

const limits = new Map<string, { count: number; until: number }>();
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };

function response(body: string, status: number, contentType: string, extra: Record<string, string> = {}) {
  return new Response(body, { status, headers: { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') return response(__SITE_HTML__, 200, 'text/html; charset=utf-8');
    if (url.pathname === '/app.js' && request.method === 'GET') return response(__CLIENT_JS__, 200, 'text/javascript; charset=utf-8');
    if (url.pathname === '/api/v1/codes' && request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname !== '/api/v1/codes') return response('Not found', 404, 'text/plain; charset=utf-8');
    if (request.method !== 'POST') return response('Method not allowed', 405, 'text/plain; charset=utf-8', { ...cors, allow: 'POST, OPTIONS' });
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const now = Date.now();
    if (limits.size > 10000) for (const [key, value] of limits) if (value.until < now) limits.delete(key);
    const entry = limits.get(ip);
    if (entry && entry.until > now && entry.count >= 60) {
      return response(JSON.stringify({ error: 'rate_limited' }), 429, 'application/json; charset=utf-8', { ...cors, 'retry-after': String(Math.ceil((entry.until - now) / 1000)) });
    }
    if (!entry || entry.until <= now) limits.set(ip, { count: 1, until: now + 60000 });
    else entry.count++;
    if (Number(request.headers.get('content-length') || '0') > 8192) return response(JSON.stringify({ error: 'body_too_large' }), 413, 'application/json; charset=utf-8', cors);
    let body: { payload?: unknown; size?: unknown; format?: unknown; mark?: unknown; mode?: unknown };
    try {
      const raw = await request.text();
      if (raw.length > 8192) throw new RangeError('body_too_large');
      body = JSON.parse(raw);
    } catch {
      return response(JSON.stringify({ error: 'invalid_json' }), 400, 'application/json; charset=utf-8', cors);
    }
    try {
      if (typeof body.payload !== 'string') throw new TypeError('payload must be a string');
      const mode = body.mode ?? 'polar';
      if (mode !== 'polar' && mode !== 'qr') throw new TypeError('mode must be polar or qr');
      const encoded = mode === 'polar' ? encodePolar(body.payload) : encode(body.payload);
      const format = body.format ?? 'svg';
      if (format !== 'svg' && format !== 'json') throw new TypeError('format must be svg or json');
      const size = body.size === undefined ? 800 : body.size;
      if (typeof size !== 'number') throw new TypeError('size must be a number');
      const mark = body.mark === undefined ? undefined : body.mark;
      if (mark !== undefined && typeof mark !== 'string') throw new TypeError('mark must be a string');
      const svg = mode === 'polar' ? renderPolarSvg(encoded as ReturnType<typeof encodePolar>, { size, mark }) : renderSvg(encoded as ReturnType<typeof encode>, { size, mark });
      if (format === 'svg') return response(svg, 200, 'image/svg+xml; charset=utf-8', cors);
      return response(JSON.stringify({ svg, mode, decoder: mode === 'polar' ? 'asterhalo' : 'standard-qr' }), 200, 'application/json; charset=utf-8', cors);
    } catch (error) {
      return response(JSON.stringify({ error: error instanceof Error ? error.message : 'invalid_request' }), 400, 'application/json; charset=utf-8', cors);
    }
  }
};
