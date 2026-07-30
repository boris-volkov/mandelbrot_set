// Wiring: input, history, the readout, and the timer.

import { toDecimalString } from './fixed.js';
import { iterationsAt, mapping, PALETTES, repeatsAcross, spectrum } from './palette.js';
import { Renderer } from './render.js';
import { MIN_PER_PIXEL, ViewState } from './state.js';
import { Viewport } from './view.js';

/** How long a frame has to take before we bother you with a progress panel. */
const PROGRESS_AFTER = 350;

/** Keep total pixel count sane on phones and 5K displays alike. */
const MAX_PIXELS = 3_000_000;

/** How far the colour frequency can be pushed: a broad wash, to banding per pixel. */
const MIN_DENSITY = 0.1;
const MAX_DENSITY = 20;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const $ = (id) => document.getElementById(id);

const canvas = $('canvas');
const progress = $('progress');
const toast = $('toast');
const help = $('help');
const spectrumCanvas = $('spectrum');
const spectrumCtx = spectrumCanvas.getContext('2d');
// Scratch surface the spectrum is drawn into at one pixel tall, then stretched
// to fill the visible strip. A gradient is exactly as cheap to draw at any
// height, so there's no reason to compute more than one row of it.
const spectrumStrip = document.createElement('canvas');
const spectrumStripCtx = spectrumStrip.getContext('2d');

let scale = 1;
let state;
let busy = false;
let renderStarted = 0;
let showTimer = null;
let clockFrame = null;

const renderer = new Renderer(onRenderEvent);
const viewport = new Viewport(canvas, renderer);

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

function fitCanvas() {
	const cssWidth = Math.max(1, window.innerWidth);
	const cssHeight = Math.max(1, window.innerHeight);

	scale = Math.min(window.devicePixelRatio || 1, 2);
	while (scale > 0.5 && cssWidth * cssHeight * scale * scale > MAX_PIXELS) scale -= 0.25;

	return viewport.setSize(Math.round(cssWidth * scale), Math.round(cssHeight * scale));
}

