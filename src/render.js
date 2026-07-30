// Turns a ViewState into pixels.
//
// Nothing here touches the visible canvas. Frames are built in an off-screen
// buffer and handed to the viewport, which decides when to show them. That
// separation is what keeps the picture from twitching while it loads.
//
// A frame runs in two phases:
//
//   1. If we're deep enough to need arbitrary precision, one worker computes
//      the reference orbit while the others wait. That's the slow part, and
//      the one worth putting a timer on.
//
//   2. The frame proper, cut into tiles and shared round the pool.

import { Cancelled, WorkerPool } from './pool.js';
import { colorize } from './palette.js';
import { MAX_ITERATIONS } from './state.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const TILE_SIZE = 128;

/** What we guess a frame will cost before we've ever timed one. */
const DEFAULT_PREDICTION = 320;

/** Width of the postage-stamp frame used to size up the iteration count. */
const PROBE_WIDTH = 64;

// Both tolerances are in probe pixels, because that is the resolution the
// measurement actually has -- a probe is a few thousand pixels, so a fraction
// finer than one of them would be noise.
//
// They differ on purpose. Climbing is about rescuing a frame that is lying to
// you, where several pixels' worth is already worth the wait. Coming back down
// is only worth doing while it is free, and the shallow views are where being
// stingy shows: at the opening view, 200 iterations costs two probe pixels
// against a converged 349 and looks right, while 89 costs nine and visibly
// shortens the antenna.
const STARVED_PIXELS = 6;
const SETTLED_PIXELS = 2;

/** Step of the ladder the search walks. Smaller overshoots less but probes more. */
const LADDER = 1.5;

/**
 * Bounds on the search. Twelve rungs of the ladder is a hundredfold either way
 * from the starting guess, which sounds absurd until you measure it: the guess
 * was out by 6x on the view that prompted all this, and by 11x the other way
 * on an easy one. Stopping short just means going back to drawing black where
 * there is detail, so the limit is set well clear of the cases we have seen.
 */
const MIN_PROBE_ITERATIONS = 60;
const MAX_PROBE_STEPS = 12;

export class Renderer {
	#buffer = document.createElement('canvas');
	#ctx;
	#pool;
	#generation = 0;
	#frame = null;
	#emit;

	// Live timing, so the viewport can pace its animation against us.
	#phase = 'idle';
	#tilesBegan = 0;
	#done = 0;
	#total = 0;
	#rate = null;
	#complete = true;

