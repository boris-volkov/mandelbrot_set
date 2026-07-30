// The view: where we're looking, how far in, and how it's coloured.
//
// The centre is kept in arbitrary-precision fixed point, because that's the
// number that has to stay sharp as you zoom. The scale (`perPixel`) stays an
// ordinary double -- a double can represent 1e-300 perfectly well, it just
// can't *add* it to -0.7436 without losing it, and adding is exactly what the
// fixed-point centre is for.

import {
	fromDecimalString,
	fromNumber,
	precisionFor,
	rescale,
	toDecimalString,
	toNumber,
} from './fixed.js';
import { PALETTES } from './palette.js';

/**
 * Scale of a 1000px-tall window showing 3 units. Only a yardstick: it gives
 * the iteration heuristic a fixed notion of "how deep are we" and caps how far
 * out you can zoom.
 */
const REFERENCE_SCALE = 0.003;

/**
 * Units per pixel for the opening view in a window this size -- wide enough to
 * hold the whole set either way round.
 */
export function openingScale(width, height) {
	return Math.max(4.2 / width, 2.8 / height);
}

// Doubles fail us for two independent reasons, and either one is enough to
// send us down the perturbation path.
//
//   - Below ~1e-13 units per pixel a double can't separate neighbouring
//     pixels at all, and the image goes blocky.
//
//   - Long before that, error accumulates *along the orbit*. Measured against
//     an exact BigInt reference near a Misiurewicz point, plain doubles get
//     1.3% of pixels wrong at 1000 iterations and 13% at 4700, while
//     perturbation stays at 0.1% -- and those 0.1% are pixels that need ~96
//     bits to resolve, so nothing in double precision could get them.
//
// Perturbation costs 1.2-1.8x, which is worth it the moment iteration counts
// climb. Doubles keep the opening view, where the two agree pixel for pixel.
const DEEP_THRESHOLD = 1e-13;
const DEEP_ITERATIONS = 500;

/** Perturbation's floor: dc underflows a double past here. Deeper than anyone gets by hand. */
export const MIN_PER_PIXEL = 1e-295;

export const MAX_ITERATIONS = 200_000;

/**
 * A depth-derived iteration count. Not "the right number" -- there is no right
 * number as a function of depth alone.
 *
 * How many iterations a frame needs depends overwhelmingly on *where* it is,
 * not how deep. Measured at one scale, 2.1e-14 per pixel: a spot on the antenna
 * needed 27,750 to stop showing black where detail belongs, a spot in seahorse
 * valley needed 4,655, and a spot by a mini-Mandelbrot needed 400. Seventy-fold
 * spread, at identical depth, and the ordering reshuffles as you go deeper --
 * at 1e-9 per pixel the seahorse spot was the hungry one at 22,200. No curve in
 * perPixel can fit that, so the renderer measures instead: see
 * Renderer#measureIterations.
 *
 * All this is still good for is a starting guess for that search -- it only
 * affects how many probes the search takes to converge, never what it
 * converges to. (The palette used to be keyed to this instead of the real
 * cap, for the same "don't let it jump around" reason; that turned out to
 * need the real cap too -- see mapping() in palette.js.)
 */
export function nominalIterationsFor(perPixel) {
	const decades = Math.max(0, Math.log10(REFERENCE_SCALE / perPixel));
	return Math.min(MAX_ITERATIONS, Math.round(200 + 135 * Math.pow(decades, 1.45)));
}

const autoIterationsFor = nominalIterationsFor;

export class ViewState {
	constructor(fields = {}) {
		this.prec = fields.prec ?? 64;
		this.cx = fields.cx ?? 0n;
		this.cy = fields.cy ?? 0n;
		this.perPixel = fields.perPixel ?? REFERENCE_SCALE;
		this.maxIterations = fields.maxIterations ?? 300;
		this.autoIterations = fields.autoIterations ?? true;
		this.palette = fields.palette ?? 'classic';
		this.density = fields.density ?? 1;
		this.offset = fields.offset ?? 0;
	}

	clone() {
		return new ViewState(this);
	}

	static initial(width, height) {
		const perPixel = openingScale(width, height);
		const prec = precisionFor(perPixel);
		return new ViewState({
			prec,
			cx: fromNumber(-0.6, prec),
			cy: 0n,
			perPixel,
			maxIterations: autoIterationsFor(perPixel),
		});
	}

	// --- derived ------------------------------------------------------------

	/**
	 * Magnification, as a multiple of the opening view *in this window*.
	 *
	 * Measured against the window rather than a fixed span, so it reads 1.00x
	 * when you arrive and exact powers of two as you click -- 1, 2, 4, 8. Held
	 * against a fixed span it came out at whatever the window's shape made it
	 * (0.87x on a wide monitor), and every honest doubling after that looked
	 * like a strange number: 1.73, 3.46, 6.92.
	 */
	magnification(width, height) {
		return openingScale(width, height) / this.perPixel;
	}

	/**
	 * True when this view needs arbitrary precision. See the notes above.
	 *
	 * Takes the iteration count as an argument because the renderer measures
	 * its own, and a count that climbs past the threshold has to drag the
	 * choice of arithmetic with it -- otherwise a shallow view whose count grew
	 * would be drawn in plain doubles at exactly the iteration depths where
	 * they come apart.
	 */
	needsPerturbation(iterations = this.maxIterations) {
		return this.perPixel < DEEP_THRESHOLD || iterations > DEEP_ITERATIONS;
	}

	get deep() {
		return this.needsPerturbation();
	}

