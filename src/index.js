#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { credits, jobResult, jobStatus, runJob, ScruppError } from "./client.js";

const DEFAULT_WAIT_SECONDS = Number(process.env.SCRUPP_WAIT_SECONDS ?? 120);

const server = new McpServer({ name: "scrupp", version: "0.1.0" });

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

await server.connect(new StdioServerTransport());
