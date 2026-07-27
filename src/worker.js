// Worker plumbing. One of these per CPU core; the arithmetic lives in kernel.js.

import { computeReference, directTile, perturbTile } from './kernel.js';

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

	postMessage({ kind: 'tile', tile, data: out }, [out.buffer]);
};
