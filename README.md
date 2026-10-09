# Scrupp MCP server

An MCP server over the Scrupp Jobs API, so an agent can pull leads without anyone
writing HTTP calls. Ships as `@scrupp/mcp-server` on npm and as a listing in the MCP
registry; that registry is what a growing number of agent runtimes read when they pick
a tool, which is why this is the channel where the buyer is not a person.

## In Claude (no install)

Add `https://mcp.scrupp.com/sn` as a custom connector in Claude and sign in to Scrupp.
Setup steps, what each tool needs and troubleshooting: https://scrupp.com/docs/api/claude

## Using it

```json
{
  "mcpServers": {
    "scrupp": {
      "command": "npx",
      "args": ["-y", "@scrupp/mcp-server"],
      "env": { "SCRUPP_API_KEY": "sk_live_..." }
    }
  }
}
```

`SCRUPP_WAIT_SECONDS` (default 120) caps how long a tool blocks. A job that outruns it
comes back as `{ status: "running", job_id }` with a note telling the agent to call
`scrupp_get_job` — better than holding a conversation open for twenty minutes on a
2,500-record export.

## Tools

| Tool | What it does |
| --- | --- |
| `scrupp_export_sales_navigator_search` | People out of a Sales Navigator search URL |
| `scrupp_export_linkedin_search` | People out of a LinkedIn people-search URL |
| `scrupp_run_apollo_search` | People out of an Apollo search URL (needs a connected account) |
| `scrupp_enrich_linkedin_profiles` | Full profile data for profile URLs |
| `scrupp_lookup_company` | Company data by domain, LinkedIn URL or name |
| `scrupp_find_decision_makers` | Who to write to at a company |
| `scrupp_find_emails` | Verified work emails from name + domain |
| `scrupp_verify_emails` | Deliverability check for addresses you already have (1 credit each) |
| `scrupp_get_job` | Status and records for a job that was still running |
| `scrupp_credits` | Remaining credits and plan |

Every tool carries a `title` and `readOnlyHint` / `destructiveHint` annotations — the
Claude connectors directory rejects a server without them.

## Hosted connector (Streamable HTTP)

`node src/http.js` (or `scrupp-mcp-http`) serves the same server over Streamable HTTP
at `POST /mcp`, stateless, with `GET /health` for a load balancer. `PORT` defaults to
8787. Each request authenticates with the caller's own key as
`Authorization: Bearer sk_live_...`; the key is scoped to that request, so one process
serves many accounts without mixing them up.

The hosted connector exposes a **narrower tool set** than the local server: email
finding, email verification, job status and credits. The tools that gather data from
LinkedIn (Sales Navigator, LinkedIn search, profile enrichment) or answer from the
shared lead base (company lookup, decision makers), and the Apollo export, stay
local-only — they run through accounts that are not the caller's, which is not
something to put in a public directory listing.

Try it in Claude Code against a deployed instance:

```bash
claude mcp add --transport http scrupp https://mcp.scrupp.com/mcp \
  --header "Authorization: Bearer sk_live_..."
```

### Private connector with the full API (`/sn`)

`POST /sn` serves a second tool set for Scrupp customers who add it by URL
(Claude.ai: Settings → Connectors → Add custom connector →
`https://mcp.scrupp.com/sn`). It is not listed in the directory and works on
every Scrupp plan. On top of the core tools it has the rest of the API:
`scrupp_build_sales_navigator_search` (audience in words → a Sales Navigator
search URL with the size Sales Navigator reports, no credits),
`scrupp_export_sales_navigator_search`, `scrupp_export_linkedin_search`,
`scrupp_run_apollo_search`, `scrupp_enrich_linkedin_profiles` (optionally with
emails), `scrupp_lookup_company` and `scrupp_find_decision_makers`.

All of them run only on the caller's own accounts connected with the Scrupp
extension. The Scrupp API enforces that, not this server: with this key it
hands out only the caller's own LinkedIn sessions and refuses the job when
there is none.

The OAuth resource is what tells the two apart: the protected-resource metadata
for `/sn` names `https://mcp.scrupp.com/sn`, and app.scrupp.com issues the
private connector's key (`connector:claude-sn`) only for that resource. A key
from the `/mcp` connector gets 403 on everything beyond email finding even if
it is sent to `/sn`.

### Connecting with OAuth

Users of Claude.ai, Claude Desktop and Claude Code don't paste a key: they press
Connect, sign in to Scrupp and allow access. The server advertises its
authorization server at `/.well-known/oauth-protected-resource` (RFC 9728) and answers
an unauthenticated request with `401` and a `WWW-Authenticate` header pointing there.
The authorization server itself lives in the Scrupp app at `app.scrupp.com`
(`/oauth/register`, `/oauth/authorize`, `/oauth/token`); the access token it issues is
an ordinary Scrupp API key marked `connector:claude`, which the API restricts to the
four tools above. Access tokens last an hour, so the server checks the token before
each request (cached for a minute) and answers `401 invalid_token` when it has expired,
which is what makes the client refresh it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `MCP_PUBLIC_URL` | `https://mcp.scrupp.com` | Public URL of this server, used in the metadata |
| `SCRUPP_AUTH_SERVER_URL` | `https://app.scrupp.com` | Where OAuth tokens are issued |
| `SCRUPP_API_URL` | `https://api.scrupp.com/api/v1` | Scrupp API the tools call |

Tool descriptions are written for a model, not a human: they say when to reach for the
tool, not just what it does. That is the whole ranking signal in a registry — a listed
server with vague descriptions gets picked and then misused.

## Publishing

1. Move this directory to its own repo, `Wism-Corp/scrupp-mcp-server` — the MCP registry
   validates ownership from the repository and the `mcpName` in `package.json`.
2. `npm publish --access public` with provenance from GitHub Actions, the same workflow
   shape as `n8n-nodes-scrupp`.
3. Publish the registry entry:
   ```bash
   npx @modelcontextprotocol/publisher login github
   npx @modelcontextprotocol/publisher publish
   ```
   It reads `server.json`, checks the npm package carries the matching `mcpName`, and
   lists the server.
4. Then the downstream directories, which read from the registry or take a form:
   Smithery, Glama, mcp.so, PulseMCP, and Anthropic's connectors directory.

## Testing before publishing

```bash
npm install
SCRUPP_API_KEY=... npx @modelcontextprotocol/inspector node src/index.js
```

Run `scrupp_credits` first (free), then `scrupp_find_emails` with two people — the
cheapest call that exercises create → poll → result.
