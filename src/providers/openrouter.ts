// OpenRouter: one key for models from many companies, through its Chat Completions API,
// which is where OpenRouter documents provider routing and exact per-request cost.
// Models with a ":batch" variant run full runs through OpenRouter's Batch API at half price.
//
// Model ids look like "openrouter/google/gemini-3.1-pro". Add "@<provider>" to pin the company that
// serves it, e.g. "openrouter/google/gemini-3.1-pro@google-vertex": OpenRouter can otherwise switch
// providers between runs, and a different provider can score differently, which would look like a nerf.
import OpenAI from "openai";
import { MODELS, type TokenUsage } from "../models.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { answerResult, errorResult, stopwatch, type BatchStatus, type ProviderClient, type Result, type RunMeta, type Settings } from "../run.ts";

const PREFIX = "openrouter/";
const BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const isOpenRouterModel = (model: string) => model.startsWith(PREFIX);

export function parseModel(model: string): { slug: string; pin?: string } {
  const [slug, pin] = model.slice(PREFIX.length).split("@");
  return { slug, pin: pin || undefined };
}

// The question itself, shared by live and batch requests.
function messageBody(q: Question, set: QuestionSet, settings: Settings) {
  const content: { type: "text"; text: string }[] = [];
  if (q.documentId) content.push({ type: "text", text: set.documents[q.documentId] });
  content.push({ type: "text", text: q.prompt });
  return {
    messages: [{ role: "user", content }],
    max_completion_tokens: settings.maxTokens,
    // "none" means the model doesn't think; the reasoning setting is left out entirely.
    ...(settings.effort === "none" ? {} : { reasoning: { effort: settings.effort } }),
  };
}

