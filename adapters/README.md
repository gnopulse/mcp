# Adapters

Minimal examples that load `@gnopulse/mcp` through each framework's own MCP client.
Each starts the server with `npx -y @gnopulse/mcp` over stdio.

| Framework | File |
|---|---|
| Codex | [`codex.toml`](codex.toml) (merge into the private Codex config; local source candidate) |
| Claude Desktop, Claude Code, Cursor | [`claude-cursor.json`](claude-cursor.json) (merge into the client's `mcpServers` config) |
| ElizaOS (`@elizaos/plugin-mcp`) | [`eliza-character.json`](eliza-character.json) |
| LangChain / LangGraph (`langchain-mcp-adapters`) | [`langchain_example.py`](langchain_example.py) |
| OpenAI Agents SDK | [`openai_agents.py`](openai_agents.py) |
| Vercel AI SDK (`@ai-sdk/mcp`) | [`vercel-ai-sdk.ts`](vercel-ai-sdk.ts) |

`GNOPULSE_API_KEY` authenticates the data and analytics tools. See the
[main README](../README.md) for execution settings.

To use the hosted server instead of a local process, connect with the framework's
Streamable HTTP transport to `https://mcp.gnopulse.xyz/mcp` and send the key in an
`X-API-Key` header.

For interactive execution, [trusted-client-approval.mjs](trusted-client-approval.mjs) shows how an authenticated host confirmation callback attaches a transaction-bound signed receipt. It is a host integration example, not an agent tool or automatic ChatGPT/Claude integration. Keep its authorization private key outside model access. MCP elicitation remains available for clients that support it.

Codex supports standard MCP elicitation in its own client interface. The signed-host adapter is optional for custom hosts; do not add an authorization key merely to use Codex. Native elicitation acceptance must still come from the human. A natural-language promise in model output alone is not authorization. The example defaults to unsigned Onyx reads/previews and points to a local source build until the candidate is published.
