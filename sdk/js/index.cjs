/**
 * Eternium SDK — CommonJS build
 * See index.js for full source.
 */

const DEFAULT_BASE_URL = 'https://api.eternium.ai';
const DEFAULT_POLL_INTERVAL = 3000;
const DEFAULT_TIMEOUT = 300000;

class EterniumError extends Error {
	constructor(message, code, data) {
		super(message);
		this.name = 'EterniumError';
		this.code = code;
		this.data = data;
	}
}

class Eternium {
	constructor(apiKey, options = {}) {
		if (!apiKey) throw new EterniumError('API key is required', 'MISSING_KEY');
		this.apiKey = apiKey;
		this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
		this.pollInterval = options.pollInterval || DEFAULT_POLL_INTERVAL;
		this.timeout = options.timeout || DEFAULT_TIMEOUT;
		this.cache = options.cache !== false;
		this.onProgress = options.onProgress || null;
		this.generate = {
			image: (prompt, opts) => this.image(prompt, opts),
			video: (prompt, opts) => this.video(prompt, opts),
		};
		this.pipeline = {
			run: (name, prompt, opts) => this.runPipeline(name, prompt, opts),
			list: () => this.listPipelines(),
		};
	}

	async _request(method, path, body = null) {
		const url = `${this.baseUrl}${path}`;
		const headers = { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey };
		const opts = { method, headers };
		if (body) opts.body = JSON.stringify(body);
		const res = await fetch(url, opts);
		const data = await res.json();
		if (!res.ok) throw new EterniumError(data.error || `Request failed: ${res.status}`, res.status, data);
		return data;
	}

	async _waitForTask(taskId) {
		const start = Date.now();
		while (Date.now() - start < this.timeout) {
			const status = await this._request('GET', `/v1/tasks/${taskId}`);
			const taskStatus = status.data?.status || status.status;
			if (this.onProgress) this.onProgress({ taskId, status: taskStatus, elapsed: Date.now() - start });
			if (taskStatus === 'completed' || taskStatus === 'success') {
				try {
					const download = await this._request('GET', `/v1/tasks/${taskId}/download`);
					return { taskId, status: 'completed', url: download.data?.url || download.url || null, output: status.data || status, download: download.data || download };
				} catch { return { taskId, status: 'completed', output: status.data || status }; }
			}
			if (taskStatus === 'failed' || taskStatus === 'error') {
				throw new EterniumError(`Generation failed: ${status.data?.error || 'Unknown'}`, 'GENERATION_FAILED', status.data);
			}
			await new Promise(r => setTimeout(r, this.pollInterval));
		}
		throw new EterniumError(`Task ${taskId} timed out`, 'TIMEOUT');
	}

	async image(prompt, opts = {}) {
		const { model = 'nano-banana-pro', wait = true, ...params } = opts;
		const res = await this._request('POST', '/v1/generate', { model, prompt, cache: this.cache, ...params });
		if (res._cached) return { ...res, cached: true };
		const taskId = res.data?.taskId || res.taskId;
		if (!taskId) return res;
		if (!wait) return { taskId, status: 'submitted', cost: res._cost };
		return this._waitForTask(taskId);
	}

	async video(prompt, opts = {}) {
		const { model = 'kling-3.0', wait = true, ...params } = opts;
		const res = await this._request('POST', '/v1/generate', { model, prompt, cache: this.cache, ...params });
		if (res._cached) return { ...res, cached: true };
		const taskId = res.data?.taskId || res.taskId;
		if (!taskId) return res;
		if (!wait) return { taskId, status: 'submitted', cost: res._cost };
		return this._waitForTask(taskId);
	}

	async runPipeline(name, prompt, opts = {}) {
		const { wait = true, ...params } = opts;
		const res = await this._request('POST', '/v1/pipelines/run', { pipeline: name, prompt, ...params });
		if (!wait || !res.tasks) return res;
		const results = await Promise.allSettled(
			res.tasks.filter(t => t.taskId && t.status === 'submitted').map(t => this._waitForTask(t.taskId)),
		);
		return {
			pipeline: name, total_cost: res.total_cost,
			results: results.map((r, i) => ({ ...res.tasks[i], ...(r.status === 'fulfilled' ? r.value : { error: r.reason.message }) })),
		};
	}

	async listModels() { return this._request('GET', '/v1/models'); }
	async listPipelines() { return this._request('GET', '/v1/pipelines'); }
	async listTiers() { return this._request('GET', '/v1/tiers'); }
	async getUsage() { return this._request('GET', '/v1/usage'); }
	async getTaskStatus(taskId) { return this._request('GET', `/v1/tasks/${taskId}`); }
	async getDownloadUrl(taskId) { return this._request('GET', `/v1/tasks/${taskId}/download`); }
}

module.exports = { Eternium, EterniumError };
module.exports.default = Eternium;
