// Worker plumbing. One of these per CPU core; the arithmetic lives in kernel.js.

import { computeReference, directTile, INTERIOR, perturbTile } from './kernel.js';

// The reference orbit for the current frame. Pushed to us once per frame
// rather than bundled with every tile -- it can be megabytes.
let reference = null;

onmessage = (event) => {
	const { kind, data } = event.data;

	if (kind === 'session') {
		reference = data.reference;
		return;
	}

	if (data.type === 'reference') {
		const orbit = computeReference(data, (done, total) =>
			postMessage({ kind: 'progress', done, total }),
		);
		postMessage({ kind: 'reference', ...orbit }, [orbit.zr.buffer, orbit.zi.buffer]);
		return;
	}

	const { tile, width, height, perPixel, maxIterations, deep } = data;
	const out = new Float32Array(tile.w * tile.h);

	if (deep) {
		// Pixel offsets from the reference point, which sits at frame centre.
		const dx0 = (tile.x - width / 2 + 0.5) * perPixel;
		const dy0 = (tile.y - height / 2 + 0.5) * perPixel;
		perturbTile(out, tile.w, tile.h, dx0, dy0, perPixel, maxIterations, reference);
	} else {
		const x0 = data.x0 + tile.x * perPixel;
		const y0 = data.y0 + tile.y * perPixel;
		directTile(out, tile.w, tile.h, x0, y0, perPixel, maxIterations);
	}

	// The spread of escape values in this tile, so the palette can be stretched
	// to fit the frame. Interior pixels don't have one and are skipped.
	let lo = Infinity;
	let hi = -Infinity;
	for (let i = 0; i < out.length; i++) {
		const v = out[i];
		if (v === INTERIOR) continue;
		if (v < lo) lo = v;
		if (v > hi) hi = v;
	}

	postMessage({ kind: 'tile', tile, data: out, lo, hi }, [out.buffer]);
};
