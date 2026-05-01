// Port of Cursor's official cookbook quickstart:
// https://github.com/cursor/cookbook/tree/main/sdk/quickstart
//
// The original uses a Cursor model and a Cursor API key. This version routes
// through cursor-sdk-gateway, so any model the Vercel AI Gateway or an
// OpenAI-compatible endpoint supports works instead.

import { configureCursorGateway } from "cursor-sdk-gateway"

const gateway = await configureCursorGateway({
  provider: "ai-gateway",
  apiKey: process.env.AI_GATEWAY_API_KEY,
})

const { Agent } = await import("@cursor/sdk")

const agent = await Agent.create({
  name: "SDK quickstart",
  model: { id: process.env.CURSOR_MODEL ?? "deepseek/deepseek-v4-flash" },
  local: { cwd: process.cwd() },
})

const prompt = "Explain this project in one paragraph."
const run = await agent.send(prompt)

for await (const event of run.stream()) {
  if (event.type !== "assistant") continue

  for (const block of event.message.content) {
    if (block.type === "text") {
      process.stdout.write(block.text)
    }
  }
}

await run.wait()
process.stdout.write("\n")

await agent[Symbol.asyncDispose]()
await gateway.close()
