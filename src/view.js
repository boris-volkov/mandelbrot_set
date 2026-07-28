// What you actually look at.
//
// The renderer builds frames off-screen; this decides how they arrive. When
// you click to zoom, the outgoing frame is stretched toward the incoming one
// over a few hundred milliseconds, and the animation is paced to land about
// when the new pixels are ready. Zooming stops being a cut and becomes a move.
//
// The trick that makes the handover invisible: before the render starts, the
// buffer is seeded with the outgoing frame warped into the *incoming* frame's
// geometry. That seed is pixel-for-pixel what the animation shows at the
// moment it lands, so switching from "animating the old frame" to "showing the
// new buffer" changes nothing on screen. Tiles then sharpen it in place.

import { fromNumber } from './fixed.js';

/** Floor on the animation, so even instant frames still glide. */
const MIN_MS = 190;

/** Ceiling, so a frame that takes half a minute doesn't crawl for half a minute. */
const MAX_MS = 1400;

/** Cross-fade from the stretched frame to the sharp one, when it's ready in time. */
const SETTLE_MS = 160;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Shape of the move over time.
 *
 * Linear, so the zoom holds one speed from beginning to end. It reads as
 * constant because sampleRect() interpolates the scale geometrically -- zoom
 * is multiplicative, so even travel through the exponent is even travel to the
 * eye. (Interpolating the scale itself would look like it was falling.)
 *
 * This used to be smoothstep, t*t*(3 - 2*t), which eases in and out. That is
 * the right default for something that moves a short distance and stops, but
 * here it reads as the zoom winding up, and there is nothing to ease into: the
 * end of the move is a cross-fade, not a halt. For a gentler landing without
 * the wind-up, ease out only: 1 - (1 - t)**2.
 */
const ease = (t) => t;

/**
 * How long the move should take, revised as the render reveals its own pace.
 *
 * This is the bit that makes the zoom land as the pixels do. Expressed as a
 * total duration for the whole move, so `progress` has to be folded in: what
 * we actually want is for the part still to come to take as long as the render
 * has left. We only ever stretch, never cut short -- shortening would make the
 * picture lurch -- and we stop at MAX_MS, because past a second and a half a
 * slow frame should let you look at something rather than creep towards it.
 *
 * @param progress  how much of the move is already done, 0 to 1
 * @param duration  what we're currently aiming for
 * @param remaining ms of rendering left, or null while it's too early to say
 */
export function paceDuration(progress, duration, remaining) {
	if (remaining === null) return duration;
	const left = 1 - progress;
	if (left <= 0) return duration;
	const wanted = (remaining + SETTLE_MS) / left;
	return wanted > duration ? Math.min(wanted, MAX_MS) : duration;
}

/**
 * Which part of an image of `from` to sample to make it look like the view
 * `p` of the way from `from` to `to`. At p = 0 that's the whole image; at
 * p = 1 it's the slice `to` would show.
 *
 * Scale interpolates geometrically -- zoom is multiplicative, so a constant
 * rate through the exponent is what reads as constant speed.
 */
export function sampleRect(from, delta, targetPerPixel, p, width, height) {
	const ratio = Math.pow(targetPerPixel / from.perPixel, p);
	return {
		x: width / 2 + (delta.x * p) / from.perPixel - (width / 2) * ratio,
		y: height / 2 + (delta.y * p) / from.perPixel - (height / 2) * ratio,
		w: width * ratio,
		h: height * ratio,
	};
}

export class Viewport {
	#canvas;
	#ctx;
	#renderer;
	#previous = document.createElement('canvas');
	#previousCtx;

	#target = null;
	#move = null;
	#pending = null;

	constructor(canvas, renderer) {
		this.#canvas = canvas;
		this.#ctx = canvas.getContext('2d', { alpha: false });
		this.#previousCtx = this.#previous.getContext('2d', { alpha: false });
		this.#renderer = renderer;
	}

	setSize(width, height) {
		const changed = this.#renderer.setSize(width, height);
		if (changed) {
			this.#canvas.width = width;
			this.#canvas.height = height;
		}
		return changed;
	}

