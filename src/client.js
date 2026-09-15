const BASE_URL = process.env.SCRUPP_API_URL ?? "https://api.scrupp.com/api/v1";

class ScruppError extends Error {
	constructor(message, code, status) {
		super(message);
		this.name = "ScruppError";
		this.code = code;
		this.status = status;
	}
}

async function call(path, { method = "GET", body, headers } = {}) {
	const apiKey = process.env.SCRUPP_API_KEY;
	if (!apiKey) {
		throw new ScruppError("SCRUPP_API_KEY is not set.", "invalid_api_key");
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
			payload.message ?? payload.error ?? `Scrupp returned ${response.status}`,
			payload.error_code,
			response.status,
		);
	}

	return { status: response.status, payload };
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
				`Job ${created.job_id} failed: ${state.error ?? "unknown error"}`,
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
