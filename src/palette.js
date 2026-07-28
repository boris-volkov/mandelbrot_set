// Colour lookup tables.
//
// Colouring happens on the main thread from the raw escape values the workers
// hand back, which means switching palettes is instant -- no recompute.
//
// The index into a palette is pow(nu, 0.4), the same curve the original used.
// It matters: escape counts crowd together near the boundary of the set, and a
// linear ramp spends all its colour on the empty parts of the picture.

import { INTERIOR } from './kernel.js';

const LUT_SIZE = 2048;
const TAU = Math.PI * 2;

/** Pack to the byte order an RGBA ImageData buffer wants on a little-endian machine. */
const rgba = (r, g, b) => (255 << 24) | (b << 16) | (g << 8) | r;

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// Stop-based palettes: colours spaced evenly around one cycle, wrapping.
const STOPS = {
	ultra: [
		[0, 7, 100],
		[32, 107, 203],
		[237, 255, 255],
		[255, 170, 0],
		[0, 2, 0],
	],
	ember: [
		[10, 0, 20],
		[120, 20, 40],
		[240, 100, 20],
		[255, 220, 120],
		[80, 10, 30],
	],
	ice: [
		[4, 10, 30],
		[20, 90, 150],
		[120, 200, 235],
		[240, 250, 255],
		[30, 40, 90],
	],
	spectrum: [
		[190, 40, 90],
		[220, 170, 40],
		[70, 190, 90],
		[40, 130, 210],
		[110, 60, 180],
	],
	mono: [
		[8, 8, 10],
		[128, 128, 132],
		[248, 248, 250],
		[128, 128, 132],
	],
};

export const PALETTES = ['classic', 'ultra', 'ember', 'ice', 'spectrum', 'mono'];

/** The original palette, kept exactly as it was. */
function classicAt(angle) {
	return rgba(
		clamp255(-125 * Math.sin(angle) + 125),
		clamp255(75 * Math.sin(angle - TAU / 3) + 75),
		clamp255(75 * Math.sin(angle + TAU / 3) + 175),
	);
}

function buildLUT(name) {
	const lut = new Uint32Array(LUT_SIZE);

	if (name === 'classic') {
		for (let i = 0; i < LUT_SIZE; i++) lut[i] = classicAt((i / LUT_SIZE) * TAU);
		return lut;
	}

	const stops = STOPS[name] ?? STOPS.ultra;
	for (let i = 0; i < LUT_SIZE; i++) {
		const t = (i / LUT_SIZE) * stops.length;
		const a = stops[Math.floor(t) % stops.length];
		const b = stops[(Math.floor(t) + 1) % stops.length];
		const f = t - Math.floor(t);
		lut[i] = rgba(
			clamp255(a[0] + (b[0] - a[0]) * f),
			clamp255(a[1] + (b[1] - a[1]) * f),
			clamp255(a[2] + (b[2] - a[2]) * f),
		);
	}
	return lut;
}

const cache = new Map();

function lutFor(name) {
	let lut = cache.get(name);
	if (!lut) cache.set(name, (lut = buildLUT(name)));
	return lut;
}

/**
 * Iteration limit the palette is tuned around: at this many, it doesn't
 * stretch at all and the mapping is the one this program has always used.
 *
 * Tied to the automatic iteration count, so it moved with it when that was
 * trimmed by 1.5x. The palette is really keyed to *depth*; iterations are the
 * stand-in. Had this stayed put, trimming the count would have quietly dropped
 * some views a colour level for no reason connected to how they look.
 */
const REFERENCE_ITERATIONS = 800;

/**
 * How the curve's flattening is undone. pow(nu, 0.4) has slope 0.4·nu^-0.6, so
 * scaling by nu^0.6 keeps a given spread of iterations covering the same amount
 * of palette however deep you are.
 */
const FLATTENING = 0.6;

/** Escape counts crowd near the boundary; this is the curve that undoes that. */
const CURVE_EXPONENT = 0.4;

const curve = (nu) => Math.pow(nu > 0 ? nu : 0, CURVE_EXPONENT);

/**
 * Work out how escape values map onto the palette.
 *
 * Kept separate from the painting so it can be inspected on its own: this is
 * the part that decides whether the colours hold still as you zoom, and it is
 * far easier to check a handful of numbers than to squint at two pictures.
 *
 * @returns {{scale: number, shift: number, stretch: number}}
 */
