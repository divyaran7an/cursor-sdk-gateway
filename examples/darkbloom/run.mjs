import readline from "node:readline/promises"
import { configureCursorGateway } from "cursor-sdk-gateway"
import { startDarkbloomBridge } from "./bridge.mjs"

// Drop the noisy NODE_TLS_REJECT_UNAUTHORIZED warning emitted by the stack;
// let other warnings through.
const passThroughWarnings = process.listeners("warning")
process.removeAllListeners("warning")
process.on("warning", (warning) => {
  if (warning?.message?.includes("NODE_TLS_REJECT_UNAUTHORIZED")) return
  for (const handler of passThroughWarnings) handler(warning)
})

const modelId = process.env.CURSOR_MODEL ?? "qwen3.5-27b-claude-opus-8bit"

const bridge = await startDarkbloomBridge({ apiKey: process.env.DARKBLOOM_API_KEY })

const gateway = await configureCursorGateway({
  provider: "openai-compatible",
  baseURL: bridge.url,
  apiKey: "darkbloom-via-bridge",
})

const { Agent } = await import("@cursor/sdk")

const agent = await Agent.create({
  model: { id: modelId },
  local: { cwd: process.cwd() },
})

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  rl.close()
  await agent[Symbol.asyncDispose]().catch(() => {})
  await gateway.close().catch(() => {})
  await bridge.close().catch(() => {})
}
process.on("SIGINT", async () => {
  await shutdown()
  process.exit(0)
})

console.log(`chat with darkbloom · model: ${modelId}`)
console.log(`type 'exit' or hit ctrl-c to quit\n`)

while (true) {
  let line
  try {
    line = await rl.question("you: ")
  } catch {
    break
  }
  const message = (line ?? "").trim()
  if (!message) continue
  const lower = message.toLowerCase()
  if (lower === "exit" || lower === "quit") break

  process.stdout.write("ai:  ")
  try {
    const run = await agent.send(message)
    await streamReply(run)
  } catch (error) {
    console.error(`(error: ${error?.message ?? error})`)
  }
}

await shutdown()

async function streamReply(run) {
  let started = false
  const dotTick = setInterval(() => {
    if (!started) process.stdout.write(".")
  }, 1500)

  try {
    for await (const event of run.stream()) {
      if (event.type !== "assistant") continue
      for (const block of event.message.content) {
        if (block.type !== "text") continue
        if (!started) {
          started = true
          process.stdout.write(" ")
        }
        process.stdout.write(block.text)
      }
    }
  } finally {
    clearInterval(dotTick)
    process.stdout.write("\n")
  }
}
