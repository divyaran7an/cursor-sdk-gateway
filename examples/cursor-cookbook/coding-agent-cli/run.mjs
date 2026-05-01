// Minimal port of Cursor's coding-agent-cli cookbook example:
// https://github.com/cursor/cookbook/tree/main/sdk/coding-agent-cli
//
// The original is a full TUI with model selection, cloud mode, and cancellation.
// This is the small version: an interactive prompt loop that sends each line to
// the agent and streams the response. Routed through cursor-sdk-gateway so any
// provider model works.

import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { configureCursorGateway } from "cursor-sdk-gateway"

const gateway = await configureCursorGateway({
  provider: "ai-gateway",
  apiKey: process.env.AI_GATEWAY_API_KEY,
})

const { Agent } = await import("@cursor/sdk")

const agent = await Agent.create({
  name: "coding-agent-cli",
  model: { id: process.env.CURSOR_MODEL ?? "deepseek/deepseek-v4-flash" },
  local: { cwd: process.cwd() },
})

const rl = createInterface({ input: stdin, output: stdout })
console.log("Coding agent ready. Type a prompt, or 'exit' to quit.\n")

while (true) {
  const prompt = (await rl.question("you> ")).trim()
  if (!prompt) continue
  if (prompt === "exit" || prompt === "quit") break

  const run = await agent.send(prompt)
  process.stdout.write("agent> ")

  for await (const event of run.stream()) {
    if (event.type === "assistant") {
      for (const block of event.message.content) {
        if (block.type === "text") process.stdout.write(block.text)
        if (block.type === "tool_use") process.stdout.write(`\n  [${block.name}]\n`)
      }
    }
    if (event.type === "tool_call" && event.status === "completed") {
      process.stdout.write(`  (${event.name} ok)\n`)
    }
  }

  await run.wait()
  process.stdout.write("\n\n")
}

rl.close()
await agent[Symbol.asyncDispose]()
await gateway.close()
