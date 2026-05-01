import { configureCursorGateway } from "cursor-sdk-gateway"

export async function configureGatewayFromEnv() {
  if (process.env.OPENAI_COMPATIBLE_BASE_URL) {
    return configureCursorGateway({
      provider: "openai-compatible",
      baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL,
      apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "local-key",
      ...imageConfigFromEnv(),
    })
  }

  return configureCursorGateway({
    provider: "ai-gateway",
    apiKey: process.env.AI_GATEWAY_API_KEY,
    ...imageConfigFromEnv(),
  })
}

export function modelId(fallback = "deepseek/deepseek-v4-flash") {
  return process.env.CURSOR_MODEL ?? fallback
}

function imageConfigFromEnv() {
  if (!process.env.CURSOR_IMAGE_MODEL) return {}
  return {
    image: {
      model: process.env.CURSOR_IMAGE_MODEL,
      ...(process.env.CURSOR_IMAGE_SIZE ? { size: process.env.CURSOR_IMAGE_SIZE } : {}),
    },
  }
}

export async function printAssistantStream(run) {
  for await (const event of run.stream()) {
    if (event.type !== "assistant") continue
    for (const block of event.message.content) {
      if (block.type === "text") process.stdout.write(block.text)
    }
  }
  process.stdout.write("\n")
}
