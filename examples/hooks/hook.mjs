import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"

const label = process.argv[2] ?? "hook"
let input = ""
process.stdin.setEncoding("utf8")
for await (const chunk of process.stdin) input += chunk

const logPath = resolve("demo-output/hooks.jsonl")
mkdirSync(dirname(logPath), { recursive: true })
appendFileSync(logPath, JSON.stringify({ label, input: input ? JSON.parse(input) : null }) + "\n")
process.stdout.write(JSON.stringify({}) + "\n")