	/**
	 * How far this view's centre sits from another's, in plain units.
	 * The centres may be hundreds of digits long, but the gap between two
	 * views is never much bigger than a screen, so a double holds it fine.
	 */
	worldDelta(from) {
		const prec = Math.max(this.prec, from.prec);
		return {
			x: toNumber(rescale(this.cx, this.prec, prec) - rescale(from.cx, from.prec, prec), prec),
			y: toNumber(rescale(this.cy, this.prec, prec) - rescale(from.cy, from.prec, prec), prec),
		};
	}

	get centerX() {
		return toNumber(this.cx, this.prec);
	}

	get centerY() {
		return toNumber(this.cy, this.prec);
	}

	/**
	 * Decimal places worth keeping at this scale. The URL is the only place a
	 * view is ever stored, so this needs comfortable headroom over the pixel
	 * size rather than just enough -- six spare digits costs nothing.
	 */
	get significantDigits() {
		return Math.max(4, Math.ceil(Math.log10(1 / this.perPixel)) + 6);
	}

	// --- navigation ---------------------------------------------------------

	/**
	 * Keep enough precision for the current scale. Grows eagerly, shrinks only
	 * when we're well clear of needing it, so a zoom out and back in doesn't
	 * quietly throw away the digits that got you there.
	 */
	#syncPrecision() {
		const needed = precisionFor(this.perPixel);
		if (needed > this.prec || needed < this.prec - 128) {
			this.cx = rescale(this.cx, this.prec, needed);
			this.cy = rescale(this.cy, this.prec, needed);
			this.prec = needed;
		}
	}

	#syncIterations() {
		if (this.autoIterations) this.maxIterations = autoIterationsFor(this.perPixel);
	}

	/** Move by a distance given in pixels. */
	pan(dxPixels, dyPixels) {
		this.cx += fromNumber(dxPixels * this.perPixel, this.prec);
		this.cy += fromNumber(dyPixels * this.perPixel, this.prec);
		return this;
	}

	/**
	 * Zoom by `factor`. If a pixel is given, that point holds still; otherwise
	 * we zoom about the centre.
	 */
	zoomBy(factor, pixel = null, width = 0, height = 0) {
		const next = Math.min(this.perPixel / factor, REFERENCE_SCALE * 400);
		if (next < MIN_PER_PIXEL) return this;

		if (pixel) {
			// Shift the centre so the world point under `pixel` lands back
			// under `pixel` at the new scale.
			const shrink = 1 - next / this.perPixel;
			this.cx += fromNumber((pixel.x - width / 2) * this.perPixel * shrink, this.prec);
			this.cy += fromNumber((pixel.y - height / 2) * this.perPixel * shrink, this.prec);
		}

		this.perPixel = next;
		this.#syncPrecision();
		this.#syncIterations();
		return this;
	}

	/** Zoom in on a pixel by recentring on it, the way clicking always has. */
	zoomTo(pixel, factor, width, height) {
		if (this.perPixel / factor < MIN_PER_PIXEL) return this;
		this.pan(pixel.x - width / 2, pixel.y - height / 2);
		this.perPixel /= factor;
		this.#syncPrecision();
		this.#syncIterations();
		return this;
	}

	setIterations(n) {
		this.maxIterations = Math.max(1, Math.min(MAX_ITERATIONS, Math.round(n)));
		this.autoIterations = false;
		return this;
	}

	useAutoIterations() {
		this.autoIterations = true;
		this.maxIterations = autoIterationsFor(this.perPixel);
		return this;
	}

	// --- serialisation ------------------------------------------------------

	toSearchParams() {
		const digits = this.significantDigits;
		const params = new URLSearchParams();
		params.set('x', toDecimalString(this.cx, this.prec, digits));
		params.set('y', toDecimalString(this.cy, this.prec, digits));
		params.set('s', this.perPixel.toExponential(6));
		params.set('i', String(this.maxIterations));
		if (this.autoIterations) params.set('a', '1');
		params.set('c', this.palette);
		if (this.density !== 1) params.set('d', this.density.toFixed(3));
		if (this.offset !== 0) params.set('o', this.offset.toFixed(3));
		return params;
	}

	toURL(base = window.location.href) {
		const url = new URL(base);
		url.search = this.toSearchParams().toString();
		return url.href;
	}

	static fromSearchParams(params) {
		const perPixel = Number(params.get('s'));
		if (!Number.isFinite(perPixel) || perPixel <= 0) return null;

		const prec = precisionFor(perPixel);
		const cx = fromDecimalString(params.get('x') ?? '', prec);
		const cy = fromDecimalString(params.get('y') ?? '', prec);
		if (cx === null || cy === null) return null;

		const iterations = parseInt(params.get('i') ?? '', 10);
		const palette = params.get('c');
		const density = Number(params.get('d'));
		const offset = Number(params.get('o'));

		return new ViewState({
			prec,
			cx,
			cy,
			perPixel: Math.max(perPixel, MIN_PER_PIXEL),
			maxIterations: Number.isFinite(iterations)
				? Math.max(1, Math.min(MAX_ITERATIONS, iterations))
				: autoIterationsFor(perPixel),
			autoIterations: params.get('a') === '1',
			palette: PALETTES.includes(palette) ? palette : 'classic',
			density: Number.isFinite(density) && density > 0 ? density : 1,
			offset: Number.isFinite(offset) ? offset : 0,
		});
	}

	static fromURL(href) {
		try {
			return ViewState.fromSearchParams(new URL(href).searchParams);
		} catch {
			return null;
		}
	}
}
