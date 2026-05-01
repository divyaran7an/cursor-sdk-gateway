import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { configureGatewayFromEnv, modelId, printAssistantStream } from "../_shared.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const hookPath = resolve(here, "hook.mjs")

await mkdir(".cursor", { recursive: true })
await writeFile(".cursor/hooks.json", JSON.stringify({
  version: 1,
  hooks: {
    preToolUse: [{ matcher: ".*", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hookPath)} pre` }],
    postToolUse: [{ matcher: ".*", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hookPath)} post` }],
    afterFileEdit: [{ matcher: ".*", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hookPath)} afterFileEdit` }],
  },
}, null, 2))

const gateway = await configureGatewayFromEnv()
const { Agent } = await import("@cursor/sdk")

const agent = await Agent.create({
  model: { id: modelId() },
  local: { cwd: process.cwd(), settingSources: ["project"] },
})

const run = await agent.send("Create demo-output/hooked.txt with the text 'hooks ran'.")
await printAssistantStream(run)

await agent[Symbol.asyncDispose]()
await gateway.close()
