// Asks questions live, a few at a time. Answers the API turned away for its rate limit (HTTP 429)
// are asked again after a pause, a few times, so a busy minute doesn't cost the run its answers.
import type { Question, QuestionSet } from "./questions/index.ts";
import type { ProviderClient, Result, Settings } from "./run.ts";

type Options = {
  concurrency?: number;
  retries?: number; // extra rounds for rate-limited answers
  pauseMs?: number; // wait before each extra round
  onProgress?: (answered: number, total: number) => void;
  onPause?: (limited: number, pauseMs: number) => void;
};

export const isRateLimited = (r: Result) => r.status === "error" && /^429\b/.test(r.error ?? "");

export async function askLive(provider: ProviderClient, questions: Question[], set: QuestionSet, settings: Settings, options: Options = {}) {
  const { concurrency = 4, retries = 3, pauseMs = 60_000, onProgress, onPause } = options;
  const results = new Map<string, Result>();
  let pending = questions;

  for (let round = 0; ; round++) {
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const q = pending[next++];
        results.set(q.id, await provider.runLive(q, set, settings));
        onProgress?.(results.size, questions.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));

    const limited = pending.filter((q) => isRateLimited(results.get(q.id)!));
    if (!limited.length || round >= retries) break;
    onPause?.(limited.length, pauseMs);
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
    pending = limited;
  }
  return questions.map((q) => results.get(q.id)!);
}
