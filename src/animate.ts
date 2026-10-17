import { renderSvg, type RenderOptions } from './render.js';

export interface AnimationOptions extends RenderOptions {
  particles?: number;
  fps?: number;
}

export interface AnimatedCode {
  update(payload: string): void;
  pause(): void;
  resume(): void;
  destroy(): void;
}

const vertex = `
attribute vec3 aParticle;
uniform float uTime;
uniform float uPixels;
varying float vTone;
void main() {
  float a = aParticle.x * 6.2831853;
  float layer = aParticle.y;
  float phase = aParticle.z * 6.2831853;
  float wave = sin(a * 7.0 + uTime * .45 + phase) * .012
             + sin(a * 13.0 - uTime * .32 + phase) * .007;
  float centerParticle = step(aParticle.z, .16);
  float r = mix(.62 + layer * .18 + wave, .012 + layer * .068 + wave * .08, centerParticle);
  float drift = uTime * (.032 + layer * .018);
  vec2 p = vec2(cos(a + drift), sin(a + drift)) * r;
  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = max(1.5, uPixels * (.002 + aParticle.z * .0027));
  vTone = fract(aParticle.x * 2.0 + aParticle.y * .5 + uTime * .025);
}`;

const fragment = `
precision mediump float;
varying float vTone;
void main() {
  float d = length(gl_PointCoord - .5);
  float alpha = (1.0 - smoothstep(.20, .5, d)) * .72;
  vec3 cyan = vec3(0.0, .94, 1.0);
  vec3 magenta = vec3(1.0, 0.0, .48);
  vec3 blue = vec3(.145, .388, .922);
  vec3 color = mix(mix(cyan, blue, vTone), magenta, smoothstep(.43, .9, vTone));
  gl_FragColor = vec4(color * alpha, alpha);
}`;

function shader(gl: WebGLRenderingContext, kind: number, source: string): WebGLShader {
  const result = gl.createShader(kind);
  if (!result) throw new Error('WebGL shader allocation failed');
  gl.shaderSource(result, source);
  gl.compileShader(result);
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(result);
    gl.deleteShader(result);
    throw new Error(`WebGL shader failed: ${info}`);
  }
  return result;
}

/** Mount a particle code whose moving layers remain inside the tiny center window and outside the data orb. */
export function mountAnimated(target: HTMLElement, payload: string, options: AnimationOptions = {}): AnimatedCode {
  if (typeof document === 'undefined') throw new Error('mountAnimated requires a browser');
  const size = options.size ?? 800;
  const particles = options.particles ?? 2500;
  const fps = options.fps ?? 30;
  if (!Number.isInteger(particles) || particles < 0 || particles > 10000) throw new RangeError('particles must be 0-10000');
  if (!Number.isFinite(fps) || fps < 1 || fps > 60) throw new RangeError('fps must be 1-60');
  target.replaceChildren();
  target.style.position = 'relative';
  target.style.width = `${size}px`;
  target.style.height = `${size}px`;
  target.style.maxWidth = '100%';
  target.setAttribute('role', 'img');
  target.setAttribute('aria-label', 'Scannable AsterHalo QR code');

  const image = document.createElement('img');
  image.alt = '';
  image.style.cssText = 'display:block;width:100%;height:100%';
  const setImage = (value: string) => { image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSvg(value, options))}`; };
  setImage(payload);
  target.append(image);

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (particles === 0 || reduced) {
    return { update: setImage, pause() {}, resume() {}, destroy() { target.replaceChildren(); } };
  }

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.min(size * (window.devicePixelRatio || 1), 4096);
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
  target.append(canvas);
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true });
  if (!gl) {
    canvas.remove();
    return { update: setImage, pause() {}, resume() {}, destroy() { target.replaceChildren(); } };
  }
  const vs = shader(gl, gl.VERTEX_SHADER, vertex);
  const fs = shader(gl, gl.FRAGMENT_SHADER, fragment);
  const program = gl.createProgram();
  if (!program) throw new Error('WebGL program allocation failed');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`WebGL link failed: ${gl.getProgramInfoLog(program)}`);
  gl.useProgram(program);
  const data = new Float32Array(particles * 3);
  let seed = 0x9e3779b9;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x100000000; };
  for (let i = 0; i < data.length; i++) data[i] = random();
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const attribute = gl.getAttribLocation(program, 'aParticle');
  gl.enableVertexAttribArray(attribute);
  gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 0, 0);
  const time = gl.getUniformLocation(program, 'uTime');
  const pixels = gl.getUniformLocation(program, 'uPixels');
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.uniform1f(pixels, canvas.width);
  let raf = 0;
  let paused = false;
  let destroyed = false;
  let last = 0;
  const draw = (now: number) => {
    if (destroyed || paused) return;
    raf = requestAnimationFrame(draw);
    if (now - last < 1000 / fps) return;
    last = now;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(time, now / 1000);
    gl.drawArrays(gl.POINTS, 0, particles);
  };
  raf = requestAnimationFrame(draw);
  return {
    update: setImage,
    pause() { paused = true; cancelAnimationFrame(raf); },
    resume() { if (!destroyed && paused) { paused = false; raf = requestAnimationFrame(draw); } },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      target.replaceChildren();
    }
  };
}
