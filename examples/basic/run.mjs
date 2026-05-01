import { configureGatewayFromEnv, modelId, printAssistantStream } from "../_shared.mjs"

const gateway = await configureGatewayFromEnv()
const { Agent } = await import("@cursor/sdk")

const agent = await Agent.create({
  model: { id: modelId() },
  local: { cwd: process.cwd() },
})

const run = await agent.send("Summarize this repository in one short paragraph.")
await printAssistantStream(run)

await agent[Symbol.asyncDispose]()
await gateway.close()
