import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createGateway, generateImage as generateAiImage, stepCountIs, streamText } from "ai"

export function createProviderAdapter(config) {
  if (config.provider === "openai-compatible") return createOpenAICompatibleAdapter(config)
  return createAiGatewayAdapter(config)
}

function createAiGatewayAdapter(config) {
  const gateway = createGateway({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    headers: config.headers,
    ...(config.metadataCacheRefreshMillis !== undefined
      ? { metadataCacheRefreshMillis: config.metadataCacheRefreshMillis }
      : {}),
  })

  return {
    async listModels() {
      const available = await gateway.getAvailableModels()
      return available.models
        .filter((model) => !model.modelType || model.modelType === "language")
        .map((model) => ({
          id: model.id,
          displayName: model.name ?? model.id,
          ...(model.description ? { description: model.description } : {}),
        }))
    },

    async *stream({ modelId, messages, signal, tools }) {
      const result = streamText({
        model: gateway(modelId),
        messages,
        tools,
        stopWhen: stepCountIs(8),
        abortSignal: signal,
        providerOptions: {
          gateway: { tags: ["cursor-sdk-gateway"] },
        },
      })

      for await (const part of result.fullStream) {
        const normalized = normalizeAiSdkPart(part)
        if (normalized) yield normalized
      }
    },

    async generateImage({ prompt, signal }) {
      if (!config.imageModel) throw new Error("No imageModel configured.")
      const result = await generateAiImage({
        model: gateway.image(config.imageModel),
        prompt,
        ...(config.imageSize ? { size: config.imageSize } : {}),
        ...(config.imageAspectRatio ? { aspectRatio: config.imageAspectRatio } : {}),
        ...(config.imageProviderOptions ? { providerOptions: config.imageProviderOptions } : {}),
        abortSignal: signal,
      })
      return normalizeGeneratedImage(result.image)
    },
  }
}

function normalizeAiSdkPart(part) {
  if (part.type === "error") throw toError(part.error)

  if (part.type === "text-delta") {
    const text = part.text ?? part.textDelta ?? ""
    return text ? { type: "text", text } : undefined
  }

  if (part.type === "reasoning-delta" || part.type === "thinking-delta" || part.type === "reasoning") {
    const text = part.text ?? part.textDelta ?? part.delta ?? ""
    return text ? { type: "thinking", text } : undefined
  }

  if (part.type === "tool-call") {
    return {
      type: "tool-call",
      callId: part.toolCallId ?? part.callId ?? part.id ?? "tool-call",
      name: part.toolName ?? part.name ?? "tool",
      args: part.input ?? part.args,
    }
  }

  if (part.type === "tool-result") {
    return {
      type: "tool-result",
      callId: part.toolCallId ?? part.callId ?? part.id ?? "tool-call",
      name: part.toolName ?? part.name ?? "tool",
      result: part.output ?? part.result,
    }
  }

  return undefined
}

function createOpenAICompatibleAdapter(config) {
  const compatible = createOpenAICompatible({
    name: "cursor-sdk-gateway",
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    headers: config.headers,
    ...(config.queryParams ? { queryParams: config.queryParams } : {}),
    ...(config.includeUsage !== undefined ? { includeUsage: config.includeUsage } : {}),
  })

  return {
    async listModels() {
      try {
        const response = await fetch(providerUrl(config, "/models"), {
          headers: providerHeaders(config),
        })
        if (!response.ok) throw new Error(await response.text())
        const body = await response.json()
        const models = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : []
        return models.map((model) => {
          const id = typeof model === "string" ? model : model.id
          return { id, displayName: model.name ?? id }
        }).filter((model) => model.id)
      } catch {
        return [
          { id: "deepseek/deepseek-v4-flash", displayName: "deepseek/deepseek-v4-flash" },
        ]
      }
    },

    async *stream({ modelId, messages, signal, tools }) {
      const result = streamText({
        model: compatible(modelId),
        messages,
        tools,
        stopWhen: stepCountIs(8),
        abortSignal: signal,
      })

      for await (const part of result.fullStream) {
        const normalized = normalizeAiSdkPart(part)
        if (normalized) yield normalized
      }
    },

    async generateImage({ prompt, signal }) {
      if (!config.imageModel) throw new Error("No imageModel configured.")
      const result = await generateAiImage({
        model: compatible.imageModel(config.imageModel),
        prompt,
        ...(config.imageSize ? { size: config.imageSize } : {}),
        ...(config.imageAspectRatio ? { aspectRatio: config.imageAspectRatio } : {}),
        ...(config.imageProviderOptions ? { providerOptions: config.imageProviderOptions } : {}),
        abortSignal: signal,
      })
      return normalizeGeneratedImage(result.image)
    },
  }
}

function normalizeGeneratedImage(image) {
  if (!image) throw new Error("Image provider did not return an image.")
  return {
    base64: image.base64,
    mediaType: image.mediaType ?? "image/png",
  }
}

function providerUrl(config, path) {
  const url = new URL(`${config.baseURL}${path}`)
  if (config.queryParams) {
    for (const [key, value] of Object.entries(config.queryParams)) {
      url.searchParams.set(key, value)
    }
  }
  return url.toString()
}

function providerHeaders(config) {
  return {
    authorization: `Bearer ${config.apiKey}`,
    ...config.headers,
  }
}

function toError(value) {
  if (value instanceof Error) return value
  if (value && typeof value === "object" && "message" in value) return new Error(String(value.message))
  return new Error(String(value))
}
