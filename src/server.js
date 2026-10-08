import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildSearch, credits, jobResult, jobStatus, runJob, ScruppError, verifyEmail } from "./client.js";

const DEFAULT_WAIT_SECONDS = Number(process.env.SCRUPP_WAIT_SECONDS ?? 120);

/**
 * Tool annotations the Claude connectors directory requires on every tool.
 * Spending credits is not "read-only", but nothing a tool does deletes or
 * overwrites the caller's data, so none of them is destructive.
 */
const READS = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const SPENDS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/**
 * `toolset: "full"` is every tool, for a user running the server on their own
 * machine with their own key. `"core"` is what the hosted connector exposes:
 * no tool that gathers data from LinkedIn or out of the shared lead base, only
 * email finding and verification plus the bookkeeping tools. `"sn"` is the
 * private Sales Navigator connector (mcp.scrupp.com/sn): core plus Sales
 * Navigator search, which the Scrupp API runs only on the caller's own
 * connected LinkedIn account.
 */
export function createServer({ toolset = "full" } = {}) {
	const server = new McpServer({ name: "scrupp", version: "0.3.0" });
	const full = toolset === "full";
	const sn = toolset === "sn";

	const json = (value) => ({
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
	});

	const failure = (error) => ({
		isError: true,
		content: [
			{
				type: "text",
				text:
					error instanceof ScruppError
						? `${error.code ?? "error"}: ${error.message}`
						: String(error?.message ?? error),
			},
		],
	});

	/**
	 * Every extraction tool is the same shape, so register them from a table.
	 * Keeping the descriptions concrete matters more here than anywhere else — the
	 * caller choosing between these tools is a model reading exactly this text.
	 */
	function extractionTool({ name, title, description, schema, toInput, type }) {
		server.registerTool(
			name,
			{
				title,
				description,
				annotations: { title, ...SPENDS },
				inputSchema: {
					...schema,
					wait_seconds: z
						.number()
						.int()
						.min(0)
						.optional()
						.describe(
							`How long to wait for the job before returning its id instead (default ${DEFAULT_WAIT_SECONDS}).`,
						),
				},
			},
			async (args) => {
				try {
					const jobType = typeof type === "function" ? type(args) : type;
					const result = await runJob({
						type: jobType,
						input: toInput(args),
						idempotencyKey: `mcp-${name}-${JSON.stringify(toInput(args))}`.slice(0, 200),
						waitSeconds: args.wait_seconds ?? DEFAULT_WAIT_SECONDS,
					});
					return json(result);
				} catch (error) {
					return failure(error);
				}
			},
		);
	}

	const searchSchema = {
		url: z.string().url().describe("The search URL, copied from the platform after building the filters."),
		with_emails: z.boolean().optional().describe("Also find work email addresses. Defaults to true."),
		max: z
			.number()
			.int()
			.min(1)
			.optional()
			.describe("Upper bound on records. Drives the credit hold; unused credits are refunded. Defaults to 100."),
		account: z.string().optional().describe("Connected account email to run the search with."),
	};

	const searchInput = (args) => ({
		url: args.url,
		with_emails: args.with_emails ?? true,
		max: args.max ?? 100,
		...(args.account ? { account: args.account } : {}),
	});

	if (sn) {
		server.registerTool(
			"scrupp_build_sales_navigator_search",
			{
				title: "Build a Sales Navigator search",
				annotations: { title: "Build a Sales Navigator search", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
				description:
					"Turn a plain-words audience (role, industry, country or cities, company size) into a Sales Navigator search URL, " +
					"and report how many people Sales Navigator says it matches. Costs no credits. Runs on the user's own connected " +
					"Sales Navigator account. Pass the returned `url` to scrupp_export_sales_navigator_search. If the size is far " +
					"from what the user wants, rephrase the audience and build again before exporting.",
				inputSchema: {
					audience: z
						.string()
						.min(3)
						.describe('The audience in words, e.g. "operations directors in logistics, United States, 50-200 employees".'),
				},
			},
			async ({ audience }) => {
				try {
					return json(await buildSearch(audience));
				} catch (error) {
					return failure(error);
				}
			},
		);

		extractionTool({
			name: "scrupp_export_sales_navigator_search",
			title: "Export a Sales Navigator search",
			description:
				"Extract the people from a LinkedIn Sales Navigator search URL (linkedin.com/sales/search/people), with titles, " +
				"companies and, by default, verified work emails. Runs only on the user's own Sales Navigator account connected " +
				"with the Scrupp extension. One credit per record; check scrupp_credits first and start with a small `max` " +
				"to confirm the list looks right before exporting the whole search.",
			schema: {
				...searchSchema,
				account: z
					.string()
					.optional()
					.describe("Which of the user's own connected LinkedIn accounts to use, by email. Defaults to one with Sales Navigator."),
			},
			toInput: searchInput,
			type: "sales_navigator.search",
		});
	}

	if (full) {
		extractionTool({
			name: "scrupp_export_sales_navigator_search",
			title: "Export a Sales Navigator search",
			description:
				"Extract the people from a LinkedIn Sales Navigator search URL, with their titles, companies and (by default) verified work emails. Use this when the user has a Sales Navigator search they want as a list.",
			schema: searchSchema,
			toInput: searchInput,
			type: "sales_navigator.search",
		});

		extractionTool({
			name: "scrupp_export_linkedin_search",
			title: "Export a LinkedIn search",
			description:
				"Extract the people from a regular LinkedIn people-search URL. Use this for linkedin.com/search/results/people URLs; use the Sales Navigator tool for linkedin.com/sales URLs.",
			schema: searchSchema,
			toInput: searchInput,
			type: "linkedin.search",
		});

		extractionTool({
			name: "scrupp_run_apollo_search",
			title: "Run an Apollo search",
			description:
				"Extract the people from an Apollo search URL. Requires a connected Apollo account, passed as `account`.",
			schema: { ...searchSchema, account: z.string().describe("Connected Apollo account email. Required.") },
			toInput: searchInput,
			type: "apollo.search",
		});

		extractionTool({
			name: "scrupp_enrich_linkedin_profiles",
			title: "Enrich LinkedIn profiles",
			description:
				"Full profile data for LinkedIn profile URLs: current title, company, location, experience.",
			schema: {
				profile_urls: z.array(z.string().url()).min(1).describe("LinkedIn profile URLs."),
			},
			toInput: (args) => ({ items: args.profile_urls }),
			type: "linkedin.profile",
		});

		extractionTool({
			name: "scrupp_lookup_company",
			title: "Look up a company",
			description:
				"Company data — size, industry, location, website, LinkedIn — from a domain, a company LinkedIn URL, or a name.",
			schema: {
				lookup_by: z.enum(["domain", "linkedin", "name"]).describe("What the values in `companies` are."),
				companies: z.array(z.string()).min(1).describe("Domains, LinkedIn URLs or names."),
			},
			toInput: (args) => ({ items: args.companies }),
			type: (args) => `company.${args.lookup_by}`,
		});

		extractionTool({
			name: "scrupp_find_decision_makers",
			title: "Find decision makers at a company",
			description:
				"The people worth writing to at a company you only know the domain, LinkedIn URL or name of. Returns names, titles and (where found) work emails.",
			schema: {
				find_by: z.enum(["domain", "linkedin", "name"]).describe("What the values in `companies` are."),
				companies: z.array(z.string()).min(1).describe("Domains, LinkedIn URLs or names."),
				max: z.number().int().min(1).max(2500).optional().describe("Decision makers per company. Defaults to 10."),
			},
			toInput: (args) => ({ items: args.companies, max: args.max ?? 10 }),
			type: (args) => `contact.decision_maker.${args.find_by}`,
		});
	}

	extractionTool({
		name: "scrupp_find_emails",
		title: "Find work emails",
		description:
			"Find and verify work email addresses from first name, last name and company domain. Addresses that cannot be verified come back marked rather than guessed.",
		schema: {
			people: z
				.array(
					z.object({
						first_name: z.string(),
						last_name: z.string(),
						domain: z.string().describe("Company domain, for example acme.com."),
					}),
				)
				.min(1),
		},
		toInput: (args) => ({ items: args.people }),
		type: "email.initials",
	});

	server.registerTool(
		"scrupp_get_job",
		{
			title: "Check or collect a Scrupp job",
			annotations: { title: "Check or collect a Scrupp job", ...READS },
			description:
				"Status of a job, and its records once it has finished. Use this for a job that was still running when the tool that started it returned.",
			inputSchema: { job_id: z.number().int().describe("The job id returned by an extraction tool.") },
		},
		async ({ job_id }) => {
			try {
				const state = await jobStatus(job_id);
				if (state.status !== "succeeded") {
					return json(state);
				}
				const { payload } = await jobResult(job_id);
				return json({ job_id, status: "succeeded", items: payload?.data?.items ?? [] });
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"scrupp_credits",
		{
			title: "Credit balance",
			annotations: { title: "Credit balance", ...READS },
			description:
				"Remaining Scrupp credits and the current plan. Worth checking before starting a large export — one credit is one record requested.",
			inputSchema: {},
		},
		async () => {
			try {
				return json(await credits());
			} catch (error) {
				return failure(error);
			}
		},
	);

	server.registerTool(
		"scrupp_verify_emails",
		{
			title: "Verify email addresses",
			annotations: { title: "Verify email addresses", ...SPENDS, idempotentHint: false },
			description:
				"Check whether email addresses are deliverable before sending to them. Costs one credit per address; use it on addresses you already have, not on ones scrupp_find_emails just returned (those are verified already).",
			inputSchema: {
				emails: z.array(z.string().email()).min(1).max(100).describe("Addresses to verify, at most 100 per call."),
			},
		},
		async ({ emails }) => {
			const results = [];
			for (const email of emails) {
				try {
					results.push({ email, ...(await verifyEmail(email)) });
				} catch (error) {
					// One bad address must not throw away the answers already paid for.
					results.push({ email, error: error?.message ?? String(error) });
				}
			}
			return json({ results });
		},
	);

	return server;
}
