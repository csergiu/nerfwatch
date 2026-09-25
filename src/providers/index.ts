import { modelInfo, type Provider } from "../models.ts";
import type { ProviderClient } from "../run.ts";
import { anthropicProvider } from "./anthropic.ts";
import { RESPONSES_PROVIDERS, responsesProvider } from "./responses.ts";

// Whether full runs for this model go through a batch API (half price) or are asked live.
// Known without an API key, so dry runs can price them.
export function usesBatchApi(model: string): boolean {
  const { provider } = modelInfo(model);
  return provider === "anthropic" || RESPONSES_PROVIDERS[provider].batchApi;
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: RESPONSES_PROVIDERS.openai.label,
  xai: RESPONSES_PROVIDERS.xai.label,
  meta: RESPONSES_PROVIDERS.meta.label,
};

export function providerFor(model: string): ProviderClient {
  const { provider } = modelInfo(model);
  return provider === "anthropic" ? anthropicProvider() : responsesProvider(provider);
}
