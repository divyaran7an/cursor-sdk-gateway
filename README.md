# Cursor SDK Gateway

[![npm version](https://img.shields.io/npm/v/cursor-sdk-gateway.svg)](https://www.npmjs.com/package/cursor-sdk-gateway)
[![Downloads](https://img.shields.io/npm/dm/cursor-sdk-gateway.svg)](https://www.npmjs.com/package/cursor-sdk-gateway)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#license)

The Cursor Agent SDK is great, but every request routes through Cursor's backend and needs a Cursor API key. This is a small library that lets you point it at any provider you want, like DeepSeek, Kimi, OpenRouter, Vercel AI Gateway, LiteLLM, vLLM, or any OpenAI-compatible endpoint.

Your code keeps using `@cursor/sdk`, the local executor still runs all the tools the same way, and only the model call goes somewhere else.

```ts
import { configureCursorGateway } from "cursor-sdk-gateway"

await configureCursorGateway({
  provider: "ai-gateway",
  apiKey: process.env.AI_GATEWAY_API_KEY!,
})

const { Agent } = await import("@cursor/sdk")

const agent = await Agent.create({
  model: { id: "deepseek/deepseek-v4-flash" },
  local: { cwd: process.cwd() },
})

const run = await agent.send("Summarize this repository")

for await (const event of run.stream()) {
  console.log(event)
}
```

## Install

```bash
npm install cursor-sdk-gateway @cursor/sdk
```

## Quick start

### 1. Configure once before `@cursor/sdk` is loaded

```ts
import { configureCursorGateway } from "cursor-sdk-gateway"

await configureCursorGateway({
  provider: "ai-gateway",
  apiKey: process.env.AI_GATEWAY_API_KEY!,
})

const { Agent } = await import("@cursor/sdk")
```

### 2. Use Cursor SDK normally

```ts
const agent = await Agent.create({
  model: { id: "deepseek/deepseek-v4-flash" },
  local: { cwd: process.cwd() },
})

const run = await agent.send("Create a README section for local setup")
await run.wait()
```

### 3. Remove it cleanly

Delete the `configureCursorGateway()` call and switch back to a Cursor model id. That's it.

If a file in your project already imports `@cursor/sdk`, put the gateway setup in your entrypoint before that import. The setup has to run first.

## If something doesn't work

- **It still routes through Cursor's models.** Make sure `configureCursorGateway()` runs *before* anything imports `@cursor/sdk`. The dynamic-import pattern in step 1 handles this.
- **`@cursor/sdk` not found.** It's a peer dependency, install it explicitly: `npm install @cursor/sdk`.
- **The provider rejects the request.** The endpoint must support OpenAI-compatible streaming with tool and function calls. Plain chat-only models won't drive the agent loop.

## Vercel AI Gateway

```bash
export AI_GATEWAY_API_KEY="vck_..."
```

```ts
await configureCursorGateway({
  provider: "ai-gateway",
  apiKey: process.env.AI_GATEWAY_API_KEY!,
})
```

Use any provider model id your gateway supports. The examples default to `deepseek/deepseek-v4-flash` because it's cheap.

## OpenAI-compatible endpoints

For OpenRouter, LiteLLM, vLLM, LocalAI, or your own gateway. The endpoint needs to support OpenAI-compatible chat completions with streaming and tool/function calls, since plain chat-only endpoints won't work for Cursor's agent loop.

```ts
await configureCursorGateway({
  provider: "openai-compatible",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY!,
})
```

Local endpoint:

```ts
await configureCursorGateway({
  provider: "openai-compatible",
  baseURL: "http://localhost:4000/v1",
  apiKey: "local-key",
})
```

A few extra provider options pass through too:

- AI Gateway: `baseURL`, `headers`, `metadataCacheRefreshMillis`, `imageModel`, `image`
- OpenAI-compatible: `headers`, `queryParams`, `includeUsage`, `imageModel`, `image`

For image generation:

```ts
await configureCursorGateway({
  provider: "ai-gateway",
  apiKey: process.env.AI_GATEWAY_API_KEY!,
  image: { model: "openai/gpt-image-1", size: "1024x1024" },
})
```

Without an image model, `generateImage` calls return a Cursor-shaped error result. The lifecycle event still fires correctly.

## Migrating an existing Cursor SDK app

Before:

```ts
import { Agent } from "@cursor/sdk"

const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2" },
  local: { cwd: process.cwd() },
})
```

After:

```ts
import { configureCursorGateway } from "cursor-sdk-gateway"

await configureCursorGateway({
  provider: "openai-compatible",
  baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL!,
  apiKey: process.env.OPENAI_COMPATIBLE_API_KEY!,
})

const { Agent } = await import("@cursor/sdk")

const agent = await Agent.create({
  model: { id: "deepseek/deepseek-v4-flash" },
  local: { cwd: process.cwd() },
})
```

Existing code that passes `apiKey: process.env.CURSOR_API_KEY` keeps working. For local gateway runs the gateway supplies the placeholder Cursor key the SDK expects.

## Features

- Use any provider you already have a key for, including Vercel AI Gateway, OpenRouter, LiteLLM, vLLM, LocalAI, or any OpenAI-compatible endpoint.
- Drop into any existing `@cursor/sdk` app with one config call before the SDK import.
- All Cursor local file and shell tools keep working: `write`, `edit`, `read`, `ls`, `grep`, `glob`, `delete`, `shell`.
- MCP servers, project hooks, subagents, and background shell with `write_shell_stdin` all run as normal.
- Optional image generation by passing an image model in the config.
- `npm test` runs an offline parity check against every public Cursor tool, no API key needed.

## Scope

Local agents only.

This doesn't replace Cursor's cloud features like VMs, hosted artifacts, the web Agents Window, or PR automation. For those, use Cursor's own runtime. `agent.listArtifacts()` returns an empty list in local mode, matching Cursor's own local SDK.

## Examples

Runnable examples live in [`examples/`](./examples). Each one is a normal `@cursor/sdk` local agent script:

```bash
node examples/basic/run.mjs
node examples/local-tools/run.mjs
node examples/mcp/run.mjs
node examples/hooks/run.mjs
node examples/subagents/run.mjs
node examples/background-shell/run.mjs
node examples/resume-generator/run.mjs "Person Name"
node examples/cursor-cookbook/quickstart/run.mjs
```

`resume-generator` is adapted from Anthropic's [Claude Agent SDK demos](https://github.com/anthropics/claude-agent-sdk-demos/tree/main/resume-generator), with the same workflow swapped to `@cursor/sdk` and `cursor-sdk-gateway`. The `cursor-cookbook/` folder ports a few of [Cursor's own cookbook examples](https://github.com/cursor/cookbook/tree/main/sdk) the same way.

See [`examples/README.md`](./examples/README.md) for setup and a one-line summary of each.

## How it works

`configureCursorGateway()` starts a local endpoint that speaks Cursor SDK's protocol, points `@cursor/sdk` at it via `CURSOR_BACKEND_URL`, and lets Cursor's own local executor keep handling files, shell, MCP, subagents, and hooks. Only the model call is rerouted.

```txt
@cursor/sdk local agent
  -> cursor-sdk-gateway local endpoint
  -> Cursor local executor (files, shell, MCP, subagents)
  -> gateway hook runner (.cursor/hooks.json)
  -> Vercel AI SDK streamText
  -> Vercel AI Gateway or @ai-sdk/openai-compatible
```

Stack:

- `@cursor/sdk` for the public API your app imports
- `ai` for streaming via `streamText` and Vercel AI Gateway
- `@ai-sdk/openai-compatible` for OpenRouter, LiteLLM, vLLM, LocalAI, and private endpoints
- `zod` for model-facing tool schemas

## References

- Cursor's SDK announcement: https://cursor.com/blog/typescript-sdk
- Cursor SDK docs: https://cursor.com/docs/sdk/typescript
- `@cursor/sdk` on npm: https://www.npmjs.com/package/@cursor/sdk
- Cursor's official cookbook: https://github.com/cursor/cookbook

## Disclaimer

This isn't an official Cursor or Anysphere project, just something I built on top of their SDK.

## License

MIT

Built with [pattrns.ai](https://pattrns.ai) by [@divyaranjan_](https://x.com/divyaranjan_).
