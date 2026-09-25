import { describe, expect, it } from "vitest";
import { askLive } from "../src/live.ts";
import { generateQuestionSet } from "../src/questions/index.ts";
import { errorResult, type ProviderClient, type Result } from "../src/run.ts";

const set = generateQuestionSet(1);
const questions = set.questions.slice(0, 6);
const settings = { model: "m", effort: "high", maxTokens: 16000 };
const ok = (id: string): Result => ({ questionId: id, category: "code", level: 1, status: "ok", passed: true, costUsd: 0 });

// A provider that turns away the first `limited` calls with a 429.
function provider(limited: number, otherError = false) {
  let calls = 0;
  const client: ProviderClient = {
    fetchModelInfo: async () => ({}),
    runLive: async (q) => {
      calls++;
      if (calls <= limited) return errorResult(q, otherError ? "500 server error" : "429 Rate limit exceeded");
      return ok(q.id);
    },
  };
  return { client, calls: () => calls };
}

describe("live runs", () => {
  it("asks rate-limited questions again after a pause, and keeps the order", async () => {
    const p = provider(4);
    const pauses: number[] = [];
    const results = await askLive(p.client, questions, set, settings, { pauseMs: 0, onPause: (n) => pauses.push(n) });
    expect(results.map((r) => r.questionId)).toEqual(questions.map((q) => q.id));
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(pauses).toEqual([4]);
    expect(p.calls()).toBe(10);
  });

  it("gives up after its retries, and never retries other errors", async () => {
    const stuck = await askLive(provider(1000).client, questions, set, settings, { pauseMs: 0, retries: 2 });
    expect(stuck.every((r) => r.status === "error")).toBe(true);
    const p = provider(3, true);
    const failed = await askLive(p.client, questions, set, settings, { pauseMs: 0 });
    expect(failed.filter((r) => r.status === "error")).toHaveLength(3);
    expect(p.calls()).toBe(6);
  });
});
