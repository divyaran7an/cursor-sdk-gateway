# Local tools

Asks the agent to use workspace tools: write a file, read it back, list a directory, run a shell command.

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
node examples/local-tools/run.mjs
```

## Output

A file at `demo-output/local-tools.txt`.
