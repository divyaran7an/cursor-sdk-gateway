export type CursorGatewayConfig =
  | {
      provider?: "ai-gateway"
      runtime?: "local-executor"
      apiKey: string
      baseURL?: string
      headers?: Record<string, string>
      metadataCacheRefreshMillis?: number
      imageModel?: string
      imageSize?: string
      imageAspectRatio?: string
      imageProviderOptions?: Record<string, unknown>
      image?: CursorGatewayImageConfig
    }
  | {
      provider: "openai-compatible"
      runtime?: "local-executor"
      baseURL: string
      apiKey: string
      headers?: Record<string, string>
      queryParams?: Record<string, string>
      includeUsage?: boolean
      imageModel?: string
      imageSize?: string
      imageAspectRatio?: string
      imageProviderOptions?: Record<string, unknown>
      image?: CursorGatewayImageConfig
    }

export type CursorGatewayImageConfig = {
  model: string
  size?: string
  aspectRatio?: string
  providerOptions?: Record<string, unknown>
}

export type CursorGatewayHandle = {
  url: string
  runtime: "local-executor"
  close(): Promise<void>
}

export function configureCursorGateway(config: CursorGatewayConfig): Promise<CursorGatewayHandle>
export function closeCursorGateway(): Promise<void>
