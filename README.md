# AsterHalo Polar

AsterHalo Polar is an experimental **circular code format**. It does not place a square QR image under the artwork. A UTF-8 payload is encoded into 1,024 data-bearing particle positions: 256 in a single outer dotted track and 768 within a luminous inner cloud. Two groups of three consecutive dots mark fixed waypoints on the outer track. The renderer draws the encoded positions directly; ambient particles move behind the fixed data particles.

The public generator is at [gitbub0816.github.io/scancode](https://gitbub0816.github.io/scancode/). It generates codes in the browser, downloads static SVG/PNG or live HTML, and includes a browser camera scanner.

**Scanner status:** the web SDK locates the two three-dot waypoints in a camera frame, then samples the outer track and inner cloud. Native Swift and Android implementations encode, render, and decode the same wire format. Automated raster tests cover rotation, scaling, blur, and compression at reduced displayed sizes; physical camera and print testing is still required. The current affine locator does not correct strong perspective distortion. Stock camera apps do not know this format.

## Wire format, version 3

- Maximum payload: 87 UTF-8 bytes. Use an application-owned short redirect URL for longer destinations.
- Data block: 96 bytes containing a 3-byte marker/version, 2-byte big-endian length, 4-byte CRC-32, UTF-8 payload, and deterministic padding.
- Error correction: Reed–Solomon RS(128,96) over GF(256), 32 parity bytes, correcting up to 16 erroneous bytes per codeword.
- Bit layout: 128 bytes are serialized most-significant-bit first, XOR-whitened by a fixed stream, and deterministically interleaved over 256 outer-track slots and 768 Poisson-spaced inner-cloud slots. The outer track has two reserved gaps for the waypoint triples.
- Bit 1 is a bright colored particle; bit 0 is a dim particle. The waypoint triples establish orientation. Moving vapor is decorative and stays behind fixed encoded particles.

The interleaver, radii, marker, mask seed, and color threshold are experimental. A future stable version needs a published format document and compatibility tests across cameras and printers.

Version 3 reduces payload capacity to keep particles readable at smaller camera sizes. It is not wire-compatible with version 2; regenerate older prototype codes before scanning with this release.

## Web and Node API

```ts
import { encodePolar, decodePolarBits, decodePolarFrame, renderPolarSvg } from 'asterhalo-code';

const payload = 'https://citeory.com/study-buddies/invite/aJ3BnnB12345';
const code = encodePolar(payload);
const svg = renderPolarSvg(code, { size: 800, mark: 'A' });
const samePayload = decodePolarBits(code.bits);
// decodePolarFrame(rgba, width, height) locates and reads a full camera frame.
```

Browser camera use:

```ts
import { startPolarCameraScanner } from 'asterhalo-code';
const scanner = await startPolarCameraScanner(videoElement, text => console.log(text));
// scanner.stop() releases the camera.
```

`renderPolarSvg(payload, { animated: true })` adds motion to the vapor layer while keeping data positions fixed. The generator site downloads static SVG and PNG, or a standalone animated HTML page. `npm run check` builds the package and tests exact URL/Unicode round trips, Reed–Solomon recovery, and raster decoding after rendering.

`node scripts/build-standalone.mjs` produces a single-file generator with the browser scanner. Camera access depends on the browser's secure-context rules; an HTTPS deployment is the intended way to use it on phones.

## Native packages

- iOS: add `native/ios` as a Swift package. `AsterHaloPolar.encodeBits`, `.render`, and `.decode` use the same format; `AsterHaloView` displays the animated symbol and `AsterHaloScanner` owns an AVFoundation camera preview.
- Android: include `native/android/asterhalo` as a Gradle library. `AsterHaloPolar.encodeBits`, `.render`, and `.decode(Bitmap)` use the same format; `AsterHaloView` displays the animated symbol. Pass camera frames as `Bitmap` to `.decode`. A ready-made Android camera screen is not included yet.

## Generator API

`POST /api/v1/codes` accepts JSON such as:

```json
{"payload":"https://example.com/invite/abc","mode":"polar","format":"svg","size":800,"mark":"A"}
```

`mode` defaults to `polar`; `mode: "qr"` invokes the older conventional QR renderer. `format` is `svg` or `json`. The public Worker example has an in-memory 60-per-minute-per-IP limit **per Worker instance**. A real public deployment requires a global edge rate limit, abuse monitoring, and an application-owned redirect service. No service has been deployed from this repository.

## Conventional QR compatibility path

`encode`, `renderSvg`, `renderPng`, `mountAnimated`, `packageAnimatedHtml`, and `startCameraScanner` remain available as the earlier QR-based experiment. The native iOS and Android packages include AsterHalo Polar encoders and decoders. The older conventional QR functions are separate compatibility APIs. These paths are kept separate so users cannot mistake custom polar output for standard QR.

## Development

```sh
npm ci
npm run check
node scripts/build-site.mjs
```

The repository is MIT licensed. The example Citeory URL is fictional and is encoded as text without being fetched.
