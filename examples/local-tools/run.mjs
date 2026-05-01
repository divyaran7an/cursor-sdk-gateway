import { configureGatewayFromEnv, modelId, printAssistantStream } from "../_shared.mjs"

const gateway = await configureGatewayFromEnv()
const { Agent } = await import("@cursor/sdk")

const agent = await Agent.create({
  model: { id: modelId() },
  local: { cwd: process.cwd() },
})

const run = await agent.send([
  "Create demo-output/local-tools.txt with one sentence about Cursor SDK Gateway.",
  "Then read it back, list demo-output, and run a shell command that prints done.",
].join(" "))

await printAssistantStream(run)
await agent[Symbol.asyncDispose]()
await gateway.close()
