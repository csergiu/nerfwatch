// OpenAI, xAI and Meta all serve the Responses API, so one client covers the three.
// Only OpenAI's batch API is used: xAI doesn't document its batch discount or result format
// in enough detail yet, and Meta has none, so their full runs are asked live (both are cheap).
import OpenAI, { toFile } from "openai";
import type { ReasoningEffort } from "openai/resources/shared";
import type { Response, ResponseCreateParamsBase } from "openai/resources/responses/responses";
import type { Provider, TokenUsage } from "../models.ts";
import { MODELS } from "../models.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { answerResult, errorResult, stopwatch, type ProviderClient, type Result, type Settings } from "../run.ts";

type ResponsesProvider = Exclude<Provider, "anthropic" | "openrouter">;

type Config = {
  label: string;
  baseURL?: string; // default: OpenAI's
  apiKeyEnv: string;
  baseURLEnv: string; // lets you point it at a proxy
  batchApi: boolean;
  cacheKey: boolean; // documents support `prompt_cache_key`, which groups requests sharing a long document
};

export const RESPONSES_PROVIDERS: Record<ResponsesProvider, Config> = {
  openai: { label: "OpenAI", apiKeyEnv: "OPENAI_API_KEY", baseURLEnv: "OPENAI_BASE_URL", batchApi: true, cacheKey: true },
  xai: { label: "xAI", baseURL: "https://api.x.ai/v1", apiKeyEnv: "XAI_API_KEY", baseURLEnv: "XAI_BASE_URL", batchApi: false, cacheKey: true },
  meta: { label: "Meta", baseURL: "https://api.meta.ai/v1", apiKeyEnv: "META_API_KEY", baseURLEnv: "META_BASE_URL", batchApi: false, cacheKey: false },
};

// The long document goes first, so every question about it shares the same cacheable prefix.
export function buildParams(q: Question, set: QuestionSet, settings: Settings, config: Config): Omit<ResponseCreateParamsBase, "stream"> {
  const content: { type: "input_text"; text: string }[] = [];
  if (q.documentId) content.push({ type: "input_text", text: set.documents[q.documentId] });
  content.push({ type: "input_text", text: q.prompt });

  return {
    model: settings.model,
    input: [{ role: "user", content }],
    reasoning: { effort: settings.effort as ReasoningEffort }, // checked against the model's list in models.ts
    max_output_tokens: settings.maxTokens,
    ...(config.cacheKey && q.documentId ? { prompt_cache_key: q.documentId } : {}),
  };
}

// Responses report cached tokens and cache writes as part of input_tokens; we count them separately.
export function usageOf(response: Response): TokenUsage {
  const u = response.usage;
  const cacheRead = u?.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u?.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    input: Math.max(0, (u?.input_tokens ?? 0) - cacheRead - cacheWrite),
    cacheWrite,
    cacheRead,
    output: u?.output_tokens ?? 0,
    thinking: u?.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

// Normalized to the stop reasons the rest of NerfWatch uses: end_turn, refusal, max_tokens.
export function toResult(q: Question, response: Response, settings: Settings, batch: boolean): Result {
  if (response.status === "failed") return errorResult(q, response.error?.message ?? "the response failed");

  const texts: string[] = [];
  let refused = false;
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content) {
      if (part.type === "output_text") texts.push(part.text);
      else if (part.type === "refusal") refused = true;
    }
  }

  const reason = response.incomplete_details?.reason;
  const stopReason = refused
    ? "refusal"
    : response.status === "completed"
      ? "end_turn"
      : reason === "max_output_tokens"
        ? "max_tokens"
        : reason === "content_filter"
          ? "refusal"
          : (reason ?? response.status ?? "unknown");

  return answerResult(q, texts.join("\n"), stopReason, usageOf(response), settings, response.model, batch);
}

// One line of an OpenAI batch output or error file.
type BatchLine = {
  custom_id: string;
  response?: { status_code: number; body: Response } | null;
  error?: { code?: string; message?: string } | null;
};

export function responsesProvider(provider: ResponsesProvider): ProviderClient {
  const config = RESPONSES_PROVIDERS[provider];
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) throw new Error(`Set ${config.apiKeyEnv} in .env to test ${config.label} models.`);
  const client = new OpenAI({ apiKey, baseURL: process.env[config.baseURLEnv] ?? config.baseURL });

  const describe = (error: unknown) =>
    error instanceof OpenAI.APIError ? `${error.status ?? ""} ${error.message}`.trim() : undefined;

  const batchApi: ProviderClient["batch"] = {
    async submit(set, questions, settings) {
      const lines = questions.map((q) =>
        JSON.stringify({ custom_id: q.id, method: "POST", url: "/v1/responses", body: buildParams(q, set, settings, config) }),
      );
      const file = await client.files.create({
        file: await toFile(Buffer.from(lines.join("\n") + "\n"), "nerfwatch-batch.jsonl"),
        purpose: "batch",
      });
      const batch = await client.batches.create({ input_file_id: file.id, endpoint: "/v1/responses", completion_window: "24h" });
      return batch.id;
    },

    async collect(run, set) {
      const batch = await client.batches.retrieve(run.batchId!);
      const c = batch.request_counts ?? { total: run.questionIds.length, completed: 0, failed: 0 };
      if (!["completed", "failed", "expired", "cancelled"].includes(batch.status)) {
        return { done: false, counts: { processing: c.total - c.completed - c.failed, succeeded: c.completed, errored: c.failed } };
      }

      const byId = new Map(set.questions.map((q) => [q.id, q]));
      const results = new Map<string, Result>();
      for (const fileId of [batch.output_file_id, batch.error_file_id]) {
        if (!fileId) continue;
        const text = await (await client.files.content(fileId)).text();
        for (const line of text.split("\n").filter(Boolean)) {
          const item: BatchLine = JSON.parse(line);
          const q = byId.get(item.custom_id);
          if (!q) continue;
          results.set(
            q.id,
            item.response?.status_code === 200
              ? toResult(q, item.response.body, run.settings, true)
              : errorResult(q, JSON.stringify(item.error ?? item.response?.body ?? "no response")),
          );
        }
      }

      // A batch that failed validation or expired leaves questions without a line.
      const why = batch.errors?.data?.[0]?.message ?? `batch ${batch.status}`;
      for (const id of run.questionIds) {
        const q = byId.get(id);
        if (q && !results.has(id)) results.set(id, errorResult(q, `no result: ${why}`));
      }
      return { done: true, results: [...results.values()] };
    },
  };

  return {
    // Also fails early, before any spend, if the key can't use the model.
    async fetchModelInfo(model) {
      for await (const m of client.models.list()) {
        if (m.id === model) {
          return { modelName: MODELS[model]?.name, modelReleasedAt: m.created ? new Date(m.created * 1000).toISOString() : undefined };
        }
      }
      throw new Error(`${model} isn't available to your ${config.label} API key.`);
    },

    async runLive(q, set, settings) {
      const timer = stopwatch();
      try {
        const stream = client.responses.stream(buildParams(q, set, settings, config));
        stream.on("response.output_text.delta", timer.firstText);
        const response = await stream.finalResponse();
        return { ...toResult(q, response, settings, false), latency: timer.latency() };
      } catch (error) {
        const message = describe(error);
        if (message) return errorResult(q, message);
        throw error;
      }
    },

    batch: config.batchApi ? batchApi : undefined,
  };
}
