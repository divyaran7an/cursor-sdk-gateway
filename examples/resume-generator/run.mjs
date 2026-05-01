// Adapted from the Claude Agent SDK demo:
// https://github.com/anthropics/claude-agent-sdk-demos/tree/main/resume-generator
//
// Original: query() from @anthropic-ai/claude-agent-sdk + WebSearch + Bash + Write tools.
// This port: @cursor/sdk Agent.create() + cursor-sdk-gateway model routing + Cursor's
// local executor for shell/write/read/fetch tools. Web search isn't a public Cursor SDK
// tool, so this version reads optional source URLs via the Cursor `fetch` tool and
// supplements with the model's parametric knowledge.

import { mkdirSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { configureGatewayFromEnv, modelId } from "../_shared.mjs"

const personName = process.argv[2]
if (!personName) {
  console.error('Usage: node examples/resume-generator/run.mjs "Person Name" [source-url ...]')
  process.exit(1)
}
const sourceUrls = process.argv.slice(3)

const cwd = process.cwd()
mkdirSync(join(cwd, "agent", "custom_scripts"), { recursive: true })

const gateway = await configureGatewayFromEnv()
const { Agent } = await import("@cursor/sdk")

const agent = await Agent.create({
  model: { id: modelId() },
  local: { cwd, settingSources: ["project"] },
})

const sourceLine = sourceUrls.length
  ? `Source URLs to fetch first via the fetch tool: ${sourceUrls.join(", ")}.`
  : "No source URLs were provided. Use your parametric knowledge for well-known names; otherwise output a clearly-marked placeholder resume."

const prompt = [
  `You are a professional resume writer. Research "${personName}" and produce a polished 1-page .docx resume.`,
  "",
  "WORKFLOW",
  "1. If source URLs are provided, call the fetch tool on each URL and read the response.",
  "2. Use the read tool to load any files under agent/sources/ if present.",
  "3. Run \"npm install docx --no-save --silent --prefix agent\" via the shell tool.",
  "4. Use the write tool to create agent/custom_scripts/generate_resume.js. The script must import { Document, Packer, Paragraph, TextRun, HeadingLevel } from \"docx\", resolve docx via agent/node_modules, build a Document, and write the result to agent/custom_scripts/resume.docx.",
  "5. Run the script via the shell tool with workingDirectory set to the project root: \"node agent/custom_scripts/generate_resume.js\"",
  "6. List agent/custom_scripts to confirm resume.docx exists.",
  "",
  "PAGE FIT (must be exactly 1 page)",
  "- 0.5 inch margins; Name 24pt; section headers 12pt; body 10pt",
  "- 2-3 bullets per role (~80-100 chars each); max 3 roles",
  "- 2-line summary, 2-line skills",
  "",
  sourceLine,
  "Cover: current role, recent experience (max 3 roles), education, key skills.",
  "Final output must be at agent/custom_scripts/resume.docx.",
].join("\n")

console.log(`\nGenerating resume for: ${personName}\n${"=".repeat(50)}`)

const run = await agent.send(prompt)

for await (const event of run.stream()) {
  if (event.type === "assistant") {
    for (const block of event.message.content) {
      if (block.type === "text") process.stdout.write(block.text)
      if (block.type === "tool_use") {
        const summary =
          block.name === "fetch"
            ? `fetch(${(block.input)?.url ?? ""})`
            : block.name === "shell"
              ? `shell(${truncate((block.input)?.command, 80)})`
              : block.name === "write"
                ? `write(${(block.input)?.path ?? ""})`
                : block.name === "read"
                  ? `read(${(block.input)?.path ?? ""})`
                  : block.name
        process.stdout.write(`\n  -> ${summary}\n`)
      }
    }
  }
  if (event.type === "tool_call" && event.status === "error") {
    console.error(`\n  ! tool error (${event.name}): ${formatError(event.result)}`)
  }
}
process.stdout.write("\n")

const result = await run.wait()
await agent[Symbol.asyncDispose]()
await gateway.close()

const expected = join(cwd, "agent", "custom_scripts", "resume.docx")
if (existsSync(expected)) {
  const head = readFileSync(expected).slice(0, 4)
  const isZip = head[0] === 0x50 && head[1] === 0x4b
  console.log(`\n${"=".repeat(50)}\nResume saved to: ${expected}\nValid Office Open XML: ${isZip ? "yes" : "NO — file is not a docx"}\nRun status: ${result.status}\n${"=".repeat(50)}`)
  if (!isZip) process.exit(1)
} else {
  console.error("\nResume file was not created. Run status:", result.status)
  process.exit(1)
}

function truncate(value, max) {
  const text = String(value ?? "")
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function formatError(value) {
  if (!value) return "unknown"
  if (typeof value === "string") return value
  try { return JSON.stringify(value).slice(0, 200) } catch { return "unprintable" }
}
