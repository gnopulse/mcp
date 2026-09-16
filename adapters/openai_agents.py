"""GnoPulse MCP tools in an OpenAI Agents SDK agent.

    pip install openai-agents
"""

import asyncio

from agents import Agent, Runner
from agents.mcp import MCPServerStdio


async def main() -> None:
    async with MCPServerStdio(
        params={
            "command": "npx",
            "args": ["-y", "@gnopulse/mcp"],
            "env": {"GNOPULSE_API_KEY": "YOUR_API_KEY"},
        },
        cache_tools_list=True,
    ) as gnopulse:
        agent = Agent(
            name="gno-analyst",
            instructions="Answer questions about gno.land using the GnoPulse tools.",
            mcp_servers=[gnopulse],
        )
        result = await Runner.run(agent, "What is the current gno.land block height?")
        print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