	/**
	 * The view the pixels on screen represent right now, mid-move included.
	 * Always a copy -- handing out the live object is how "where we were" and
	 * "where we're going" end up being the same thing.
	 */
	current() {
		if (!this.#target) return null; // nothing shown yet
		const move = this.#move;
		if (!move || move.landed) return this.#target.clone();

		const p = ease(move.progress);
		const view = move.from.clone();
		view.perPixel = move.from.perPixel * Math.pow(this.#target.perPixel / move.from.perPixel, p);
		view.cx += fromNumber(move.delta.x * p, view.prec);
		view.cy += fromNumber(move.delta.y * p, view.prec);
		return view;
	}

	/**
	 * Show `target`, rendering it and animating the way there.
	 *
	 * Pass animate: false when there's nothing to animate -- a resize, or the
	 * very first frame -- and it cuts straight to rendering.
	 */
	go(target, { animate = true } = {}) {
		const from = this.current();

		// Take our own copy. The caller navigates by mutating a single state
		// object in place, so holding a reference to it would mean `from` and
		// `target` were the same object by the time we got here -- no
		// difference to animate, and a render that could change underneath
		// itself while it was still reading fields off it.
		const view = target.clone();
		this.#target = view;

		if (from) {
			// Snapshot what's on screen. It's both the thing we animate and
			// the backdrop the new tiles will land on.
			this.#previous.width = this.#canvas.width;
			this.#previous.height = this.#canvas.height;
			this.#previousCtx.drawImage(this.#canvas, 0, 0);

			const delta = view.worldDelta(from);
			const landing = sampleRect(
				from,
				delta,
				view.perPixel,
				1,
				this.#canvas.width,
				this.#canvas.height,
			);
			this.#renderer.seedFrom(this.#previous, landing.x, landing.y, landing.w, landing.h);

			this.#move =
				animate && this.#worthAnimating(from, view)
					? {
							from,
							delta,
							// Progress is carried, not recomputed from the clock.
							// The duration gets revised upward mid-move once the
							// render says how slow it will be, and elapsed/duration
							// would then *fall* -- the zoom visibly ran backwards
							// by a fifth of the move before jumping forward again.
							progress: 0,
							lastTick: performance.now(),
							duration: clamp(this.#renderer.predict(view), MIN_MS, MAX_MS),
							landed: false,
							settleFrom: null,
						}
					: null;
		} else {
			this.#move = null;
		}

		this.#renderer.render(view);
		this.#run();
	}

	/** A move too small to see isn't worth a transition. */
	#worthAnimating(from, to) {
		const zoomed = Math.abs(Math.log2(to.perPixel / from.perPixel)) > 0.02;
		const delta = to.worldDelta(from);
		const moved = Math.hypot(delta.x, delta.y) / from.perPixel > 2;
		return zoomed || moved;
	}

	/** Redraw without touching geometry -- after a palette change. */
	refresh() {
		this.#drawBuffer(1);
	}

	#drawBuffer(alpha) {
		this.#ctx.globalAlpha = alpha;
		this.#ctx.drawImage(this.#renderer.surface, 0, 0);
		this.#ctx.globalAlpha = 1;
	}

	#drawStretched(p) {
		const { width, height } = this.#canvas;
		const move = this.#move;
		const rect = sampleRect(move.from, move.delta, this.#target.perPixel, p, width, height);

		// Zooming out reaches past the edge of what we have; leave black there
		// rather than smearing the previous frame across it.
		this.#ctx.fillStyle = '#000';
		this.#ctx.fillRect(0, 0, width, height);
		this.#ctx.drawImage(this.#previous, rect.x, rect.y, rect.w, rect.h, 0, 0, width, height);
	}

	#run() {
		if (this.#pending === null) this.#pending = requestAnimationFrame(() => this.#tick());
	}

	#tick() {
		this.#pending = null;
		const now = performance.now();
		const move = this.#move;

		if (move && !move.landed) {
			move.duration = paceDuration(
				move.progress,
				move.duration,
				this.#renderer.remainingMs(),
			);

			// Advance by however long the last frame actually took. Revising the
			// duration now changes only the speed from here on; it can never
			// walk the picture backwards.
			const step = Math.max(0, now - move.lastTick);
			move.lastTick = now;
			move.progress = Math.min(1, move.progress + step / move.duration);

			if (move.progress < 1) {
				this.#drawStretched(ease(move.progress));
				this.#run();
				return;
			}

			move.landed = true;
			// Only worth fading if the sharp frame is already there. If it
			// isn't, the seed means the buffer looks identical to what's on
			// screen anyway, so we can switch to it with nothing to hide.
			move.settleFrom = this.#renderer.complete ? now : null;
		}

		if (move && move.settleFrom !== null) {
			const fade = clamp((now - move.settleFrom) / SETTLE_MS, 0, 1);
			this.#drawStretched(1);
			this.#drawBuffer(fade);
			if (fade < 1) {
				this.#run();
				return;
			}
			this.#move = null;
		} else {
			this.#drawBuffer(1);
		}

		if (!this.#renderer.complete) this.#run();
		else this.#move = null;
	}
}