/** Pointer position in canvas pixels, which is what the state works in. */
function devicePoint(event) {
	const box = canvas.getBoundingClientRect();
	return {
		x: (event.clientX - box.left) * (canvas.width / box.width),
		y: (event.clientY - box.top) * (canvas.height / box.height),
	};
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let queued = false;
let queuedAnimate = true;

/**
 * Coalesce rapid input into one frame's worth of work. If anything in the
 * batch wants a straight cut -- a resize, say -- the whole batch cuts.
 */
function schedule({ animate = true } = {}) {
	queuedAnimate = queued ? queuedAnimate && animate : animate;
	if (queued) return;
	queued = true;
	requestAnimationFrame(() => {
		queued = false;
		const animating = queuedAnimate;
		queuedAnimate = true;
		updateReadout();
		viewport.go(state, { animate: animating });
	});
}

function onRenderEvent(event) {
	switch (event.type) {
		case 'phase':
			// `started` comes from the renderer, so a frame that supersedes one
			// still in flight restarts the clock instead of inheriting it.
			startTiming(event.started);
			$('progress-phase').textContent = {
				iterations: 'sizing up the view',
				reference: 'high-precision orbit',
				tiles: 'rendering',
			}[event.phase];
			setBar(0);
			$('progress-detail').textContent =
				event.phase === 'reference' ? `${state.prec} bits of precision` : '';
			break;

		case 'iterations':
			// The renderer measured what this view actually needs. Keep it, so
			// the readout and the URL say what was drawn -- and redraw the
			// spectrum, whose axis now runs 0 to this exact number and was
			// still showing the pre-render guess until this fires.
			state.maxIterations = event.value;
			$('iter').textContent = `${event.value.toLocaleString()} (auto)`;
			history.replaceState(null, '', state.toURL());
			drawSpectrum();
			break;

		case 'reference-progress':
			setBar(event.done / event.total);
			$('progress-detail').textContent =
				`orbit ${event.done.toLocaleString()} / ${event.total.toLocaleString()}`;
			break;

		case 'progress': {
			setBar(event.done / event.total);
			const remaining = (event.elapsed / event.done) * (event.total - event.done);
			$('progress-detail').textContent =
				event.done < event.total && remaining > 900
					? `${event.done}/${event.total} tiles · about ${formatSeconds(remaining)} left`
					: `${event.done}/${event.total} tiles`;
			break;
		}

		case 'done':
			stopTiming();
			$('frame').textContent = formatSeconds(event.elapsed);
			break;

		case 'error':
			stopTiming();
			console.error(event.error);
			flash('render failed — see the console');
			break;
	}
}

function setBar(fraction) {
	$('progress-bar').style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

function formatSeconds(ms) {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

// ---------------------------------------------------------------------------
// The timer
// ---------------------------------------------------------------------------

function startTiming(started) {
	renderStarted = started;
	if (busy) return; // already counting; the panel is on its way or already up
	busy = true;
	document.body.classList.add('busy');

	clearTimeout(showTimer);
	showTimer = setTimeout(() => {
		progress.hidden = false;
		tickClock();
	}, PROGRESS_AFTER);
}

function tickClock() {
	if (!busy) return;
	$('clock').textContent = formatSeconds(performance.now() - renderStarted);
	clockFrame = requestAnimationFrame(tickClock);
}

function stopTiming() {
	busy = false;
	document.body.classList.remove('busy');
	clearTimeout(showTimer);
	cancelAnimationFrame(clockFrame);
	progress.hidden = true;
}

// ---------------------------------------------------------------------------
// Readout
// ---------------------------------------------------------------------------

function updateReadout() {
	const digits = Math.min(state.significantDigits, 24);
	$('re').textContent = toDecimalString(state.cx, state.prec, digits);
	$('im').textContent = toDecimalString(state.cy, state.prec, digits);
	$('zoom').textContent = formatZoom(state.magnification(renderer.width, renderer.height));
	$('iter').textContent =
		state.maxIterations.toLocaleString() + (state.autoIterations ? ' (auto)' : '');
	$('math').textContent = state.deep ? `perturbation · ${state.prec} bits` : 'double precision';
	document
		.querySelector('[data-act="auto"]')
		.setAttribute('aria-pressed', String(state.autoIterations));
	drawSpectrum();
}

/** Canvas text needs a real font stack; CSS custom properties don't reach it. */
const MONO_FONT = 'ui-monospace, "SF Mono", "Cascadia Mono", "Courier New", monospace';

/** Split of the strip's CSS height between the gradient and its axis. Keep in sync with #spectrum's height in style.css. */
const SPECTRUM_GRADIENT_H = 16;
const SPECTRUM_LABEL_H = 12;

/** Minimum room a labelled interior tick needs, in CSS px, before it's skipped as clutter. */
const SPECTRUM_LABEL_MIN_PERIOD = 40;

/** Shortest legible form of an escape count: "0" .. "38.2k" .. "199k". */
function formatNu(n) {
	if (n < 1000) return String(Math.round(n));
	const k = n / 1000;
	return (k < 10 ? k.toFixed(1) : String(Math.round(k))) + 'k';
}

/**
 * A picture of the colouring function in place of the numbers for it.
 *
 * "Bands ×1.95" and "shift 0.34" only mean something once you've done the
 * mental arithmetic; this is that arithmetic, done for you and drawn as a
 * strip. It's the palette laid flat and repeated -- count the copies and
 * that's the frequency, see where the pattern starts and that's the phase.
 *
 * The axis is escape count -- the actual input to the function, 0 on the
 * left to this frame's iteration cap on the right -- not pixel position and
 * not an abstract repeat index. It isn't spaced evenly in iterations, though:
 * it's spaced evenly in curve(nu), the same pow(nu, 0.4) colorize() applies,
 * so a fixed slice of the axis always carries a fixed slice of palette. Equal
 * spacing in raw iterations would do the opposite of what a graph is for --
 * it would cram every band into the first sliver near nu=0 and leave the
 * remaining nine-tenths of the strip a single near-solid colour, because
 * that's how badly the curve flattens at high nu. iterationsAt() is exactly
 * the label that belongs at a given x once the *drawing* is laid out this
 * way: what escape count is really at this position.
 *
 * The repeat count -- how many times the palette actually wraps between 0 and
 * the cap -- comes from repeatsAcross(), read straight off the same cap and
 * scale mapping() used to colour the real pixels. It won't be exactly the
 * bands ± density multiplier, because mapping()'s stretch is rounded to the
 * nearest power of two for stability; repeatsAcross() reports what actually
 * landed, not what was aimed for, so the tick count on the axis always
 * matches the bands you'd count in the picture.
 */
function drawSpectrum() {
	const box = spectrumCanvas.getBoundingClientRect();
	const width = Math.max(1, Math.round(box.width * scale));
	const gradientH = Math.round(SPECTRUM_GRADIENT_H * scale);
	const labelH = Math.round(SPECTRUM_LABEL_H * scale);
	spectrumCanvas.width = width;
	spectrumCanvas.height = gradientH + labelH;

	const cap = Math.max(1, state.maxIterations);
	const { scale: paletteScale } = mapping(cap, state.density, state.offset);
	const cycles = repeatsAcross(cap, paletteScale);

	spectrumStrip.width = width;
	spectrumStrip.height = 1;
	const colours = spectrum(width, { palette: state.palette, cycles, offset: state.offset });
	const image = new ImageData(width, 1);
	new Uint32Array(image.data.buffer).set(colours);
	spectrumStripCtx.putImageData(image, 0, 0);

	spectrumCtx.clearRect(0, 0, width, spectrumCanvas.height);
	spectrumCtx.drawImage(spectrumStrip, 0, 0, width, gradientH);

	// One tick per full repeat, so the count is something you can verify by
	// eye rather than take on faith. Skipped once they'd be closer together
	// than a few pixels -- past that they'd just be noise. Drawn with a
	// difference blend rather than a fixed colour, so a tick reads against a
	// bright band and a dark one alike instead of vanishing into whichever
	// palette happens to be showing. Offset still shifts where these fall --
	// it doesn't change what range of nu is on the axis, only which colour
	// from the palette lands on which part of it.
	const period = width / cycles;
	const startS = state.offset % 1;
	const first = (1 - startS) * period;

	if (period > 3 * scale) {
		spectrumCtx.globalCompositeOperation = 'difference';
		spectrumCtx.strokeStyle = '#fff';
		spectrumCtx.lineWidth = Math.max(1, Math.round(scale));
		spectrumCtx.beginPath();
		for (let x = first; x < width - 2 * scale; x += period) {
			const px = Math.round(x) + 0.5;
			spectrumCtx.moveTo(px, 0);
			spectrumCtx.lineTo(px, gradientH);
		}
		spectrumCtx.stroke();
		spectrumCtx.globalCompositeOperation = 'source-over';
	}

	// The axis text sits below the gradient, on the plain panel background, so
	// it doesn't need the difference trick -- one legible colour is enough.
	const inset = Math.round(2 * scale);
	const labelY = gradientH + Math.round(2 * scale);

	spectrumCtx.font = `${Math.round(9 * scale)}px ${MONO_FONT}`;
	spectrumCtx.fillStyle = '#7a8899';
	spectrumCtx.textBaseline = 'top';

	spectrumCtx.textAlign = 'left';
	spectrumCtx.fillText('0', inset, labelY);
	spectrumCtx.textAlign = 'right';
	spectrumCtx.fillText(formatNu(cap), width - inset, labelY);

	// Interior labels, once there's room for them without crowding each other
	// or the two edge labels above.
	if (period > SPECTRUM_LABEL_MIN_PERIOD * scale) {
		const edgeGuard = 24 * scale;
		spectrumCtx.textAlign = 'center';
		for (let x = first; x < width - 2 * scale; x += period) {
			if (x < edgeGuard || x > width - edgeGuard) continue;
			spectrumCtx.fillText(formatNu(iterationsAt(x / width, cap)), x, labelY);
		}
	}
}

function formatZoom(zoom) {
	if (zoom < 10_000) return `${zoom.toFixed(zoom < 10 ? 2 : 0)}×`;
	const exponent = Math.floor(Math.log10(zoom));
	return `${(zoom / 10 ** exponent).toFixed(2)}e${exponent}×`;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function commit({ push = false } = {}) {
	const url = state.toURL();
	if (push) history.pushState(null, '', url);
	else history.replaceState(null, '', url);
	schedule();
}

function zoomIn(point, factor = 2, push = true) {
	if (state.perPixel / factor < MIN_PER_PIXEL) {
		flash('as deep as a double can carry the offsets');
		return;
	}
	state.zoomTo(point, factor, renderer.width, renderer.height);
	commit({ push });
}

function panBy(dx, dy) {
	state.pan(dx, dy);
	commit({ push: true });
}

function reset() {
	const keep = { palette: state.palette, density: state.density, offset: state.offset };
	state = Object.assign(ViewState.initial(renderer.width, renderer.height), keep);
	commit({ push: true });
}

// ---------------------------------------------------------------------------
// Pointer
// ---------------------------------------------------------------------------

let drag = null;

canvas.addEventListener('pointerdown', (event) => {
	if (event.button !== 0) return;
	drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };

	// Capture keeps the moves coming if you drag off the canvas -- a nicety,
	// not a requirement. It throws if the browser no longer considers the
	// pointer active, and that must not cost us the click.
	try {
		canvas.setPointerCapture(event.pointerId);
	} catch {
		/* carry on without it */
	}
});

canvas.addEventListener('pointermove', (event) => {
	if (!drag || event.pointerId !== drag.id) return;
	const dx = event.clientX - drag.startX;
	const dy = event.clientY - drag.startY;

	if (!drag.moved && Math.hypot(dx, dy) < 5) return;
	drag.moved = true;
	document.body.classList.add('panning');
	canvas.style.transform = `translate(${dx}px, ${dy}px)`;
});

canvas.addEventListener('pointerup', (event) => {
	if (!drag || event.pointerId !== drag.id) return;
	const dx = event.clientX - drag.startX;
	const dy = event.clientY - drag.startY;
	const wasDragging = drag.moved;
	drag = null;

	canvas.style.transform = '';
	document.body.classList.remove('panning');

	if (wasDragging) {
		// The image follows your finger, so the centre moves the other way.
		panBy(-dx * scale, -dy * scale);
	} else {
		zoomIn(devicePoint(event));
	}
});

canvas.addEventListener('pointercancel', () => {
	drag = null;
	canvas.style.transform = '';
	document.body.classList.remove('panning');
});

canvas.addEventListener(
	'wheel',
	(event) => {
		event.preventDefault();
		const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
		const factor = Math.exp((-event.deltaY * lines) / 450);
		const clamped = Math.max(0.25, Math.min(4, factor));
		if (Math.abs(clamped - 1) < 0.001) return;

		state.zoomBy(clamped, devicePoint(event), renderer.width, renderer.height);
		commit();
	},
	{ passive: false },
);

// ---------------------------------------------------------------------------
// Buttons and keys
// ---------------------------------------------------------------------------

const actions = {
	left: () => panBy(-renderer.width / 10, 0),
	right: () => panBy(renderer.width / 10, 0),
	up: () => panBy(0, -renderer.height / 10),
	down: () => panBy(0, renderer.height / 10),
	in: () => zoomIn({ x: renderer.width / 2, y: renderer.height / 2 }),
	out: () => {
		state.zoomBy(0.5);
		commit({ push: true });
	},
	reset,
	'iter-up': () => {
		state.setIterations(state.maxIterations * 1.5);
		commit({ push: true });
	},
	'iter-down': () => {
		state.setIterations(state.maxIterations / 1.5);
		commit({ push: true });
	},
	auto: () => {
		if (state.autoIterations) state.setIterations(state.maxIterations);
		else state.useAutoIterations();
		commit({ push: true });
	},
	palette: () => {
		const next = (PALETTES.indexOf(state.palette) + 1) % PALETTES.length;
		state.palette = PALETTES[next];
		recolor();
	},
	// Phase: slide the whole palette along without changing how fast it cycles.
	shift: () => {
		state.offset = (state.offset + 0.12) % 1;
		recolor();
	},
	// Frequency: how many times the palette repeats across the same picture.
	'bands-down': () => bandsBy(1 / 1.25),
	'bands-up': () => bandsBy(1.25),
	link: copyLink,
	save: savePNG,
	help: () => help.showModal(),
};

/**
 * Change how many times the palette repeats across the picture.
 *
 * A step of 1.25 is fine enough to hunt with and coarse enough to get
 * somewhere. Kept out of `actions` on purpose: those are called with no
 * arguments by the toolbar, and this one would take a multiplier of undefined.
 */
function bandsBy(factor) {
	state.density = clamp(state.density * factor, MIN_DENSITY, MAX_DENSITY);
	recolor();
}

/** Palette changes never touch the maths, so re-use what we already computed. */
function recolor() {
	history.replaceState(null, '', state.toURL());
	updateReadout();
	if (renderer.recolor(state)) viewport.refresh();
	else schedule({ animate: false });
}

document.querySelectorAll('#toolbar button').forEach((button) => {
	button.addEventListener('click', () => actions[button.dataset.act]?.());
});

$('cancel').addEventListener('click', () => {
	renderer.cancel();
	stopTiming();
	flash('stopped');
});

window.addEventListener('keydown', (event) => {
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	if (event.target instanceof HTMLInputElement || help.open) return;

	const key = event.key;
	const map = {
		ArrowLeft: 'left',
		ArrowRight: 'right',
		ArrowUp: 'up',
		ArrowDown: 'down',
		i: 'in',
		o: 'out',
		Escape: 'reset',
		p: 'palette',
		c: 'shift',
		a: 'auto',
		l: 'link',
		s: 'save',
		'?': 'help',
	};

	if (key === '+' || key === '=') return void actions['iter-up']();
	if (key === '-' || key === '_') return void actions['iter-down']();
	if (key === '[') return void actions['bands-down']();
	if (key === ']') return void actions['bands-up']();
	if (key === 'h') return void document.body.classList.toggle('hide-ui');

	const action = map[key];
	if (!action) return;
	if (key.startsWith('Arrow')) event.preventDefault();
	actions[action]();
});

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

let toastTimer = null;

function flash(message) {
	toast.textContent = message;
	toast.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (toast.hidden = true), 2200);
}

async function copyLink() {
	const url = state.toURL();
	try {
		await navigator.clipboard.writeText(url);
		flash('link copied');
	} catch {
		flash('copy failed — the link is in the address bar');
	}
}

async function savePNG() {
	const blob = await renderer.toBlob();
	if (!blob) return;
	const link = document.createElement('a');
	link.href = URL.createObjectURL(blob);
	const zoom = formatZoom(state.magnification(renderer.width, renderer.height)).replace(/[^\w]/g, '');
	link.download = `mandelbrot-${zoom}.png`;
	link.click();
	URL.revokeObjectURL(link.href);
	flash('saved');
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

window.addEventListener('popstate', () => {
	const restored = ViewState.fromURL(window.location.href);
	if (restored) {
		state = restored;
		schedule();
	}
});

let resizeTimer = null;
window.addEventListener('resize', () => {
	clearTimeout(resizeTimer);
	resizeTimer = setTimeout(() => {
		if (fitCanvas()) schedule({ animate: false });
	}, 150);
});

fitCanvas();
state = ViewState.fromURL(window.location.href) ?? ViewState.initial(renderer.width, renderer.height);
history.replaceState(null, '', state.toURL());
schedule({ animate: false });
