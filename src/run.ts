// What every provider shares: settings, saved runs and results, grading an answer, cost estimates.
import { costUsd, type TokenUsage } from "./models.ts";
import { grade, type Category, type Grade, type Question, type QuestionSet } from "./questions/index.ts";

// Every setting is pinned explicitly, so a change in the API's defaults can't look like a nerf.
// Effort defaults to low: given more, top models double-check their way to nearly every answer,
// which leaves a score no room to drop (and costs more).
export type Settings = { model: string; effort: string; maxTokens: number };
export const DEFAULT_SETTINGS: Settings = { model: "claude-opus-5", effort: "low", maxTokens: 16000 };

// A guess at average output (thinking included), used only for estimates before a run. Reports show the real number.
const ASSUMED_OUTPUT_TOKENS = 1500;

export type RunMeta = {
  id: string;
  // "batch" is a full run of every question: through the provider's batch API when it has one
  // (then batchId is set), otherwise asked live. "probe" is the small live check.
  kind: "batch" | "probe";
  createdAt: string;
  settings: Settings;
  questionSetCreatedAt: string;
  questionIds: string[];
  batchId?: string;
  modelName?: string; // e.g. "Claude Opus 5"
  modelReleasedAt?: string; // from the provider's models API; missing if unknown
};

export type Result = {
  questionId: string;
  category: Category;
  level: number;
  status: "ok" | "error";
  passed: boolean;
  note?: string;
  stopReason?: string | null; // "end_turn", "refusal", "max_tokens", or the provider's own reason
  servedModel?: string; // the model the API says answered, to catch silent swaps
  answer?: string;
  usage?: TokenUsage;
  costUsd: number;
  error?: string;
  latency?: { firstTextSec: number | null; totalSec: number };
};

// What a provider can do. Providers without a batch API run full runs live.
export type BatchStatus =
  | { done: false; counts: { processing: number; succeeded: number; errored: number } }
  | { done: true; results: Result[] };

export type ProviderClient = {
  fetchModelInfo(model: string): Promise<{ modelName?: string; modelReleasedAt?: string }>;
  runLive(q: Question, set: QuestionSet, settings: Settings): Promise<Result>;
  batch?: {
    submit(set: QuestionSet, questions: Question[], settings: Settings): Promise<string>;
    collect(run: RunMeta, set: QuestionSet): Promise<BatchStatus>;
  };
};

// Refusals and answers cut off early count as failures: "it refuses more" and "it stops short" are nerfs too.
export function answerResult(
  q: Question,
  answer: string,
  stopReason: string | null,
  usage: TokenUsage,
  settings: Settings,
  servedModel: string,
  batch: boolean,
  reportedCostUsd?: number, // when the provider says what it charged, use that instead of our price table
): Result {
  let g: Grade;
  if (stopReason === "refusal") g = { passed: false, note: "refused" };
  else if (stopReason !== "end_turn") g = { passed: false, note: `stopped early (${stopReason})` };
  else g = grade(q, answer);

  return {
    questionId: q.id,
    category: q.category,
    level: q.level,
    status: "ok",
    passed: g.passed,
    note: g.note,
    stopReason,
    servedModel,
    answer,
    usage,
    costUsd: reportedCostUsd ?? costUsd(settings.model, usage, batch),
  };
}

export function errorResult(q: Question, error: string): Result {
  return { questionId: q.id, category: q.category, level: q.level, status: "error", passed: false, costUsd: 0, error };
}

// Times a live answer: when the first text arrived and when it finished.
export function stopwatch() {
  const started = performance.now();
  let firstText: number | null = null;
  const seconds = (t: number) => Math.round(t - started) / 1000;
  return {
    firstText: () => {
      firstText ??= performance.now();
    },
    latency: () => ({ firstTextSec: firstText === null ? null : seconds(firstText), totalSec: seconds(performance.now()) }),
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
