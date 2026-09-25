// Talks to the Claude API: batch runs (half price, results within 24h) and live probes.
import Anthropic from "@anthropic-ai/sdk";
import { costUsd, type TokenUsage } from "./pricing.ts";
import { grade, type Category, type Grade, type Question, type QuestionSet } from "./questions/index.ts";

export type Effort = NonNullable<Anthropic.Messages.OutputConfig["effort"]>;

// Every setting is pinned explicitly, so a change in the API's defaults can't look like a nerf.
export type Settings = { model: string; effort: Effort; maxTokens: number };
export const DEFAULT_SETTINGS: Settings = { model: "claude-opus-5", effort: "high", maxTokens: 16000 };

// A guess at average output (thinking included), used only for estimates before a run. Reports show the real number.
const ASSUMED_OUTPUT_TOKENS = 1500;

export type RunMeta = {
  id: string;
  kind: "batch" | "probe";
  createdAt: string;
  settings: Settings;
  questionSetCreatedAt: string;
  questionIds: string[];
  batchId?: string;
  modelName?: string; // from the Models API, e.g. "Claude Opus 5"
  modelReleasedAt?: string; // from the Models API; missing if unknown
};

export type Result = {
  questionId: string;
  category: Category;
  level: number;
  status: "ok" | "error";
  passed: boolean;
  note?: string;
  stopReason?: string | null;
  servedModel?: string; // the model the API says answered, to catch silent swaps
  answer?: string;
  usage?: TokenUsage;
  costUsd: number;
  error?: string;
  latency?: { firstTextSec: number | null; totalSec: number };
};

// No refusal fallbacks on purpose: if another model stepped in, we'd be measuring the wrong model.
// Refusals are recorded as failures, since "it refuses more" is one of the things we track.
export function buildParams(q: Question, set: QuestionSet, settings: Settings): Anthropic.MessageCreateParamsNonStreaming {
  const content: Anthropic.TextBlockParam[] = [];
  if (q.documentId) {
    content.push({ type: "text", text: set.documents[q.documentId], cache_control: { type: "ephemeral" } });
  }
  content.push({ type: "text", text: q.prompt });

  return {
    model: settings.model,
    max_tokens: settings.maxTokens,
    thinking: { type: "adaptive" },
    output_config: { effort: settings.effort },
    messages: [{ role: "user", content }],
  };
}

export function estimateCost(set: QuestionSet, questions: Question[], settings: Settings, batch: boolean) {
  let expected = 0;
  let worstCase = 0;
  for (const q of questions) {
    const chars = q.prompt.length + (q.documentId ? set.documents[q.documentId].length : 0);
    const usage = { input: Math.ceil(chars / 4), cacheWrite: 0, cacheRead: 0, thinking: 0 };
    expected += costUsd(settings.model, { ...usage, output: ASSUMED_OUTPUT_TOKENS }, batch);
    worstCase += costUsd(settings.model, { ...usage, output: settings.maxTokens }, batch);
  }
  return { expected, worstCase, assumedOutputTokens: ASSUMED_OUTPUT_TOKENS };
}

function toResult(q: Question, message: Anthropic.Message, model: string, batch: boolean): Result {
  const answer = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const usage: TokenUsage = {
    input: message.usage.input_tokens,
    cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
    cacheRead: message.usage.cache_read_input_tokens ?? 0,
    output: message.usage.output_tokens,
    thinking: message.usage.output_tokens_details?.thinking_tokens ?? 0,
  };

  let g: Grade;
  if (message.stop_reason === "refusal") g = { passed: false, note: "refused" };
  else if (message.stop_reason !== "end_turn") g = { passed: false, note: `stopped early (${message.stop_reason})` };
  else g = grade(q, answer);

  return {
    questionId: q.id,
    category: q.category,
    level: q.level,
    status: "ok",
    passed: g.passed,
    note: g.note,
    stopReason: message.stop_reason,
    servedModel: message.model,
    answer,
    usage,
    costUsd: costUsd(model, usage, batch),
  };
}

function errorResult(q: Question, error: string): Result {
  return { questionId: q.id, category: q.category, level: q.level, status: "error", passed: false, costUsd: 0, error };
}

// Free call. Also fails early, before any spend, if the model id is wrong.
export async function fetchModelInfo(client: Anthropic, model: string) {
  const info = await client.models.retrieve(model);
  return {
    modelName: info.display_name,
    modelReleasedAt: new Date(info.created_at).getTime() > 0 ? info.created_at : undefined, // epoch means unknown
  };
}

export async function submitBatch(client: Anthropic, set: QuestionSet, questions: Question[], settings: Settings) {
  const batch = await client.messages.batches.create({
    requests: questions.map((q) => ({ custom_id: q.id, params: buildParams(q, set, settings) })),
  });
  return batch.id;
}

export async function collectBatch(client: Anthropic, run: RunMeta, set: QuestionSet) {
  const batch = await client.messages.batches.retrieve(run.batchId!);
  if (batch.processing_status !== "ended") return { done: false as const, counts: batch.request_counts };

  const byId = new Map(set.questions.map((q) => [q.id, q]));
  const results: Result[] = [];
  // Results arrive in any order, so match them by id.
  for await (const item of await client.messages.batches.results(run.batchId!)) {
    const q = byId.get(item.custom_id);
    if (!q) continue;
    if (item.result.type === "succeeded") {
      results.push(toResult(q, item.result.message, run.settings.model, true));
    } else if (item.result.type === "errored") {
      results.push(errorResult(q, JSON.stringify(item.result.error)));
    } else {
      results.push(errorResult(q, item.result.type)); // canceled or expired
    }
  }
  return { done: true as const, results };
}

export async function runLive(client: Anthropic, q: Question, set: QuestionSet, settings: Settings): Promise<Result> {
  const started = performance.now();
  let firstText: number | null = null;
  try {
    const stream = client.messages.stream(buildParams(q, set, settings));
    stream.on("text", () => {
      firstText ??= performance.now();
    });
    const message = await stream.finalMessage();
    const seconds = (t: number) => Math.round(t - started) / 1000;
    return {
      ...toResult(q, message, settings.model, false),
      latency: { firstTextSec: firstText === null ? null : seconds(firstText), totalSec: seconds(performance.now()) },
    };
  } catch (error) {
    if (error instanceof Anthropic.APIError) return errorResult(q, `${error.status ?? ""} ${error.message}`.trim());
    throw error;
  }
}
