import { configureGatewayFromEnv, modelId, printAssistantStream } from "../_shared.mjs"

const gateway = await configureGatewayFromEnv()
const { Agent } = await import("@cursor/sdk")

const agent = await Agent.create({
  model: { id: modelId() },
  local: { cwd: process.cwd() },
})

const run = await agent.send([
  "You MUST use the `background_shell` tool followed by `write_shell_stdin`. Do not substitute with the regular `shell` tool.",
  "",
  "Step 1. Call `background_shell` with these exact arguments:",
  "  command: sh -c 'mkdir -p demo-output; IFS= read -r line; printf %s \"$line\" > demo-output/background-stdin.txt'",
  "  enableWriteShellStdinTool: true",
  "  description: background stdin demo",
  "",
  "Step 2. Take the shellId returned from step 1 and call `write_shell_stdin` with:",
  "  shellId: <the id from step 1>",
  "  chars: hello background shell\\n",
  "(The trailing newline is required so the read command returns.)",
  "",
  "Step 3. Confirm demo-output/background-stdin.txt now exists. Stop after that.",
].join("\n"))

await printAssistantStream(run)
await agent[Symbol.asyncDispose]()
await gateway.close()
