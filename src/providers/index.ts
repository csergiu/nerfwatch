import { modelInfo, type Provider } from "../models.ts";
import type { ProviderClient } from "../run.ts";
import { anthropicProvider } from "./anthropic.ts";
import { openRouterProvider } from "./openrouter.ts";
import { RESPONSES_PROVIDERS, responsesProvider } from "./responses.ts";

// Whether full runs for this model go through a batch API (half price) or are asked live.
// Known without an API key, so dry runs can price them.
export function usesBatchApi(model: string): boolean {
  const { provider } = modelInfo(model);
  if (provider === "openrouter") return modelInfo(model).batch === true; // looked up in OpenRouter's model list
  return provider === "anthropic" || RESPONSES_PROVIDERS[provider].batchApi;
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: RESPONSES_PROVIDERS.openai.label,
  xai: RESPONSES_PROVIDERS.xai.label,
  meta: RESPONSES_PROVIDERS.meta.label,
  openrouter: "OpenRouter",
};

export function providerFor(model: string): ProviderClient {
  const { provider } = modelInfo(model);
  if (provider === "anthropic") return anthropicProvider();
  if (provider === "openrouter") return openRouterProvider();
  return responsesProvider(provider);
}
