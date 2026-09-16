# Adapters

Minimal examples that load `@gnopulse/mcp` through each framework's own MCP client.
Each starts the server with `npx -y @gnopulse/mcp` over stdio.

| Framework | File |
|---|---|
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
