import { configureGatewayFromEnv, modelId, printAssistantStream } from "../_shared.mjs"

const gateway = await configureGatewayFromEnv()
const { Agent } = await import("@cursor/sdk")

const agent = await Agent.create({
  model: { id: modelId() },
  local: { cwd: process.cwd() },
})

const run = await agent.send([
  "Start a background shell that waits for stdin and writes it to demo-output/background-stdin.txt.",
  "Then use the write_shell_stdin tool to send 'hello background shell'.",
].join(" "))

await printAssistantStream(run)
await agent[Symbol.asyncDispose]()
await gateway.close()
