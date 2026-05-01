# Resume generator

This demo is **adapted from Claude's official Agent SDK example**:
[`anthropics/claude-agent-sdk-demos/resume-generator`](https://github.com/anthropics/claude-agent-sdk-demos/tree/main/resume-generator).

It shows how the same idea of researching a person and producing a `.docx` resume works through `@cursor/sdk` local agents, with `cursor-sdk-gateway` swapping only the model route.

## What changes from the Claude version

| Claude Agent SDK | Cursor SDK + cursor-sdk-gateway |
|---|---|
| `query()` from `@anthropic-ai/claude-agent-sdk` | `Agent.create()` from `@cursor/sdk` |
| Direct Anthropic API | Cursor SDK local executor + AI Gateway / OpenAI-compatible model |
| `WebSearch`, `WebFetch`, `Bash`, `Write`, `Read`, `Glob` tools | Cursor public local tools: `fetch`, `shell`, `write`, `read`, `glob` |
| `model: 'sonnet'` | Any provider model id (default: `deepseek/deepseek-v4-flash`) |

Web search is not a public Cursor SDK tool. This version uses `fetch` for explicit source URLs and otherwise relies on the model's parametric knowledge. To get LinkedIn-style research, run the demo with URLs:

```bash
node examples/resume-generator/run.mjs "Linus Torvalds" \
  https://en.wikipedia.org/wiki/Linus_Torvalds
```

## Run it

Install:

```bash
npm install cursor-sdk-gateway @cursor/sdk
```

Set a provider:

```bash
export AI_GATEWAY_API_KEY="vck_..."
# or
export OPENAI_COMPATIBLE_BASE_URL="https://openrouter.ai/api/v1"
export OPENAI_COMPATIBLE_API_KEY="..."

export CURSOR_MODEL="deepseek/deepseek-v4-flash"
```

Generate a resume:

```bash
node examples/resume-generator/run.mjs "Person Name"
```

## Output

```
agent/custom_scripts/generate_resume.js
agent/custom_scripts/resume.docx
```

The runner verifies that `resume.docx` exists and that the file's first bytes are a valid Office Open XML (zip) header.

## Credit

This is a port of one of Anthropic's [Claude Agent SDK demos](https://github.com/anthropics/claude-agent-sdk-demos). Same demo, swapped to use `@cursor/sdk` and `cursor-sdk-gateway` so you can run it with any model.