export function mapping(maxIterations, density = 1, offset = 0) {
	// Three decisions here, all about holding the colours still while you zoom.
	//
	// The scale is read off the iteration limit, not off the spread of escape
	// values actually measured in the frame. Measuring seems obviously better
	// -- it's the real answer to "how much colour does this picture need" --
	// but it makes the palette follow the picture, and in a smooth region the
	// spread halves on every zoom step. So the scale doubles on every zoom
	// step, and the colours change every single time. Zooming into open water
	// went x1, x8, x32, x64, x256 in five clicks. The iteration limit moves
	// slowly and predictably instead, so the colours hold for long runs and
	// shift a handful of times over an entire descent.
	//
	// Nothing is anchored to where the range starts, either. Pinning the lowest
	// escape value to the start of the palette looks right, but the palette is
	// a cycle -- an anchor buys no extra colour, it only rotates the wheel --
	// and since the range shifts a little every step, anchoring to it turned
	// every step into a rotation.
	//
	// And the scale is rounded to a power of two, so between changes the
	// mapping is *identical* rather than merely close. A run of zooming leaves
	// the colours exactly where they were.
	const wanted = (maxIterations / REFERENCE_ITERATIONS) ** FLATTENING;
	const stretch = 2 ** Math.max(0, Math.round(Math.log2(wanted)));

	return {
		stretch,
		scale: ((LUT_SIZE * density) / TAU) * stretch,
		shift: offset * LUT_SIZE,
	};
}

/**
 * How many times the palette actually repeats across escape values from 0 to
 * `maxIterations`, at a given `scale`.
 *
 * Not the same question as mapping()'s `stretch`. Stretch is keyed to depth
 * (nominalIterations) on purpose, so the colours don't get thrown around by
 * the measured count -- but that means it doesn't answer "how many bands will
 * I actually see", because the picture's real pixels range up to whatever
 * iteration count was actually measured for this view, which can be a long
 * way from the depth guess. This is the literal count for the range that's
 * really on screen: exact, because it's the same curve(nu)*scale colorize()
 * uses, just evaluated at the one nu that matters -- the cap.
 */
export function repeatsAcross(maxIterations, scale) {
	return (curve(maxIterations) * scale) / LUT_SIZE;
}

/**
 * The escape count that sits `fraction` of the way from 0 to `maxIterations`
 * *in the palette's own space* -- i.e. the nu whose curve(nu) is `fraction`
 * of the way from curve(0) to curve(maxIterations). Answers "what iteration
 * count is at this x position" for a strip drawn linearly in that space,
 * which is what spectrum() does and what makes its bands evenly spaced.
 *
 * A closed form, not a search: curve is a pure power law, so its inverse is
 * one too, and the two exponents cancel the density/offset/scale out of it
 * entirely -- this position depends only on the cap, never on how the
 * picture happens to be coloured.
 */
export function iterationsAt(fraction, maxIterations) {
	return Math.pow(Math.max(0, fraction), 1 / CURVE_EXPONENT) * maxIterations;
}

/**
 * Turn a tile's escape values into pixels.
 *
 * Zoomed out, escape counts run from 1 to a few hundred and the pow(nu, 0.4)
 * curve spreads them over the palette nicely by itself. Deep down, everything
 * on screen escapes between (say) 37,900 and 38,100; the curve is nearly flat
 * across a window that narrow, and the frame would come out one colour. The
 * scale from mapping() undoes exactly that much flattening -- the difference
 * between a legible picture at 1e37x and a rectangle of navy blue.
 *
 * @param {Float32Array} values  one escape value per pixel, INTERIOR for inside
 * @param {ImageData}    target  where the pixels go
 * @param {object}       opts    { palette, density, offset, maxIterations, interior }
 */
export function colorize(values, target, { palette, density, offset, maxIterations, interior }) {
	const lut = lutFor(palette);
	const pixels = new Uint32Array(target.data.buffer);
	const inside = interior ?? 0xff000000;
	const { scale, shift } = mapping(maxIterations, density, offset);

	for (let i = 0; i < values.length; i++) {
		const nu = values[i];
		if (nu === INTERIOR) {
			pixels[i] = inside;
			continue;
		}
		const t = curve(nu) * scale + shift;
		pixels[i] = lut[(((t % LUT_SIZE) + LUT_SIZE) % LUT_SIZE) | 0];
	}
}

/**
 * The palette itself, laid flat: `cycles` repeats of it, starting `offset` of
 * the way through one.
 *
 * This is what "bands" and "shift" actually are, with nothing else in the
 * way. colorize() reaches this same phase -- curve(nu)*scale + shift -- by a
 * longer road, because it starts from an escape count and has to work out
 * where that lands; here we get to specify the phase directly, since a
 * picture of the *function* doesn't have escape counts to begin with, only
 * position along the strip. `cycles` and `offset` mean exactly what they mean
 * in mapping(): scale is cycles-per-unit-width and shift is offset*LUT_SIZE.
 *
 * @returns {Uint32Array} one packed RGBA colour per pixel of width
 */
export function spectrum(width, { palette, cycles = 1, offset = 0 }) {
	const lut = lutFor(palette);
	const n = Math.max(1, Math.round(width));
	const out = new Uint32Array(n);
	for (let x = 0; x < n; x++) {
		const t = (x / n) * cycles * LUT_SIZE + offset * LUT_SIZE;
		out[x] = lut[(((t % LUT_SIZE) + LUT_SIZE) % LUT_SIZE) | 0];
	}
	return out;
}
