import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { configureGatewayFromEnv, modelId, printAssistantStream } from "../_shared.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const gateway = await configureGatewayFromEnv()
const { Agent } = await import("@cursor/sdk")
const cwd = process.cwd()

const agent = await Agent.create({
  model: { id: modelId() },
  local: { cwd },
  mcpServers: {
    demo: {
      type: "stdio",
      command: process.execPath,
      args: [resolve(here, "demo-mcp-server.mjs")],
      cwd,
    },
  },
})

const run = await agent.send("Use the demo MCP echo tool with text 'hello from gateway', then tell me the returned text.")
await printAssistantStream(run)

await agent[Symbol.asyncDispose]()
await gateway.close()
