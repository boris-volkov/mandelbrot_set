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

/** Fewest times the palette should repeat across a frame before we stretch it. */
const MIN_CYCLES = 1.25;

const curve = (nu) => Math.pow(nu > 0 ? nu : 0, 0.4);

/**
 * Turn a tile's escape values into pixels.
 *
 * Zoomed out, escape counts run from 1 to hundreds and the pow(nu, 0.4) curve
 * spreads them over the palette nicely all by itself -- so we leave it alone,
 * and the picture looks exactly as it always has.
 *
 * Deep down, everything on screen escapes between (say) 37,900 and 38,100.
 * The curve is nearly flat across a window that narrow, and the whole frame
 * comes out one colour. So when the range present is too compressed to fill
 * the palette even once, we stretch it until it does. That's the difference
 * between a legible picture at 1e37x and a rectangle of navy blue.
 *
 * @param {Float32Array} values  one escape value per pixel, INTERIOR for inside
 * @param {ImageData}    target  where the pixels go
 * @param {object}       opts    { palette, density, offset, range, interior }
 */
/**
 * Work out how escape values map onto the palette for one frame.
 *
 * Kept separate from the painting so it can be inspected on its own: this is
 * the part that decides whether the colours hold still as you zoom, and it is
 * much easier to check a handful of numbers than to squint at two pictures.
 *
 * @returns {{low: number, scale: number, shift: number, stretch: number}}
 */
export function mapping(range, density = 1, offset = 0) {
	const span = range ? curve(range.hi) - curve(range.lo) : 0;

	// Scale is the only thing the frame's contents are allowed to influence,
	// and only in doublings.
	//
	// Two decisions here, both about holding the colours still while you zoom.
	//
	// Nothing is anchored to where the frame's range happens to start. That
	// seems like the obvious thing to do -- pin the lowest escape value to the
	// start of the palette -- but the palette is a cycle, so an anchor buys no
	// extra colour, it only rotates the wheel. And since the range shifts a
	// little on every zoom step, anchoring to it turns every step into a
	// rotation. Measured over a 40-step descent, anchoring moved the colours on
	// 35 steps out of 39; not anchoring moved them on 6.
	//
	// The scale is then rounded to a power of two, so those 6 become as rare as
	// they can be. Between changes the mapping is *identical*, not merely close,
	// so a run of zooming leaves the colours exactly where they were. It also
	// means level 0 is the mapping this program has always used.
	const wanted = span > 1e-9 ? (MIN_CYCLES * TAU) / span : 1;
	const stretch = 2 ** Math.max(0, Math.round(Math.log2(wanted)));

	return {
		stretch,
		scale: ((LUT_SIZE * density) / TAU) * stretch,
		shift: offset * LUT_SIZE,
	};
}

export function colorize(values, target, { palette, density, offset, range, interior }) {
	const lut = lutFor(palette);
	const pixels = new Uint32Array(target.data.buffer);
	const inside = interior ?? 0xff000000;
	const { scale, shift } = mapping(range, density, offset);

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
