#!/usr/bin/env node
// End-to-end check of the PUBLISHED npm package: starts `npx -y scrupp-mcp-server@latest`
// over stdio and makes real tool calls against the Scrupp API with your key.
// Spends a few credits: 1 email lookup (charged only if found), 1 verification,
// 1 company lookup.
//
//   SCRUPP_API_KEY=sk_live_... node scripts/smoke-npm.mjs
import { spawn } from "node:child_process";

if (!process.env.SCRUPP_API_KEY) {
	console.error("Set SCRUPP_API_KEY first.");
	process.exit(1);
}

const server = spawn("npx", ["-y", "scrupp-mcp-server@latest"], {
	env: { ...process.env, SCRUPP_WAIT_SECONDS: "90" },
	stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map();
server.stdout.on("data", (chunk) => {
	buf += chunk;
	let nl;
	while ((nl = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		if (!line.trim()) continue;
		const msg = JSON.parse(line);
		pending.get(msg.id)?.(msg);
	}
});

let nextId = 1;
function rpc(method, params) {
	const id = nextId++;
	server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
	return new Promise((resolve) => pending.set(id, resolve));
}

async function call(name, args) {
	const started = Date.now();
	const res = await rpc("tools/call", { name, arguments: args });
	const secs = ((Date.now() - started) / 1000).toFixed(1);
	const r = res.result ?? {};
	const text = (r.content ?? []).map((c) => c.text).join("\n");
	// A batch tool can return isError=false while every item failed; count that as a failure.
	let itemErrors = false;
	try {
		const parsed = JSON.parse(text);
		itemErrors = Array.isArray(parsed.results) && parsed.results.length > 0 && parsed.results.every((x) => x.error);
	} catch {}
	const ok = !res.error && !r.isError && !itemErrors;
	console.log(`\n${ok ? "OK  " : "FAIL"} ${name} (${secs}s)`);
	console.log((res.error ? JSON.stringify(res.error) : text).slice(0, 1500));
	return ok;
}

const init = await rpc("initialize", {
	protocolVersion: "2025-06-18",
	capabilities: {},
	clientInfo: { name: "smoke-npm", version: "1" },
});
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
console.log("server:", JSON.stringify(init.result?.serverInfo));
const tools = await rpc("tools/list", {});
console.log("tools:", tools.result?.tools?.length);

const results = [
	await call("scrupp_credits", {}),
	await call("scrupp_find_emails", { people: [{ first_name: "Patrick", last_name: "Collison", domain: "stripe.com" }] }),
	await call("scrupp_verify_emails", { emails: ["support@stripe.com"] }),
	await call("scrupp_lookup_company", { lookup_by: "domain", companies: ["stripe.com"] }),
	await call("scrupp_credits", {}),
];

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} calls OK`);
server.kill();
process.exit(failed ? 1 : 0);
