// A pool of workers with a job queue.
//
// One addition over the usual design: a "session" message that every worker
// needs before it can do any work in a frame. The reference orbit can be
// megabytes, so we send it once per worker rather than bundling it with every
// tile. Workers handle messages in order, so no acknowledgement is needed --
// the session simply arrives before the first job that depends on it.

export class Cancelled extends Error {
	constructor() {
		super('render cancelled');
		this.name = 'Cancelled';
	}
}

export class WorkerPool {
	#url;
	#size;
	#workers = [];
	#idle = [];
	#queue = [];
	#busy = new Map();
	#session = null;
	#sessionId = 0;

	constructor(size, url) {
		this.#size = Math.max(1, size);
		this.#url = url;
		this.#fill();
	}

	get size() {
		return this.#size;
	}

	#fill() {
		while (this.#workers.length < this.#size) {
			const worker = new Worker(this.#url, { type: 'module' });
			worker.sessionId = -1;
			worker.onmessage = (event) => this.#finish(worker, null, event.data);
			worker.onerror = (event) => {
				event.preventDefault();
				this.#finish(worker, new Error(event.message || 'worker failed'), null);
			};
			this.#workers.push(worker);
			this.#idle.push(worker);
		}
	}

	/** Data every worker must receive before its next job. */
	setSession(data) {
		this.#session = data;
		this.#sessionId++;
	}

	run(job, { transfer = [], onProgress = null } = {}) {
		return new Promise((resolve, reject) => {
			const item = { job, transfer, onProgress, resolve, reject };
			const worker = this.#idle.pop();
			if (worker) this.#dispatch(worker, item);
			else this.#queue.push(item);
		});
	}

	#dispatch(worker, item) {
		this.#busy.set(worker, item);
		if (this.#session && worker.sessionId !== this.#sessionId) {
			worker.sessionId = this.#sessionId;
			worker.postMessage({ kind: 'session', data: this.#session });
		}
		worker.postMessage({ kind: 'job', data: item.job }, item.transfer);
	}

	#finish(worker, error, result) {
		// Progress pings aren't job completions; the worker is still busy.
		if (result && result.kind === 'progress') {
			this.#busy.get(worker)?.onProgress?.(result);
			return;
		}

		const item = this.#busy.get(worker);
		this.#busy.delete(worker);

		const next = this.#queue.shift();
		if (next) this.#dispatch(worker, next);
		else this.#idle.push(worker);

		if (!item) {
			// No job to blame -- usually the worker script itself failed to load.
			if (error) console.error('worker error with no job in flight:', error);
			return;
		}
		if (error) item.reject(error);
		else item.resolve(result);
	}

	/** Drop everything not yet started. In-flight tiles finish and are ignored. */
	clearQueue() {
		for (const item of this.#queue) item.reject(new Cancelled());
		this.#queue.length = 0;
	}

	/** Stop everything now. The only way to interrupt a worker mid-loop. */
	reset() {
		this.clearQueue();
		for (const item of this.#busy.values()) item.reject(new Cancelled());
		this.#busy.clear();
		for (const worker of this.#workers) worker.terminate();
		this.#workers.length = 0;
		this.#idle.length = 0;
		this.#fill();
	}
}
