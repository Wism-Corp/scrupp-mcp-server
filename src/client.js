import { AsyncLocalStorage } from "node:async_hooks";

const BASE_URL = process.env.SCRUPP_API_URL ?? "https://api.scrupp.com/api/v1";

// Over HTTP every request carries its own caller's key; over stdio there is one
// caller and the key comes from the environment. Scoping the key to the request
// keeps one shared process from ever answering with somebody else's account.
const requestKey = new AsyncLocalStorage();

export const withApiKey = (apiKey, fn) => requestKey.run(apiKey, fn);

class ScruppError extends Error {
	constructor(message, code, status) {
		super(message);
		this.name = "ScruppError";
		this.code = code;
		this.status = status;
	}
}

async function call(path, { method = "GET", body, headers } = {}) {
	const apiKey = requestKey.getStore() ?? process.env.SCRUPP_API_KEY;
	if (!apiKey) {
		throw new ScruppError("No Scrupp API key: set SCRUPP_API_KEY or send Authorization: Bearer.", "invalid_api_key");
	}

	const response = await fetch(`${BASE_URL}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			...headers,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	const payload = await response.json().catch(() => ({}));

	// A 409 on the result endpoint means "not finished yet" — the caller decides.
	if (!response.ok && response.status !== 409) {
		throw new ScruppError(
			errorText(payload.message ?? payload.error, `Scrupp returned ${response.status}`),
			payload.error_code ?? payload.error?.code,
			response.status,
		);
	}

	return { status: response.status, payload };
}

/**
 * Scrupp answers errors in two shapes: `{message, error_code}` and
 * `{error: {code, message}}` (the Jobs API). Passing the object straight into
 * Error gave Claude "[object Object]" instead of the reason.
 */
export function errorText(error, fallback) {
	if (typeof error === "string" && error) return error;
	if (error && typeof error === "object" && typeof error.message === "string" && error.message) return error.message;
	return fallback;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function ping() {
	const { payload } = await call("/ping");
	return payload;
}

export async function credits() {
	const { payload } = await call("/account/credits");
	return payload;
}

/** One address per call, one credit each — the API has no batch form. */
export async function verifyEmail(email) {
	const { payload } = await call("/email/verify", { method: "POST", body: { email } });
	return payload;
}

/**
 * Describe an audience in words, get a Sales Navigator search URL whose size
 * Sales Navigator itself reported. No credits for records — it only builds.
 */
export async function buildSearch(prompt) {
	const { payload } = await call("/search/build", { method: "POST", body: { prompt } });
	return payload;
}

export async function createJob(type, input, idempotencyKey) {
	const { payload } = await call("/jobs", {
		method: "POST",
		body: { type, input },
		headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
	});
	return payload;
}

export async function jobStatus(jobId) {
	const { payload } = await call(`/jobs/${jobId}`);
	return payload;
}

export async function jobResult(jobId) {
	const { status, payload } = await call(`/jobs/${jobId}/result`);
	return { ready: status === 200, payload };
}

/**
 * Create a job and wait, but only for as long as an agent should reasonably
 * block. If the job outlives that budget we hand back the job id rather than
 * holding the conversation open — the agent can call `scrupp_get_job` later.
 */
export async function runJob({ type, input, idempotencyKey, waitSeconds }) {
	const created = await createJob(type, input, idempotencyKey);
	const deadline = Date.now() + waitSeconds * 1000;

	while (Date.now() < deadline) {
		const state = await jobStatus(created.job_id);

		if (state.status === "failed") {
			throw new ScruppError(
				`Job ${created.job_id} failed: ${errorText(state.error, "unknown error")}`,
				"upstream_error",
			);
		}

		if (state.status === "succeeded") {
			const { payload } = await jobResult(created.job_id);
			return {
				job_id: created.job_id,
				status: "succeeded",
				items: payload?.data?.items ?? [],
			};
		}

		await sleep(Math.max(1, state.retry_after ?? 5) * 1000);
	}

	return {
		job_id: created.job_id,
		status: "running",
		items: [],
		note:
			`The job is still running after ${waitSeconds}s. It keeps going on Scrupp — ` +
			`call scrupp_get_job with job_id ${created.job_id} to collect the records.`,
	};
}

export { ScruppError };
