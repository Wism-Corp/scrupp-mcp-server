#!/usr/bin/env node
/**
 * The hosted connector: Streamable HTTP, stateless, one server per request.
 *
 * Auth is a bearer token that the Scrupp API accepts: either a key the user
 * pasted, or the key app.scrupp.com issued through OAuth when they pressed
 * Connect in Claude. This server never sees a password or a code — it only
 * points the client at the authorization server (RFC 9728) and forwards the
 * token. What a connector key may reach is enforced by the API itself
 * (ConnectorKeyGuard in the Scrupp app), not here.
 */
import { createServer as createHttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { credits, ScruppError, withApiKey } from "./client.js";
import { createServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 8787);
const MAX_BODY_BYTES = 1024 * 1024;
// The public URL of this server and of the Scrupp app that issues its tokens.
// Both are absolute in the metadata, so they come from config, not the request.
const PUBLIC_URL = (process.env.MCP_PUBLIC_URL ?? "https://mcp.scrupp.com").replace(/\/$/, "");
const AUTH_SERVER_URL = (process.env.SCRUPP_AUTH_SERVER_URL ?? "https://app.scrupp.com").replace(/\/$/, "");
const RESOURCE_METADATA_URL = `${PUBLIC_URL}/.well-known/oauth-protected-resource`;

/**
 * Two connectors on one server. `/mcp` is the public one (emails only, listed
 * in the Claude directory). `/sn` is the private Sales Navigator connector that
 * customers add by URL. They differ in the OAuth resource: app.scrupp.com
 * issues a Sales Navigator key only for the `/sn` resource, and the API, not
 * this server, decides what each key may reach.
 */
const ENDPOINTS = {
	"/mcp": { toolset: "core", metadataUrl: RESOURCE_METADATA_URL },
	"/sn": { toolset: "sn", metadataUrl: `${RESOURCE_METADATA_URL}/sn` },
};

const resourceMetadata = (path) => ({
	resource: `${PUBLIC_URL}${path}`,
	authorization_servers: [AUTH_SERVER_URL],
	bearer_methods_supported: ["header"],
	resource_documentation: "https://scrupp.com/docs/api/claude",
});

// OAuth access tokens expire hourly. A client only refreshes on HTTP 401 from
// this server, and a dead token would otherwise surface as a tool error inside
// a 200 — the connector would just stop working after an hour. So the token is
// checked before the request is handled, and the answer cached briefly.
const TOKEN_CHECK_TTL_MS = 60 * 1000;
const checkedTokens = new Map();

async function tokenIsValid(apiKey) {
	const cached = checkedTokens.get(apiKey);
	if (cached && cached > Date.now()) {
		return true;
	}
	try {
		await withApiKey(apiKey, () => credits());
	} catch (error) {
		if (error instanceof ScruppError && (error.status === 401 || error.code === "invalid_api_key")) {
			checkedTokens.delete(apiKey);
			return false;
		}
		// Scrupp being down is not the token's fault: let the tool report it.
		return true;
	}
	if (checkedTokens.size > 10000) {
		checkedTokens.clear();
	}
	checkedTokens.set(apiKey, Date.now() + TOKEN_CHECK_TTL_MS);
	return true;
}

const unauthorized = (res, metadataUrl, message, error) => {
	res.setHeader(
		"WWW-Authenticate",
		`Bearer resource_metadata="${metadataUrl}"${error ? `, error="${error}"` : ""}`,
	);
	return reply(res, 401, { jsonrpc: "2.0", error: { code: -32001, message }, id: null });
};

const reply = (res, status, body) => {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
};

const readJson = (req) =>
	new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("Request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});

const httpServer = createHttpServer(async (req, res) => {
	const { pathname } = new URL(req.url, "http://localhost");

	if (pathname === "/health") {
		return reply(res, 200, { ok: true });
	}
	// RFC 9728: where a client learns which server issues tokens for a resource.
	if (pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-protected-resource/mcp") {
		return reply(res, 200, resourceMetadata("/mcp"));
	}
	if (pathname === "/.well-known/oauth-protected-resource/sn") {
		return reply(res, 200, resourceMetadata("/sn"));
	}
	const endpoint = ENDPOINTS[pathname];
	if (!endpoint) {
		return reply(res, 404, { error: "not_found" });
	}
	// Stateless: no sessions to resume or close, so only POST means anything.
	if (req.method !== "POST") {
		return reply(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
	}

	const apiKey = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
	if (!apiKey) {
		return unauthorized(res, endpoint.metadataUrl, "Connect your Scrupp account, or send a Scrupp API key as Authorization: Bearer <key>.");
	}
	if (!(await tokenIsValid(apiKey))) {
		return unauthorized(res, endpoint.metadataUrl, "The Scrupp token is expired or revoked.", "invalid_token");
	}

	let body;
	try {
		body = await readJson(req);
	} catch {
		return reply(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
	}

	const server = createServer({ toolset: endpoint.toolset });
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	res.on("close", () => {
		transport.close();
		server.close();
	});

	try {
		await server.connect(transport);
		await withApiKey(apiKey, () => transport.handleRequest(req, res, body));
	} catch (error) {
		console.error(error);
		if (!res.headersSent) {
			reply(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
		}
	}
});

httpServer.listen(PORT, () => {
	console.error(`Scrupp MCP connector listening on :${PORT}/mcp and :${PORT}/sn`);
});