	constructor(onEvent) {
		this.#ctx = this.#buffer.getContext('2d', { alpha: false });
		this.#emit = onEvent;
		this.#pool = new WorkerPool(
			navigator.hardwareConcurrency || 4,
			new URL('./worker.js', import.meta.url),
		);
	}

	/** The off-screen canvas holding the frame being built. */
	get surface() {
		return this.#buffer;
	}

	get width() {
		return this.#buffer.width;
	}

	get height() {
		return this.#buffer.height;
	}

	get workers() {
		return this.#pool.size;
	}

	/**
	 * Whether the buffer is finished. Tracked separately from the frame,
	 * because while the reference orbit is being computed `#frame` still holds
	 * the *previous* frame -- and reporting that one's completion would have
	 * the viewport cross-fade to a buffer that hasn't been drawn yet.
	 */
	get complete() {
		return this.#complete;
	}

	/** Resize the buffer. Returns true if it actually changed. */
	setSize(width, height) {
		if (this.#buffer.width === width && this.#buffer.height === height) return false;
		this.#buffer.width = width;
		this.#buffer.height = height;
		this.#frame = null;
		return true;
	}

	/**
	 * Fill the buffer with a slice of another canvas, stretched to fit.
	 *
	 * The viewport uses this to lay down the outgoing frame, warped to the
	 * incoming one's geometry, before any tile arrives. Tiles then land on
	 * a background that already matches instead of on something stale.
	 */
	seedFrom(source, sx, sy, sw, sh) {
		this.#ctx.fillStyle = '#000';
		this.#ctx.fillRect(0, 0, this.width, this.height);
		this.#ctx.drawImage(source, sx, sy, sw, sh, 0, 0, this.width, this.height);
	}

	// --- pacing -------------------------------------------------------------

	/**
	 * Rough guess at how long a frame will take, from how long recent ones
	 * did. Only needs to be close enough to start an animation with; once
	 * tiles start landing, remainingMs() takes over.
	 */
	predict(state) {
		if (this.#rate === null) return DEFAULT_PREDICTION;
		return this.width * this.height * state.maxIterations * this.#rate;
	}

	/** Milliseconds left, or null while it's too early to say. */
	remainingMs() {
		if (this.#phase === 'idle') return 0;
		if (this.#done === 0) return null;
		const perTile = (performance.now() - this.#tilesBegan) / this.#done;
		return perTile * (this.#total - this.#done);
	}

	#tiles() {
		const tiles = [];
		for (let y = 0; y < this.height; y += TILE_SIZE) {
			for (let x = 0; x < this.width; x += TILE_SIZE) {
				tiles.push({
					x,
					y,
					w: Math.min(TILE_SIZE, this.width - x),
					h: Math.min(TILE_SIZE, this.height - y),
				});
			}
		}
		// Middle first: it's where you're looking.
		const cx = this.width / 2;
		const cy = this.height / 2;
		const distance = (t) => (t.x + t.w / 2 - cx) ** 2 + (t.y + t.h / 2 - cy) ** 2;
		return tiles.sort((a, b) => distance(a) - distance(b));
	}

	cancel() {
		this.#generation++;
		this.#phase = 'idle';
		// Whatever is in the buffer is what we've got; call it finished so the
		// viewport stops waiting on it.
		this.#complete = true;
		this.#pool.reset();
	}

	async render(state) {
		const generation = ++this.#generation;
		const stale = () => generation !== this.#generation;
		this.#pool.clearQueue();

		const started = performance.now();
		const { width, height } = this;
		this.#phase = 'reference';
		this.#done = 0;
		this.#total = 0;
		this.#complete = false;

		// Only the plain-double path needs these; the perturbation path works
		// from pixel offsets and never forms an absolute coordinate.
		const x0 = state.centerX - (state.perPixel * width) / 2;
		const y0 = state.centerY - (state.perPixel * height) / 2;

		// Find out what this view actually needs before committing to it.
		let maxIterations = state.maxIterations;
		if (state.autoIterations) {
			this.#emit({ type: 'phase', phase: 'iterations', started });
			try {
				maxIterations = await this.#measureIterations(state, x0, y0, stale);
			} catch (error) {
				return this.#fail(error, stale());
			}
			if (stale()) return;
			this.#emit({ type: 'iterations', value: maxIterations });
		}

		// Decided from the measured count, not the guess it started from.
		const deep = state.needsPerturbation(maxIterations);
		const common = { type: 'tile', x0, y0, maxIterations, deep };

		if (deep) {
			this.#emit({ type: 'phase', phase: 'reference', started });
			let orbit;
			try {
				orbit = await this.#pool.run(
					{
						type: 'reference',
						cx: state.cx,
						cy: state.cy,
						prec: state.prec,
						maxIterations,
					},
					{
						onProgress: ({ done, total }) => {
							if (!stale()) this.#emit({ type: 'reference-progress', done, total });
						},
					},
				);
			} catch (error) {
				return this.#fail(error, stale());
			}
			if (stale()) return;
			this.#pool.setSession({
				reference: { zr: orbit.zr, zi: orbit.zi, length: orbit.length },
			});
		} else {
			// Still worth sending: it lets the workers drop the previous
			// frame's orbit, which for a long one is megabytes apiece.
			this.#pool.setSession({ reference: null });
		}

		const tiles = this.#tiles();
		this.#phase = 'tiles';
		this.#tilesBegan = performance.now();
		this.#total = tiles.length;
		this.#emit({ type: 'phase', phase: 'tiles', total: tiles.length, started });

		const frame = { width, height, tiles: [], complete: false };
		this.#frame = frame;

		const jobs = tiles.map((tile) =>
			this.#pool
				.run({ ...common, tile, width, height, perPixel: state.perPixel })
				.then((result) => {
					if (stale()) return;
					const painted = { ...result.tile, data: result.data };
					frame.tiles.push(painted);
					this.#paint(painted, state);
					this.#done++;
					this.#emit({
						type: 'progress',
						done: this.#done,
						total: tiles.length,
						elapsed: performance.now() - started,
					});
				})
				.catch((error) => {
					if (!(error instanceof Cancelled) && !stale()) {
						this.#emit({ type: 'error', error });
					}
				}),
		);

		await Promise.all(jobs);
		if (stale()) return;

		frame.complete = true;
		this.#complete = true;
		this.#phase = 'idle';

		const elapsed = performance.now() - started;
		const cost = elapsed / (width * height * maxIterations);
		this.#rate = this.#rate === null ? cost : this.#rate * 0.7 + cost * 0.3;

		this.#emit({ type: 'done', elapsed });
	}

	/**
	 * Work out how many iterations this view needs, by rendering it at
	 * postage-stamp size a few times and watching the black area.
	 *
	 * Raising the limit can only ever turn black pixels into coloured ones, so
	 * "how much black goes away when I double the limit" is exactly "how much
	 * of this frame is a lie". Climb while that's worth having, then come back
	 * down for as long as it costs nothing, and stop.
	 *
	 * This exists because no function of depth can answer the question. At one
	 * fixed scale the honest answer ranged from 400 to 27,750 depending only on
	 * where you were pointing.
	 */
	async #measureIterations(state, x0, y0, stale) {
		const height = Math.max(8, Math.round((PROBE_WIDTH * this.height) / this.width));
		const job = {
			type: 'probe',
			width: PROBE_WIDTH,
			height,
			perPixel: (state.perPixel * this.width) / PROBE_WIDTH,
			x0,
			y0,
			cx: state.cx,
			cy: state.cy,
			prec: state.prec,
			deep: state.deep,
		};

		const seen = new Map();
		const blackAt = async (iterations) => {
			if (!seen.has(iterations)) {
				const result = await this.#pool.run({ ...job, maxIterations: iterations });
				seen.set(iterations, result.interior);
			}
			return seen.get(iterations);
		};

		let best = clamp(state.maxIterations, MIN_PROBE_ITERATIONS, MAX_ITERATIONS);
		let black = await blackAt(best);
		if (stale()) return best;

		// Climb while there is still meaningful black to melt away.
		for (let step = 0; step < MAX_PROBE_STEPS; step++) {
			const higher = Math.min(MAX_ITERATIONS, Math.round(best * LADDER));
			if (higher === best) break;
			const next = await blackAt(higher);
			if (stale()) return best;
			if (black - next < STARVED_PIXELS) break;
			best = higher;
			black = next;
		}

		// `black` is now as low as this view goes. Come back down for as long as
		// it stays that low -- measured against the settled figure, not against
		// each step, or it would creep down a tolerance at a time.
		const settled = black;
		for (let step = 0; step < MAX_PROBE_STEPS; step++) {
			const lower = Math.max(MIN_PROBE_ITERATIONS, Math.round(best / LADDER));
			if (lower === best) break;
			if ((await blackAt(lower)) - settled > SETTLED_PIXELS) break;
			if (stale()) return best;
			best = lower;
		}

		return best;
	}

	#fail(error, alreadyStale) {
		this.#phase = 'idle';
		// Superseded frames leave `#complete` alone: the frame that replaced
		// this one owns it now, and is still working.
		if (alreadyStale) return;
		this.#complete = true;
		if (error instanceof Cancelled) return;
		this.#emit({ type: 'error', error });
	}

	#paint(tile, state) {
		const image = new ImageData(tile.w, tile.h);
		colorize(tile.data, image, {
			palette: state.palette,
			density: state.density,
			offset: state.offset,
			// The real cap, so the palette targets ~1 band across the escape
			// range this picture actually has -- see mapping() in palette.js.
			maxIterations: state.maxIterations,
		});
		this.#ctx.putImageData(image, tile.x, tile.y);
	}

	/** Re-colour what's already been computed. Free -- no iteration involved. */
	recolor(state) {
		const frame = this.#frame;
		if (!frame || frame.width !== this.width || frame.height !== this.height) return false;
		for (const tile of frame.tiles) this.#paint(tile, state);
		return true;
	}

	toBlob(type = 'image/png') {
		return new Promise((resolve) => this.#buffer.toBlob(resolve, type));
	}
}
