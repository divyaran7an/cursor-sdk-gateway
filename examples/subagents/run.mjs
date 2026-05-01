import { configureGatewayFromEnv, modelId, printAssistantStream } from "../_shared.mjs"

const gateway = await configureGatewayFromEnv()
const { Agent } = await import("@cursor/sdk")

const agent = await Agent.create({
  model: { id: modelId() },
  local: { cwd: process.cwd() },
  agents: {
    "demo-writer": {
      description: "Use this when a small file should be written by a subagent.",
      prompt: "You are a focused file-writing subagent. Write exactly what was requested.",
      model: "inherit",
    },
  },
})

const run = await agent.send("Use the demo-writer subagent to create demo-output/subagent.txt with one sentence about BYOM for Cursor SDK.")
await printAssistantStream(run)

await agent[Symbol.asyncDispose]()
await gateway.close()
