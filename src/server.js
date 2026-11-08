import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	addToWatchlist,
	buildSearch,
	createWatchlist,
	credits,
	jobResult,
	jobStatus,
	listWatchlists,
	runJob,
	ScruppError,
	verifyEmail,
	watchlistSignals,
} from "./client.js";

// Report the published package version, so serverInfo never drifts from npm again.
const { version } = createRequire(import.meta.url)("../package.json");

/**
 * Idempotency-Key for one tool call: a hash of the whole input, not its first
 * 200 characters. Two Sales Navigator URLs share a long prefix, so the
 * truncated form gave two different searches the same key and Scrupp refused
 * the second with 409 idempotency_key_reused. The ten-minute bucket keeps
 * client retries of one call deduplicated without replaying an old job when
 * the person deliberately runs the same search again later.
 */
export function idempotencyKeyFor(jobType, input, now = Date.now()) {
	const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 32);
	return `mcp-${jobType}-${digest}-${Math.floor(now / 600_000)}`;
}

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
 * private connector (mcp.scrupp.com/sn): core plus the rest of the API —
 * Sales Navigator search built from words, LinkedIn and Apollo searches,
 * profiles, companies, decision makers — which the Scrupp API runs on the
 * caller's own LinkedIn account with Sales Navigator when one is connected, and
 * otherwise on Scrupp's shared account pool (paid plans).
 */
