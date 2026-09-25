// OpenRouter: one key for models from many companies, through its Chat Completions API,
// which is where OpenRouter documents provider routing and exact per-request cost.
//
// Model ids look like "openrouter/google/gemini-3.1-pro". Add "@<provider>" to pin the company that
// serves it, e.g. "openrouter/google/gemini-3.1-pro@google-vertex": OpenRouter can otherwise switch
// providers between runs, and a different provider can score differently, which would look like a nerf.
import OpenAI from "openai";
import { MODELS, type TokenUsage } from "../models.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { answerResult, errorResult, stopwatch, type ProviderClient, type Result, type Settings } from "../run.ts";

const PREFIX = "openrouter/";
const BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const isOpenRouterModel = (model: string) => model.startsWith(PREFIX);

export function parseModel(model: string): { slug: string; pin?: string } {
  const [slug, pin] = model.slice(PREFIX.length).split("@");
  return { slug, pin: pin || undefined };
}

// The request, as OpenRouter's Chat Completions API takes it.
export function buildBody(q: Question, set: QuestionSet, settings: Settings) {
  const { slug, pin } = parseModel(settings.model);
  const content: { type: "text"; text: string }[] = [];
  if (q.documentId) content.push({ type: "text", text: set.documents[q.documentId] });
  content.push({ type: "text", text: q.prompt });
  return {
    model: slug,
    messages: [{ role: "user", content }],
    max_completion_tokens: settings.maxTokens,
    // "none" means the model doesn't think; the reasoning setting is left out entirely.
    ...(settings.effort === "none" ? {} : { reasoning: { effort: settings.effort } }),
    provider: {
      data_collection: "deny", // never send the private questions to a provider that may keep or train on them
      require_parameters: true, // skip providers that would ignore the thinking level
      ...(pin ? { order: [pin], allow_fallbacks: false } : {}),
    },
    stream: true,
  };
}

// What OpenRouter reports in a streamed answer. Usage arrives with the last chunk.
type Chunk = {
  model?: string;
  provider?: string;
  choices?: { delta?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    cache_write_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
};

export function resultFromChunks(q: Question, chunks: Chunk[], settings: Settings): Result {
  let text = "";
  let refused = false;
  let finish: string | null = null;
  let model = "";
  let provider = "";
  let usage: Chunk["usage"] = undefined;
  for (const c of chunks) {
    model ||= c.model ?? "";
    provider ||= c.provider ?? "";
    usage = c.usage ?? usage;
    for (const choice of c.choices ?? []) {
      text += choice.delta?.content ?? "";
      if (choice.delta?.refusal) refused = true;
      finish = choice.finish_reason ?? finish;
    }
  }

  const cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage?.prompt_tokens_details?.cache_write_tokens ?? usage?.cache_write_tokens ?? 0;
  const tokens: TokenUsage = {
    input: Math.max(0, (usage?.prompt_tokens ?? 0) - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    output: usage?.completion_tokens ?? 0,
    thinking: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
  const stopReason = refused || finish === "content_filter" ? "refusal" : finish === "stop" ? "end_turn" : finish === "length" ? "max_tokens" : (finish ?? "unknown");
  const served = provider ? `${model} via ${provider}` : model;
  // OpenRouter reports what it charged, so that's the cost, not a price-table estimate.
  return answerResult(q, text, stopReason, tokens, settings, served, false, usage?.cost);
}

type OpenRouterModel = {
  id: string;
  name?: string;
  created?: number;
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
};

async function fetchModelList(): Promise<OpenRouterModel[]> {
  const res = await fetch(`${process.env.OPENROUTER_BASE_URL ?? BASE_URL}/models`);
  if (!res.ok) throw new Error(`Couldn't load OpenRouter's model list (${res.status}).`);
  return ((await res.json()) as { data: OpenRouterModel[] }).data;
}

// Rounded, so "0.000002" per token becomes 2, not 1.9999999999999998.
const perMillion = (perToken: string | undefined) => (perToken ? Number((Number(perToken) * 1_000_000).toFixed(6)) : 0);

// OpenRouter has hundreds of models with changing prices, so they aren't listed in models.ts:
// this adds one from OpenRouter's public model list. Its prices are only used for estimates.
export async function registerOpenRouterModel(model: string): Promise<OpenRouterModel> {
  const { slug } = parseModel(model);
  const found = (await fetchModelList()).find((m) => m.id === slug);
  if (!found) throw new Error(`OpenRouter has no model "${slug}". See https://openrouter.ai/models for ids.`);
  const p = found.pricing ?? {};
  MODELS[model] = {
    provider: "openrouter",
    name: found.name?.replace(/^[^:]+:\s*/, "") ?? slug, // "Google: Gemini 3.1 Pro" → "Gemini 3.1 Pro"
    efforts: OPENROUTER_EFFORTS,
    price: {
      input: perMillion(p.prompt),
      cachedInput: perMillion(p.input_cache_read ?? p.prompt),
      cacheWrite: p.input_cache_write ? perMillion(p.input_cache_write) : undefined,
      output: perMillion(p.completion),
    },
  };
  return found;
}

export function openRouterProvider(): ProviderClient {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Set OPENROUTER_API_KEY in .env to test models through OpenRouter.");
  const client = new OpenAI({ apiKey, baseURL: process.env.OPENROUTER_BASE_URL ?? BASE_URL });

  return {
    async fetchModelInfo(model) {
      const found = await registerOpenRouterModel(model);
      return {
        modelName: MODELS[model].name,
        modelReleasedAt: found.created ? new Date(found.created * 1000).toISOString() : undefined,
      };
    },

    async runLive(q, set, settings) {
      const timer = stopwatch();
      try {
        // The body has OpenRouter's own fields (reasoning, provider), so it's sent as-is.
        const body = buildBody(q, set, settings) as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming;
        const chunks: Chunk[] = [];
        for await (const chunk of await client.chat.completions.create(body)) {
          if ((chunk.choices ?? []).some((c) => c.delta?.content)) timer.firstText();
          chunks.push(chunk as unknown as Chunk);
        }
        return { ...resultFromChunks(q, chunks, settings), latency: timer.latency() };
      } catch (error) {
        if (error instanceof OpenAI.APIError) return errorResult(q, `${error.status ?? ""} ${error.message}`.trim());
        throw error;
      }
    },
  };
}
