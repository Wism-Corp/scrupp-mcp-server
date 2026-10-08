#!/usr/bin/env node
/**
 * The hosted connector: Streamable HTTP, stateless, one server per request.
 *
 * Auth is the caller's own Scrupp API key as a bearer token. That is enough to
 * test it as a custom connector in Claude; the Claude directory listing needs
 * OAuth on top, which comes next.
 */
import { createServer as createHttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { withApiKey } from "./client.js";
import { createServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 8787);
const MAX_BODY_BYTES = 1024 * 1024;

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
	if (pathname !== "/mcp") {
		return reply(res, 404, { error: "not_found" });
	}
	// Stateless: no sessions to resume or close, so only POST means anything.
	if (req.method !== "POST") {
		return reply(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
	}

	const apiKey = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
	if (!apiKey) {
		res.setHeader("WWW-Authenticate", 'Bearer realm="scrupp"');
		return reply(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Send your Scrupp API key as Authorization: Bearer <key>." }, id: null });
	}

	let body;
	try {
		body = await readJson(req);
	} catch {
		return reply(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
	}

	const server = createServer({ toolset: "core" });
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
	console.error(`Scrupp MCP connector listening on :${PORT}/mcp`);
});
