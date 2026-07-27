// The actual arithmetic. Pure functions, no worker plumbing, so they can be
// exercised directly from a test page.
//
// Two ways of escaping a pixel:
//
//   1. The direct way, in double precision. Fast, and correct until one pixel
//      spans less than about 1e-14 units -- past that a double can't tell
//      neighbouring pixels apart and the image goes blocky.
//
//   2. Perturbation. We take one "reference" point C whose orbit Z(n) has been
//      computed at arbitrary precision, and express every other pixel as
//      c = C + dc. The difference d(n) = z(n) - Z(n) then obeys
//
//          d(n+1) = 2*Z(n)*d(n) + d(n)^2 + dc
//
//      which is all small numbers, so it runs in plain doubles at full speed.
//      One expensive BigInt orbit buys us a whole frame of cheap ones.

import { mul, toNumber } from './fixed.js';

export const ESCAPE_RADIUS = 1024;
const ESCAPE_R2 = ESCAPE_RADIUS * ESCAPE_RADIUS;
const LOG_ESCAPE = Math.log(ESCAPE_RADIUS);

/** Marks a pixel that never escaped, i.e. is (probably) in the set. */
export const INTERIOR = -1;

/** Continuous escape value, so bands blend instead of stepping. */
function smooth(n, modulus2) {
	return n - Math.log(Math.log(Math.sqrt(modulus2)) / LOG_ESCAPE) / Math.LN2;
}

/**
 * The main cardioid and the period-2 bulb are the two biggest pieces of the
 * set and they have closed forms. Testing for them costs a few flops and
 * saves maxIterations of work on every pixel inside them -- which at the
 * opening view is most of the screen.
 */
function inMainBody(x, y) {
	const q = (x - 0.25) * (x - 0.25) + y * y;
	return q * (q + x - 0.25) <= 0.25 * y * y || (x + 1) * (x + 1) + y * y <= 0.0625;
}

// ---------------------------------------------------------------------------
// The reference orbit, computed in arbitrary precision
// ---------------------------------------------------------------------------

/**
 * Iterate z -> z^2 + c at `prec` bits for a single point, recording the orbit
 * as doubles. Storing it as doubles is fine, and is what every deep-zoom
 * renderer does: the rounding error it introduces is shared by every pixel in
 * the frame, so it nudges the whole picture imperceptibly rather than
 * corrupting the structure we're looking at.
 *
 * @param onProgress called every few thousand iterations, for the timer
 */
export function computeReference({ cx, cy, prec, maxIterations }, onProgress) {
	const zr = new Float64Array(maxIterations + 1);
	const zi = new Float64Array(maxIterations + 1);

	let r = 0n;
	let i = 0n;
	let length = maxIterations + 1;

	for (let n = 1; n <= maxIterations; n++) {
		const rr = mul(r, r, prec);
		const ii = mul(i, i, prec);

		const nextI = mul(r << 1n, i, prec) + cy;
		const nextR = rr - ii + cx;
		r = nextR;
		i = nextI;

		const dr = toNumber(r, prec);
		const di = toNumber(i, prec);
		zr[n] = dr;
		zi[n] = di;

		if (dr * dr + di * di > 4) {
			// The reference itself escaped. That's allowed -- rebasing (below)
			// copes with a short orbit -- so just stop here.
			length = n + 1;
			break;
		}

		if ((n & 0x1fff) === 0) onProgress?.(n, maxIterations);
	}

	return { zr: zr.slice(0, length), zi: zi.slice(0, length), length };
}

// ---------------------------------------------------------------------------
// Path 1: straight doubles
// ---------------------------------------------------------------------------

export function directTile(out, w, h, x0, y0, perPixel, maxIterations) {
	let index = 0;

	for (let row = 0, y = y0; row < h; row++, y += perPixel) {
		for (let col = 0, x = x0; col < w; col++, x += perPixel) {
			if (inMainBody(x, y)) {
				out[index++] = INTERIOR;
				continue;
			}

			let zr = 0;
			let zi = 0;
			let n = 0;
			let modulus2 = 0;

			// Periodicity check: an orbit that returns to where it was is
			// caught in a cycle and will never escape. Cheap way to avoid
			// grinding out maxIterations on interior pixels.
			let pr = 0;
			let pi = 0;
			let sinceCheck = 0;
			let checkAt = 8;

			while (n < maxIterations) {
				const rr = zr * zr;
				const ii = zi * zi;
				modulus2 = rr + ii;
				if (modulus2 > ESCAPE_R2) break;

				zi = 2 * zr * zi + y;
				zr = rr - ii + x;
				n++;

				if (Math.abs(zr - pr) < 1e-16 && Math.abs(zi - pi) < 1e-16) {
					n = maxIterations;
					break;
				}
				if (++sinceCheck >= checkAt) {
					sinceCheck = 0;
					checkAt *= 2;
					pr = zr;
					pi = zi;
				}
			}

			out[index++] = n >= maxIterations ? INTERIOR : smooth(n, modulus2);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Path 2: perturbation with rebasing
// ---------------------------------------------------------------------------

export function perturbTile(out, w, h, dx0, dy0, perPixel, maxIterations, reference) {
	const { zr: Zr, zi: Zi, length } = reference;
	const last = length - 1;
	let index = 0;

	// z(1) = 0^2 + C, so the orbit's second entry is the reference point
	// itself. Adding the offset gives us c as a double -- exact enough for the
	// cardioid test wherever that test can actually fire, and harmlessly false
	// everywhere deeper, since nothing that deep is inside the main body.
	const refR = Zr[1];
	const refI = Zi[1];

	for (let row = 0; row < h; row++) {
		const dci = dy0 + row * perPixel;

		for (let col = 0; col < w; col++) {
			const dcr = dx0 + col * perPixel;

			if (inMainBody(refR + dcr, refI + dci)) {
				out[index++] = INTERIOR;
				continue;
			}

			let dr = 0;
			let di = 0;
			let zr = 0;
			let zi = 0;
			let modulus2 = 0;
			let m = 0; // index into the reference orbit
			let n = 0; // true iteration count

			while (modulus2 <= ESCAPE_R2 && n < maxIterations) {
				// d <- (2Z + d)*d + dc, which is 2Zd + d^2 + dc written so the
				// subtraction happens between comparable magnitudes.
				const ar = 2 * Zr[m] + dr;
				const ai = 2 * Zi[m] + di;
				const nextR = ar * dr - ai * di + dcr;
				const nextI = ar * di + ai * dr + dci;
				dr = nextR;
				di = nextI;
				m++;
				n++;

				zr = Zr[m] + dr;
				zi = Zi[m] + di;
				modulus2 = zr * zr + zi * zi;

				// Rebasing. When d has grown to the size of z the sum above is
				// losing its significant digits -- and when we reach the end of
				// the reference we have nowhere left to read. Both are fixed
				// the same way: since Z(0) = 0, setting d = z and m = 0 is an
				// exact identity, not an approximation. This is what keeps the
				// picture free of the glitches perturbation is famous for.
				if (modulus2 < dr * dr + di * di || m >= last) {
					dr = zr;
					di = zi;
					m = 0;
				}
			}

			out[index++] = n >= maxIterations ? INTERIOR : smooth(n, modulus2);
		}
	}
	return out;
}