// A live request, as OpenRouter's Chat Completions API takes it.
export function buildBody(q: Question, set: QuestionSet, settings: Settings) {
  const { slug, pin } = parseModel(settings.model);
  return {
    model: slug,
    ...messageBody(q, set, settings),
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

type Answer = { text: string; refused: boolean; finish: string | null; model: string; provider: string; usage: Chunk["usage"] };

function answerToResult(q: Question, a: Answer, settings: Settings, batch: boolean): Result {
  const { usage } = a;
  const cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage?.prompt_tokens_details?.cache_write_tokens ?? usage?.cache_write_tokens ?? 0;
  const tokens: TokenUsage = {
    input: Math.max(0, (usage?.prompt_tokens ?? 0) - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    output: usage?.completion_tokens ?? 0,
    thinking: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
  const f = a.finish;
  const stopReason = a.refused || f === "content_filter" ? "refusal" : f === "stop" ? "end_turn" : f === "length" ? "max_tokens" : (f ?? "unknown");
  const served = a.provider ? `${a.model} via ${a.provider}` : a.model;
  // When OpenRouter reports what it charged, that's the cost; otherwise it's priced from its list.
  return answerResult(q, a.text, stopReason, tokens, settings, served, batch, usage?.cost);
}

export function resultFromChunks(q: Question, chunks: Chunk[], settings: Settings): Result {
  const a: Answer = { text: "", refused: false, finish: null, model: "", provider: "", usage: undefined };
  for (const c of chunks) {
    a.model ||= c.model ?? "";
    a.provider ||= c.provider ?? "";
    a.usage = c.usage ?? a.usage;
    for (const choice of c.choices ?? []) {
      a.text += choice.delta?.content ?? "";
      if (choice.delta?.refusal) a.refused = true;
      a.finish = choice.finish_reason ?? a.finish;
    }
  }
  return answerToResult(q, a, settings, false);
}

// --- Batch API: submit every question at once, collect the results later, at half price.

// OpenRouter reads the batch as a stream and needs the settings before "requests",
// so the keys are written in this order on purpose.
export function buildBatch(set: QuestionSet, questions: Question[], settings: Settings) {
  const { slug, pin } = parseModel(settings.model);
  return {
    endpoint: "/v1/chat/completions",
    model: slug,
    ...(pin ? { provider: { only: [pin] } } : {}), // the only routing setting batches accept
    completion_window: "24h",
    requests: questions.map((q) => ({ custom_id: q.id, body: messageBody(q, set, settings) })),
  };
}

export type BatchItem = {
  custom_id: string;
  response?: {
    status_code: number;
    body?: {
      model?: string;
      provider?: string;
      choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }[];
      usage?: Chunk["usage"];
    };
  } | null;
  error?: { message?: string; code?: string | number } | null;
};

export function resultFromBatchItem(q: Question, item: BatchItem, settings: Settings): Result {
  const body = item.response?.body;
  if (item.error || !body || item.response?.status_code !== 200) {
    return errorResult(q, item.error?.message ?? `status ${item.response?.status_code ?? "unknown"}`);
  }
  const choice = body.choices?.[0];
  return answerToResult(
    q,
    {
      text: choice?.message?.content ?? "",
      refused: Boolean(choice?.message?.refusal),
      finish: choice?.finish_reason ?? null,
      model: body.model ?? "",
      provider: body.provider ?? "",
      usage: body.usage,
    },
    settings,
    true,
  );
}

const TERMINAL = ["completed", "failed", "expired", "cancelled"];

export function collectBatchResponse(
  batch: { status: string; request_counts?: { total: number; completed: number; failed: number }; results?: BatchItem[] | null; error?: { message?: string } | null },
  run: RunMeta,
  set: QuestionSet,
): BatchStatus {
  const c = batch.request_counts ?? { total: run.questionIds.length, completed: 0, failed: 0 };
  if (!TERMINAL.includes(batch.status)) {
    return { done: false, counts: { processing: c.total - c.completed - c.failed, succeeded: c.completed, errored: c.failed } };
  }
  const byId = new Map(set.questions.map((q) => [q.id, q]));
  const results = new Map<string, Result>();
  for (const item of batch.results ?? []) {
    const q = byId.get(item.custom_id);
    if (q) results.set(q.id, resultFromBatchItem(q, item, run.settings));
  }
  // A batch that failed, expired or was cancelled has no results; say so for each question.
  const why = batch.error?.message ?? `batch ${batch.status}`;
  for (const id of run.questionIds) {
    const q = byId.get(id);
    if (q && !results.has(id)) results.set(id, errorResult(q, `no result: ${why}`));
  }
  return { done: true, results: [...results.values()] };
}

type Endpoint = { tag?: string; provider_name?: string };

type OpenRouterModel = {
  id: string;
  name?: string;
  created?: number;
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
};

const baseUrl = () => process.env.OPENROUTER_BASE_URL ?? BASE_URL;

async function fetchModelList(): Promise<OpenRouterModel[]> {
  const res = await fetch(`${baseUrl()}/models`);
  if (!res.ok) throw new Error(`Couldn't load OpenRouter's model list (${res.status}).`);
  return ((await res.json()) as { data: OpenRouterModel[] }).data;
}

// Which providers serve a model's ":batch" variant. Endpoint tags look like "anthropic" or "google-vertex/global".
async function batchProviders(slug: string): Promise<string[]> {
  const res = await fetch(`${baseUrl()}/models/${slug}:batch/endpoints`);
  if (!res.ok) return [];
  const endpoints = ((await res.json()) as { data?: { endpoints?: Endpoint[] } }).data?.endpoints ?? [];
  return endpoints.map((e) => (e.tag ?? "").split("/")[0]).filter(Boolean);
}

// Rounded, so "0.000002" per token becomes 2, not 1.9999999999999998.
const perMillion = (perToken: string | undefined) => (perToken ? Number((Number(perToken) * 1_000_000).toFixed(6)) : 0);

// OpenRouter has hundreds of models with changing prices, so they aren't listed in models.ts:
// this adds one from OpenRouter's public model list. Its prices are only used for estimates.
export async function registerOpenRouterModel(model: string): Promise<OpenRouterModel> {
  const { slug, pin } = parseModel(model);
  const list = await fetchModelList();
  const found = list.find((m) => m.id === slug);
  if (!found) throw new Error(`OpenRouter has no model "${slug}". See https://openrouter.ai/models for ids.`);
  // Full runs go through the Batch API when the model has a ":batch" variant (and, if pinned,
  // the pinned provider serves it). Otherwise they're asked live.
  const hasBatch = list.some((m) => m.id === `${slug}:batch`);
  const batch = hasBatch && (!pin || (await batchProviders(slug)).includes(pin.split("/")[0]));
  const p = found.pricing ?? {};
  MODELS[model] = {
    batch,
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
  const client = new OpenAI({ apiKey, baseURL: baseUrl() });

  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...init.headers },
    });
    if (!res.ok) throw new Error(`OpenRouter ${init.method ?? "GET"} ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };

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

    batch: {
      async submit(set, questions, settings) {
        const batch = await api("/batches", { method: "POST", body: JSON.stringify(buildBatch(set, questions, settings)) });
        return batch.id as string;
      },
      async collect(run, set) {
        return collectBatchResponse(await api(`/batches/${run.batchId}`), run, set);
      },
    },
  };
}
