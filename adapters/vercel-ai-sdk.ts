// GnoPulse MCP tools with the Vercel AI SDK.
//
//   npm i ai @ai-sdk/mcp @ai-sdk/anthropic
import { anthropic } from "@ai-sdk/anthropic";
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { generateText, stepCountIs } from "ai";

const mcp = await createMCPClient({
  transport: new Experimental_StdioMCPTransport({
    command: "npx",
    args: ["-y", "@gnopulse/mcp"],
    env: { GNOPULSE_API_KEY: "YOUR_API_KEY" },
  }),
});

try {
  const { text } = await generateText({
    model: anthropic("claude-sonnet-4-5"),
    tools: await mcp.tools(),
    stopWhen: stepCountIs(6),
    prompt: "What is the current gno.land block height?",
  });
  console.log(text);
} finally {
  await mcp.close();
}
