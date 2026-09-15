# Scrupp MCP server

An MCP server over the Scrupp Jobs API, so an agent can pull leads without anyone
writing HTTP calls. Ships as `@scrupp/mcp-server` on npm and as a listing in the MCP
registry; that registry is what a growing number of agent runtimes read when they pick
a tool, which is why this is the channel where the buyer is not a person.

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
| `scrupp_get_job` | Status and records for a job that was still running |
| `scrupp_credits` | Remaining credits and plan |

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
