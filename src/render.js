// Turns a ViewState into pixels.
//
// Nothing here touches the visible canvas. Frames are built in an off-screen
// buffer and handed to the viewport, which decides when to show them. That
// separation is what keeps the picture from twitching while it loads.
//
// A frame runs in three phases:
//
//   1. If we're deep enough to need arbitrary precision, one worker computes
//      the reference orbit while the others wait. That's the slow part, and
//      the one worth putting a timer on.
//
//   2. A probe: a postage-stamp version of the whole frame, just to learn what
//      range of escape values is out there. The palette is pinned to it before
//      any real pixel is coloured.
//
//   3. The frame proper, cut into tiles and shared round the pool.

import { INTERIOR } from './kernel.js';
import { Cancelled, WorkerPool } from './pool.js';
import { colorize } from './palette.js';

const TILE_SIZE = 128;

/** Width of the probe pass. Costs well under 1% of a frame. */
const PROBE_WIDTH = 56;

/** What we guess a frame will cost before we've ever timed one. */
const DEFAULT_PREDICTION = 320;

/**
 * The spread of escape values in a tile, ignoring pixels that never escaped.
 *
 * The outright extremes, not percentiles. Trimming the tails was worth trying
 * -- a coarse probe catches different outliers each frame, so the raw maximum
 * is jumpy -- but the palette only reads the *width* of this, and only to pick
 * a power of two, so the jumpiness mostly washes out. Trimming even 0.2% off
 * each end narrows a zoomed-out frame enough to push it up a level, which
 * would quietly restyle the opening view for no gain.
 */
function spread(values) {
	let lo = Infinity;
	let hi = -Infinity;
	let escaped = 0;
	for (let i = 0; i < values.length; i++) {
		const v = values[i];
		if (v === INTERIOR) continue;
		escaped++;
		if (v < lo) lo = v;
		if (v > hi) hi = v;
	}
	return escaped >= 16 && hi > lo ? { lo, hi } : null;
}

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
	 * because during the reference and probe phases `#frame` still holds the
	 * *previous* frame -- and reporting that one's completion would have the
	 * viewport cross-fade to a buffer that hasn't been drawn yet.
	 */
	get complete() {
		return this.#complete;
	}

	/** The spread of escape values the palette is currently pinned to. */
	get range() {
		return this.#frame?.range ?? null;
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

		const common = {
			type: 'tile',
			x0,
			y0,
			maxIterations: state.maxIterations,
			deep: state.deep,
		};

		if (state.deep) {
			this.#emit({ type: 'phase', phase: 'reference', started });
			let orbit;
			try {
				orbit = await this.#pool.run(
					{
						type: 'reference',
						cx: state.cx,
						cy: state.cy,
						prec: state.prec,
						maxIterations: state.maxIterations,
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

		// Probe first, so the palette is settled before anything is coloured.
		let range = null;
		try {
			const probeHeight = Math.max(8, Math.round((PROBE_WIDTH * height) / width));
			const probe = await this.#pool.run({
				...common,
				tile: { x: 0, y: 0, w: PROBE_WIDTH, h: probeHeight },
				width: PROBE_WIDTH,
				height: probeHeight,
				perPixel: (state.perPixel * width) / PROBE_WIDTH,
			});
			range = spread(probe.data);
		} catch (error) {
			return this.#fail(error, stale());
		}
		if (stale()) return;

		const frame = { width, height, tiles: [], range, complete: false };
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
		const cost = elapsed / (width * height * state.maxIterations);
		this.#rate = this.#rate === null ? cost : this.#rate * 0.7 + cost * 0.3;

		this.#emit({ type: 'done', elapsed });
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
			range: this.#frame?.range,
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
