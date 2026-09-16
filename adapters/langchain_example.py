"""GnoPulse MCP tools in a LangGraph agent.

    pip install langchain-mcp-adapters langgraph langchain-anthropic
"""

import asyncio

from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.prebuilt import create_react_agent

GNOPULSE = {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@gnopulse/mcp"],
    "env": {"GNOPULSE_API_KEY": "YOUR_API_KEY"},
}

# Hosted server instead:
# GNOPULSE = {
#     "transport": "streamable_http",
#     "url": "https://mcp.gnopulse.xyz/mcp",
#     "headers": {"X-API-Key": "YOUR_API_KEY"},
# }


async def main() -> None:
    client = MultiServerMCPClient({"gnopulse": GNOPULSE})
    tools = await client.get_tools()
    agent = create_react_agent("anthropic:claude-sonnet-4-5", tools)
    result = await agent.ainvoke({"messages": "What is the current gno.land block height?"})
    print(result["messages"][-1].content)


if __name__ == "__main__":
    asyncio.run(main())
