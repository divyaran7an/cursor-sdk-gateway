# Subagents

Defines a named subagent inline, then asks the parent agent to delegate a small file-write task to it.

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
node examples/subagents/run.mjs
```

## Output

A file at `demo-output/subagent.txt`.
