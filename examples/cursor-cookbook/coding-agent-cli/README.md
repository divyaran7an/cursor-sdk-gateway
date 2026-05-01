# Coding agent CLI (Cursor cookbook port)

A minimal port of [Cursor's coding-agent-cli cookbook example](https://github.com/cursor/cookbook/tree/main/sdk/coding-agent-cli). The original is a full TUI with model selection, cloud mode, and cancellation. This is the small version: an interactive REPL that sends each line to the agent and streams the response.

## Install

```bash
npm install cursor-sdk-gateway @cursor/sdk
```

## Set a provider

```bash
export AI_GATEWAY_API_KEY="vck_..."
export CURSOR_MODEL="deepseek/deepseek-v4-flash"
```

## Run

```bash
node examples/cursor-cookbook/coding-agent-cli/run.mjs
```

Then type prompts at the `you>` prompt. Type `exit` to quit.

## What's different from the original

The original supports cloud mode, model picker, on-the-fly cancel, and a richer TUI. This minimal version focuses on the agent loop so you can see what's actually happening with the cursor-sdk-gateway path.
