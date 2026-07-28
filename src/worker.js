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

	// A whole frame at postage-stamp size, used to find out how many iterations
	// this view actually needs. Self-contained -- it computes its own reference
	// orbit, because the whole point is to try several iteration limits, and
	// the orbit's length depends on the limit. Only the count comes back.
	if (data.type === 'probe') {
		const { width, height, perPixel, maxIterations, deep } = data;
		const out = new Float32Array(width * height);

		if (deep) {
			const orbit = computeReference(data);
			const dx0 = (-width / 2 + 0.5) * perPixel;
			const dy0 = (-height / 2 + 0.5) * perPixel;
			perturbTile(out, width, height, dx0, dy0, perPixel, maxIterations, orbit);
		} else {
			directTile(out, width, height, data.x0, data.y0, perPixel, maxIterations);
		}

		let interior = 0;
		for (let i = 0; i < out.length; i++) if (out[i] === INTERIOR) interior++;
		postMessage({ kind: 'probe', interior, total: out.length });
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

	postMessage({ kind: 'tile', tile, data: out }, [out.buffer]);
};
