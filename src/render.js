// Turns a ViewState into pixels on the canvas.
//
// A frame runs in two phases. If we're deep enough to need arbitrary
// precision, one worker computes the reference orbit while the others wait --
// that's the slow part, and the one worth putting a timer on. Then the frame
// is cut into tiles and handed round the pool, each painted the moment it
// lands so you can watch the picture arrive.

import { Cancelled, WorkerPool } from './pool.js';
import { colorize } from './palette.js';

const TILE_SIZE = 128;

export class Renderer {
	#canvas;
	#ctx;
	#pool;
	#generation = 0;
	#frame = null;
	#emit;

	constructor(canvas, onEvent) {
		this.#canvas = canvas;
		this.#ctx = canvas.getContext('2d', { alpha: false });
		this.#emit = onEvent;
		this.#pool = new WorkerPool(
			navigator.hardwareConcurrency || 4,
			new URL('./worker.js', import.meta.url),
		);
	}

	get width() {
		return this.#canvas.width;
	}

	get height() {
		return this.#canvas.height;
	}

	get workers() {
		return this.#pool.size;
	}

	/** Resize the backing store. Returns true if it actually changed. */
	setSize(width, height) {
		if (this.#canvas.width === width && this.#canvas.height === height) return false;
		this.#canvas.width = width;
		this.#canvas.height = height;
		this.#frame = null;
		return true;
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
		this.#pool.reset();
	}

	async render(state) {
		const generation = ++this.#generation;
		const stale = () => generation !== this.#generation;
		this.#pool.clearQueue();

		const started = performance.now();
		const { width, height } = this;

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
				if (error instanceof Cancelled) return;
				this.#emit({ type: 'error', error });
				return;
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
		this.#emit({ type: 'phase', phase: 'tiles', total: tiles.length, started });

		const frame = {
			width,
			height,
			tiles: [],
			range: null,
			complete: false,
		};
		this.#frame = frame;

		// Only needed by the plain-double path; the perturbation path works
		// from pixel offsets and never forms an absolute coordinate.
		const x0 = state.centerX - (state.perPixel * width) / 2;
		const y0 = state.centerY - (state.perPixel * height) / 2;

		let done = 0;

		const jobs = tiles.map((tile) =>
			this.#pool
				.run({
					type: 'tile',
					tile,
					width,
					height,
					x0,
					y0,
					perPixel: state.perPixel,
					maxIterations: state.maxIterations,
					deep: state.deep,
				})
				.then((result) => {
					if (stale()) return;
					const painted = { ...result.tile, data: result.data };
					frame.tiles.push(painted);
					if (this.#widenRange(frame, result.lo, result.hi)) {
						// The palette just moved under the tiles already down.
						for (const earlier of frame.tiles) this.#paint(earlier, state);
					} else {
						this.#paint(painted, state);
					}
					done++;
					this.#emit({
						type: 'progress',
						done,
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

		// Tiles were painted as they arrived, against whatever the range was
		// at the time. Small widenings don't trigger a repaint on their own,
		// so they'd leave faint seams along tile edges. One final pass with
		// the settled range puts the whole frame on the same footing.
		frame.complete = true;
		for (const tile of frame.tiles) this.#paint(tile, state);

		this.#emit({ type: 'done', elapsed: performance.now() - started });
	}

	/**
	 * Widen the frame's range to include one tile's. Returns true when the
	 * palette has stretched far enough that tiles already painted need doing
	 * again -- a few percent, so it settles after the first handful of tiles
	 * instead of flickering all the way down the frame.
	 */
	#widenRange(frame, lo, hi) {
		if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;

		const previous = frame.range;
		if (!previous) {
			frame.range = { lo, hi };
			return frame.tiles.length > 1;
		}

		frame.range = { lo: Math.min(previous.lo, lo), hi: Math.max(previous.hi, hi) };
		const span = Math.max(previous.hi - previous.lo, 1e-9);
		return (
			(previous.lo - frame.range.lo) / span > 0.03 ||
			(frame.range.hi - previous.hi) / span > 0.03
		);
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

	/**
	 * Stretch what's on screen to approximate where we're about to go, so the
	 * canvas isn't stale or blank while the real frame computes.
	 */
	previewZoom(factor, focus) {
		const { width, height } = this;
		const sw = width / factor;
		const sh = height / factor;
		this.#ctx.drawImage(
			this.#canvas,
			focus.x - sw / 2,
			focus.y - sh / 2,
			sw,
			sh,
			0,
			0,
			width,
			height,
		);
	}

	previewPan(dx, dy) {
		const { width, height } = this;
		this.#ctx.drawImage(this.#canvas, dx, dy, width, height, 0, 0, width, height);
	}

	toBlob(type = 'image/png') {
		return new Promise((resolve) => this.#canvas.toBlob(resolve, type));
	}
}
