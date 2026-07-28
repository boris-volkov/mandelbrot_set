// Wiring: input, history, the readout, and the timer.

import { toDecimalString } from './fixed.js';
import { PALETTES } from './palette.js';
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
			// the readout and the URL say what was drawn.
			state.maxIterations = event.value;
			$('iter').textContent = `${event.value.toLocaleString()} (auto)`;
			history.replaceState(null, '', state.toURL());
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
	$('colour').textContent =
		`${state.palette} · bands ×${state.density.toFixed(2)}` +
		(state.offset ? ` · shift ${state.offset.toFixed(2)}` : '');
	document
		.querySelector('[data-act="auto"]')
		.setAttribute('aria-pressed', String(state.autoIterations));
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