export function createServer({ toolset = "full" } = {}) {
	// Claude reads `instructions` when the server connects: the one place to point
	// it at the setup guide, so a missing LinkedIn account or empty balance ends
	// with a link the person can follow, not a guess.
	const server = new McpServer(
		{ name: "scrupp", version },
		{
			instructions:
				"Scrupp setup guide and troubleshooting: https://scrupp.com/docs/api/claude. " +
				"When a tool reports missing credits or no connected LinkedIn account, give the person " +
				"the link from the error (or https://app.scrupp.com/app/plans for credits) and ask them to try again after.",
		},
	);
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
						idempotencyKey: idempotencyKeyFor(jobType, toInput(args)),
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
					"Sales Navigator account when there is one, otherwise on Scrupp's shared account pool (paid plans). Pass the returned `url` to scrupp_export_sales_navigator_search. If the size is far " +
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
				"companies and, by default, verified work emails. Runs on the user's own Sales Navigator account connected " +
				"with the Scrupp extension when there is one, otherwise on Scrupp's shared account pool (paid plans). One credit per record; check scrupp_credits first and start with a small `max` " +
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
	}

	// The rest of the API. On the private connector the Scrupp API decides whose
	// session runs each job: the caller's own LinkedIn account with Sales
	// Navigator when one is connected, otherwise the shared account pool, which
	// is open to paid plans only.
	const ownAccounts = sn
		? " Runs on the user's own LinkedIn account with Sales Navigator when one is connected with the Scrupp extension; otherwise on Scrupp's shared account pool (paid plans)."
		: "";

	if (full || sn) {
		extractionTool({
			name: "scrupp_export_linkedin_search",
			title: "Export a LinkedIn search",
			description:
				"Extract the people from a regular LinkedIn people-search URL. Use this for linkedin.com/search/results/people URLs; use the Sales Navigator tool for linkedin.com/sales URLs." + ownAccounts,
			schema: searchSchema,
			toInput: searchInput,
			type: "linkedin.search",
		});

		extractionTool({
			name: "scrupp_run_apollo_search",
			title: "Run an Apollo search",
			description:
				"Extract the people from an Apollo search URL. Requires a connected Apollo account, passed as `account`." + ownAccounts,
			schema: { ...searchSchema, account: z.string().describe("Connected Apollo account email. Required.") },
			toInput: searchInput,
			type: "apollo.search",
		});

		extractionTool({
			name: "scrupp_enrich_linkedin_profiles",
			title: "Enrich LinkedIn profiles",
			description:
				"Full profile data for LinkedIn profile URLs: current title, company, location, experience." + ownAccounts,
			schema: {
				profile_urls: z.array(z.string().url()).min(1).describe("LinkedIn profile URLs."),
				with_emails: z
					.boolean()
					.optional()
					.describe("Also find and verify work emails (billed per enriched profile plus per email found). Defaults to false."),
			},
			toInput: (args) => ({ items: args.profile_urls }),
			type: (args) => (args.with_emails ? "email.linkedin" : "linkedin.profile"),
		});

		extractionTool({
			name: "scrupp_lookup_company",
			title: "Look up a company",
			description:
				"Company data — size, industry, location, website, LinkedIn — from a domain, a company LinkedIn URL, or a name." + ownAccounts,
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
				"The people worth writing to at a company you only know the domain, LinkedIn URL or name of. Returns names, titles and (where found) work emails." + ownAccounts,
			schema: {
				find_by: z.enum(["domain", "linkedin", "name"]).describe("What the values in `companies` are."),
				companies: z.array(z.string()).min(1).describe("Domains, LinkedIn URLs or names."),
				max: z.number().int().min(1).max(2500).optional().describe("Decision makers per company. Defaults to 10."),
			},
			toInput: (args) => ({ items: args.companies, max: args.max ?? 10 }),
			type: (args) => `contact.decision_maker.${args.find_by}`,
		});

		extractionTool({
			name: "scrupp_get_post_engagers",
			title: "Get the people engaging with a LinkedIn post",
			description:
				"Everyone who reacted to or commented on one LinkedIn post (a linkedin.com/posts/... link), with their titles and companies. " +
				"A warm audience: they already showed interest in the topic. Emails are off by default; turn on with_emails to also find work emails." +
				ownAccounts,
			schema: {
				url: z.string().url().describe("The LinkedIn post link, for example https://www.linkedin.com/posts/name_topic-activity-7390000000000000000-AbCd."),
				with_emails: z.boolean().optional().describe("Also find work emails. Defaults to false."),
				max: z.number().int().min(1).optional().describe("Upper bound on people. One credit per person delivered. Defaults to 100."),
			},
			toInput: (args) => ({ url: args.url, with_emails: args.with_emails ?? false, max: args.max ?? 100 }),
			type: "post.engagers",
		});

		extractionTool({
			name: "scrupp_find_local_businesses",
			title: "Find local businesses on Google Maps",
			description:
				"Businesses of one kind in one area from Google Maps, each with its website, address, category, rating and review count " +
				"(under google_maps), and phone where Maps lists one. Follow up with scrupp_find_decision_makers on the websites to reach the owner or manager.",
			schema: {
				query: z.string().min(1).describe('The kind of business, for example "dentists" or "coffee shops".'),
				location: z.string().optional().describe('City or area, for example "Austin, TX".'),
				country: z
					.string()
					.length(2)
					.optional()
					.describe("Two-letter country code that sets the Google region, for example us, gb, de. Defaults to us."),
				max: z
					.number()
					.int()
					.min(1)
					.max(500)
					.optional()
					.describe("Upper bound on businesses, 500 at most. One credit per business delivered. Defaults to 100."),
			},
			toInput: (args) => ({
				query: args.query,
				...(args.location ? { location: args.location } : {}),
				country: (args.country ?? "us").toLowerCase(),
				max: args.max ?? 100,
			}),
			type: "maps.search",
		});
	}

	// Signals. Only for a user's own key: the hosted connectors' keys are not
	// let through to /watchlists, and a watchlist commits to recurring spend.
	if (full) {
		const watchItems = z
			.array(z.string().min(1))
			.min(1)
			.max(1000)
			.describe("LinkedIn profile URLs for people, or company domains / LinkedIn company URLs for companies. 1000 per call at most.");

		server.registerTool(
			"scrupp_watch",
			{
				title: "Watch people or companies for changes",
				annotations: { title: "Watch people or companies for changes", ...SPENDS, idempotentHint: false },
				description:
					"Put people or companies on a Scrupp watchlist so job changes, promotions, new employers, funding and headcount moves are picked up on a schedule. " +
					"Creating and adding is free; each check costs 0.5 credit per watched item (weekly by default). " +
					"Pass watchlist_id to add to an existing list instead of creating one. `not_found` lists items Scrupp has no record of yet: they stay on the list but cannot signal until it does. " +
					"Read what was found with scrupp_list_signals.",
				inputSchema: {
					items: watchItems,
					watchlist_id: z.number().int().optional().describe("Add to this existing watchlist instead of creating a new one."),
					type: z
						.enum(["contact", "company"])
						.optional()
						.describe('"contact" for people (LinkedIn profile URLs), "company" for companies. New lists only; defaults to contact.'),
					name: z.string().optional().describe("Name for a new watchlist."),
					check_every_days: z
						.union([z.literal(1), z.literal(7)])
						.optional()
						.describe("1 for daily checks, 7 for weekly. New lists only; defaults to 7."),
					callback_url: z
						.string()
						.url()
						.optional()
						.describe("Public HTTPS URL that receives each batch of new signals as a POST. New lists only."),
				},
			},
			async ({ items, watchlist_id, type, name, check_every_days, callback_url }) => {
				try {
					if (watchlist_id !== undefined) {
						return json(await addToWatchlist(watchlist_id, items));
					}
					return json(
						await createWatchlist({
							items,
							...(type ? { type } : {}),
							...(name ? { name } : {}),
							...(check_every_days ? { check_every_days } : {}),
							...(callback_url ? { callback_url } : {}),
						}),
					);
				} catch (error) {
					return failure(error);
				}
			},
		);

		server.registerTool(
			"scrupp_list_signals",
			{
				title: "Read signals from a watchlist",
				annotations: { title: "Read signals from a watchlist", ...READS },
				description:
					"What changed for the people or companies on a watchlist: job changes, promotions, new companies, funding and headcount moves, newest first. " +
					"Without watchlist_id, lists your watchlists with their size, schedule and price per check. Free to call.",
				inputSchema: {
					watchlist_id: z.number().int().optional().describe("The watchlist to read. Leave out to list your watchlists."),
					since: z.string().optional().describe("Only signals detected at or after this ISO 8601 date or time."),
					limit: z.number().int().min(1).max(200).optional().describe("How many signals, 200 at most. Defaults to 50."),
				},
			},
			async ({ watchlist_id, since, limit }) => {
				try {
					if (watchlist_id === undefined) {
						return json(await listWatchlists());
					}
					return json(await watchlistSignals(watchlist_id, { since, limit }));
				} catch (error) {
					return failure(error);
				}
			},
		);
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
